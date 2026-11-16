// The multi-track timeline, drawn on one canvas. Only what's in view is drawn (clips found through the
// interval index, waveforms read from precomputed peaks), so it stays smooth on long projects.
import type { Clip, MediaClip, Track } from '@mangoai/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TimelineIndex } from '../engine/index';
import type { Player } from '../engine/player';
import { studio, useStudio } from '../store';
import { timecode } from './Transport';

const HEADER = 156;
const RULER = 26;
const SECTIONS = 20;
const TOP = RULER + SECTIONS;
const HEIGHTS: Record<Track['kind'], number> = { video: 46, graphics: 40, captions: 32, audio: 58 };

const COLORS = {
  bg: '#15171c', lane: '#1b1e25', laneAlt: '#191c22', header: '#20232b', grid: '#2a2e38', text: '#d8dbe2', muted: '#8a90a0',
  video: '#3b6ea8', generator: '#454c5e', title: '#7d55c0', comp: '#c9822b', voice: '#2f8f5b', sfx: '#26897d', music: '#6a8a2e', other: '#5a6070',
  playhead: '#ff5a4f', select: '#ffd400', problem: '#ff4d4d', section: '#262a34', sectionAlt: '#2c313d',
};

function clipColor(c: Clip, t: Track): string {
  if (c.type === 'generator') return COLORS.generator;
  if (c.type === 'title') return COLORS.title;
  if (c.type === 'comp') return COLORS.comp;
  if (t.kind === 'audio') return (COLORS as Record<string, string>)[t.role ?? 'other'] ?? COLORS.other;
  return COLORS.video;
}

function clipLabel(c: Clip): string {
  if (c.label) return c.label;
  if (c.type === 'media') return c.src.split(/[\\/]/).pop() ?? c.src;
  if (c.type === 'comp') return c.comp;
  return c.id;
}

/** Tracks top to bottom as an NLE shows them: visual tracks with the top-painted one first, then audio. */
function displayOrder(tracks: Track[]): Track[] {
  const visual = tracks.filter((t) => t.kind !== 'audio').reverse();
  return [...visual, ...tracks.filter((t) => t.kind === 'audio')];
}

export function Timeline({ player }: { player: Player }) {
  const s = useStudio();
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ pps: 0, x0: 0, y0: 0 }); // pixels per second, left time, vertical scroll
  const [size, setSize] = useState({ w: 800, h: 300 });
  const drag = useRef<null | 'scrub'>(null);

  const project = s.opened!.project;
  const resolved = s.resolved()!;
  const index = useMemo(() => new TimelineIndex(project, resolved), [project, resolved]);
  const rows = useMemo(() => {
    let y = 0;
    return displayOrder(project.tracks).map((t) => {
      const h = HEIGHTS[t.kind];
      const row = { track: t, y, h };
      y += h;
      return row;
    });
  }, [project, s.editor?.version]);
  const problemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of resolved.problems) {
      const m = /^tracks\.(\d+)\.clips\.(\d+)/.exec(p.path);
      if (m) {
        const c = project.tracks[Number(m[1])]?.clips[Number(m[2])];
        if (c) ids.add(c.id);
      }
    }
    return ids;
  }, [project, resolved]);

  // size + initial zoom-to-fit
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const fit = () => setView((v) => ({ ...v, pps: Math.max(0.5, (size.w - HEADER - 20) / Math.max(1, index.end)), x0: 0 }));
  useEffect(() => {
    if (view.pps === 0 && size.w > HEADER) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, index.end]);

  // redraw on every player frame (playhead) and on view changes
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => draw());
    };
    const off = player.onChange(paint);
    paint();
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  });

  // keep the playhead in view while playing (page like an NLE)
  useEffect(
    () =>
      player.onChange(() => {
        if (!player.isPlaying || view.pps === 0) return;
        const t = player.time();
        const visible = (size.w - HEADER) / view.pps;
        if (t < view.x0 || t > view.x0 + visible * 0.95) setView((v) => ({ ...v, x0: Math.max(0, t - visible * 0.05) }));
      }),
    [player, view, size.w],
  );

  const tToX = (t: number) => HEADER + (t - view.x0) * view.pps;
  const xToT = (x: number) => view.x0 + (x - HEADER) / view.pps;

  function draw() {
    const canvas = cv.current;
    if (!canvas || view.pps === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.w * dpr || canvas.height !== size.h * dpr) {
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size.w, size.h);
    const t0 = view.x0;
    const t1 = xToT(size.w);
    const fps = project.fps;

    // lanes
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, TOP, size.w, size.h - TOP);
    ctx.clip();
    rows.forEach((row, i) => {
      const y = TOP + row.y - view.y0;
      if (y > size.h || y + row.h < TOP) return;
      ctx.fillStyle = i % 2 ? COLORS.laneAlt : COLORS.lane;
      ctx.fillRect(HEADER, y, size.w - HEADER, row.h);
      drawTrack(ctx, row.track, y, row.h, t0, t1);
      ctx.fillStyle = COLORS.header;
      ctx.fillRect(0, y, HEADER, row.h);
      ctx.fillStyle = COLORS.grid;
      ctx.fillRect(0, y + row.h - 1, size.w, 1);
      ctx.fillStyle = COLORS.text;
      ctx.font = '600 12px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.track.id, 10, y + row.h / 2 - 7);
      ctx.fillStyle = COLORS.muted;
      ctx.font = '11px "Segoe UI", sans-serif';
      const sub = [row.track.name, row.track.kind === 'audio' ? row.track.role : row.track.kind].filter(Boolean).join(' · ');
      ctx.fillText(sub, 10, y + row.h / 2 + 8, HEADER - 16);
    });
    ctx.restore();

    // ruler
    ctx.fillStyle = COLORS.header;
    ctx.fillRect(0, 0, size.w, RULER);
    const step = niceStep(80 / view.pps);
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = tToX(t);
      if (x < HEADER) continue;
      ctx.fillStyle = COLORS.grid;
      ctx.fillRect(x, RULER - 8, 1, 8);
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(step < 1 ? timecode(t, fps) : timecode(t, fps).slice(0, 5), x + 3, RULER / 2 - 2);
    }

    // sections
    resolved.sections.forEach((sec, i) => {
      const x0 = Math.max(HEADER, tToX(sec.t0));
      const x1 = Math.min(size.w, tToX(sec.t1));
      if (x1 <= x0) return;
      ctx.fillStyle = i % 2 ? COLORS.sectionAlt : COLORS.section;
      ctx.fillRect(x0, RULER, x1 - x0, SECTIONS);
      ctx.fillStyle = COLORS.text;
      ctx.font = '11px "Segoe UI", sans-serif';
      if (x1 - x0 > 30) ctx.fillText(sec.id, x0 + 4, RULER + SECTIONS / 2, x1 - x0 - 8);
    });
    ctx.fillStyle = COLORS.header;
    ctx.fillRect(0, 0, HEADER, TOP);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`${(view.pps).toFixed(view.pps < 10 ? 1 : 0)} px/s`, 10, RULER / 2);

    // playhead
    const px = tToX(player.time());
    if (px >= HEADER) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(px - 0.5, 0, 1.5, size.h);
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 8);
      ctx.fill();
    }
  }

  function drawTrack(ctx: CanvasRenderingContext2D, track: Track, y: number, h: number, t0: number, t1: number) {
    if (track.kind === 'captions') return drawWords(ctx, y, h, t0, t1);
    const spans = index.tracks.get(track.id)?.query(t0, t1) ?? [];
    // SFX can overlap (several hits of one sound): stack them in sub-lanes
    const lanes: number[] = [];
    for (const sp of [...spans].sort((a, b) => a.start - b.start)) {
      let lane = lanes.findIndex((end) => end <= sp.start);
      if (lane < 0) lane = lanes.push(0) - 1;
      lanes[lane] = sp.end;
      const sub = Math.max(1, Math.min(3, lanes.length));
      void sub;
      const x0 = tToX(sp.start);
      const x1 = tToX(sp.end);
      const cx0 = Math.max(HEADER, x0);
      const cx1 = Math.min(size.w, x1);
      if (cx1 < cx0) continue;
      const laneH = (h - 6) / Math.max(1, laneCount(spans));
      const top = y + 3 + lane * laneH;
      const c = sp.clip;
      ctx.fillStyle = clipColor(c, track);
      ctx.globalAlpha = c.type === 'generator' ? 0.6 : 0.9;
      roundRect(ctx, x0, top, Math.max(1.5, x1 - x0), laneH - 2, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (track.kind === 'audio' && c.type === 'media') drawWave(ctx, c, sp.start, x0, x1, top, laneH - 2);
      if (problemIds.has(c.id) || s.selection === c.id) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = s.selection === c.id ? COLORS.select : COLORS.problem;
        roundRect(ctx, x0, top, Math.max(1.5, x1 - x0), laneH - 2, 3);
        ctx.stroke();
      }
      if (cx1 - cx0 > 24) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx0, top, cx1 - cx0, laneH);
        ctx.clip();
        ctx.fillStyle = '#fff';
        ctx.font = `${laneH > 26 ? 12 : 10}px "Segoe UI", sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(clipLabel(c), cx0 + 5, top + 3);
        ctx.restore();
      }
    }
  }

  function laneCount(spans: { start: number; end: number }[]): number {
    const ends: number[] = [];
    for (const sp of [...spans].sort((a, b) => a.start - b.start)) {
      const l = ends.findIndex((e) => e <= sp.start);
      if (l < 0) ends.push(sp.end);
      else ends[l] = sp.end;
    }
    return ends.length;
  }

  function drawWave(ctx: CanvasRenderingContext2D, c: MediaClip, start: number, x0: number, x1: number, top: number, h: number) {
    const pk = studio.peaks.get(c.src);
    if (!pk) return;
    const r = resolved.clips.get(c.id);
    const inPt = r?.in ?? 0;
    const speed = r?.speed ?? 1;
    const n = pk.data.length / 2;
    const mid = top + h / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const from = Math.max(HEADER, Math.floor(x0));
    const to = Math.min(size.w, Math.ceil(x1));
    for (let x = from; x < to; x++) {
      let a = (inPt + (xToT(x) - start) * speed) * pk.rate;
      let b = (inPt + (xToT(x + 1) - start) * speed) * pk.rate;
      if (c.loop && n > 0) {
        a %= n;
        b = a + (b - Math.floor(b) + 1);
      }
      let mn = 0;
      let mx = 0;
      for (let i = Math.floor(a); i < Math.max(Math.floor(a) + 1, Math.ceil(b)) && i < n; i++) {
        if (i < 0) continue;
        mn = Math.min(mn, pk.data[i * 2]!);
        mx = Math.max(mx, pk.data[i * 2 + 1]!);
      }
      const y0 = mid - (mx / 127) * (h / 2);
      const y1 = mid - (mn / 127) * (h / 2);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  function drawWords(ctx: CanvasRenderingContext2D, y: number, h: number, t0: number, t1: number) {
    const words = s.opened?.words;
    if (!words) return;
    // binary search the first word in view
    let lo = 0;
    let hi = words.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (words[m]!.e < t0) lo = m + 1;
      else hi = m;
    }
    const detailed = view.pps >= 40;
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = lo; i < words.length && words[i]!.s <= t1; i++) {
      const w = words[i]!;
      const x0 = tToX(w.s);
      const x1 = tToX(w.e);
      ctx.fillStyle = 'rgba(255,212,0,0.22)';
      ctx.fillRect(Math.max(HEADER, x0), y + 4, Math.max(1, x1 - x0 - 1), h - 8);
      if (detailed && x1 - x0 > 14) {
        ctx.fillStyle = COLORS.text;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, x1 - x0 + 30, h);
        ctx.clip();
        ctx.fillText(w.w, x0 + 2, y + h / 2);
        ctx.restore();
      }
    }
  }

  // --- input -------------------------------------------------------------------------------------
  function hit(x: number, y: number): { clip?: Clip; t: number } {
    const t = xToT(x);
    if (y < TOP) return { t };
    const yy = y - TOP + view.y0;
    const row = rows.find((r) => yy >= r.y && yy < r.y + r.h);
    if (!row || row.track.kind === 'captions') return { t };
    const spans = index.tracks.get(row.track.id)?.at(t) ?? [];
    const near = spans.length ? spans : index.tracks.get(row.track.id)?.query(t - 4 / view.pps, t + 4 / view.pps) ?? [];
    return near.length ? { clip: near[near.length - 1]!.clip, t } : { t };
  }

  const onDown = (e: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < HEADER) return;
    const h = hit(x, y);
    if (h.clip && y >= TOP) {
      studio.select(h.clip.id);
      return;
    }
    drag.current = 'scrub';
    player.seek(h.t);
    const move = (ev: MouseEvent) => {
      if (drag.current === 'scrub') player.seek(xToT(ev.clientX - r.left));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onDouble = (e: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const h = hit(e.clientX - r.left, e.clientY - r.top);
    if (h.clip) {
      const rc = resolved.clips.get(h.clip.id);
      if (rc) player.seek(rc.start);
    }
  };

  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (e.ctrlKey || e.metaKey) {
        const at = xToT(Math.max(HEADER, x));
        const pps = Math.min(2000, Math.max(0.05, view.pps * Math.exp(-e.deltaY * 0.0015)));
        setView((v) => ({ ...v, pps, x0: Math.max(0, at - (Math.max(HEADER, x) - HEADER) / pps) }));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.deltaX || e.deltaY) / view.pps;
        setView((v) => ({ ...v, x0: Math.max(0, v.x0 + d) }));
      } else {
        const total = rows.reduce((n, r2) => n + r2.h, 0);
        const max = Math.max(0, total - (size.h - TOP));
        if (max > 0) setView((v) => ({ ...v, y0: Math.min(max, Math.max(0, v.y0 + e.deltaY)) }));
        else setView((v) => ({ ...v, x0: Math.max(0, v.x0 + e.deltaY / v.pps) }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  return (
    <section className="timeline">
      <div className="timeline-bar">
        <span>Timeline</span>
        <button className="ghost" onClick={fit} title="Fit the whole timeline">Fit</button>
        <button className="ghost" onClick={() => setView((v) => ({ ...v, pps: v.pps * 1.5 }))}>＋</button>
        <button className="ghost" onClick={() => setView((v) => ({ ...v, pps: v.pps / 1.5 }))}>－</button>
        <span className="muted small">Ctrl+wheel zoom · wheel scroll · click clip to inspect · click ruler/empty to seek</span>
      </div>
      <div className="timeline-canvas" ref={wrap}>
        <canvas ref={cv} style={{ width: size.w, height: size.h }} onMouseDown={onDown} onDoubleClick={onDouble} />
      </div>
    </section>
  );
}

function niceStep(raw: number): number {
  const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  return steps.find((s) => s >= raw) ?? 3600;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
