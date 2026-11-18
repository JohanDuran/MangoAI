// The multi-track timeline, drawn on one canvas. Only what's in view is drawn (clips found through the
// interval index, waveforms read from precomputed peaks), so it stays smooth on long projects.
// Editing: drag a clip to move it (also onto another track of the same kind), drag an edge to trim, with
// snapping to the playhead, clip edges, sections, anchors and words (hold Alt to not snap). Snapping a clip's
// start onto a word, anchor or section links it there, so it follows if the voice is re-recorded.
import { clipAllowedOn, moveClips, shiftExpr, trimClip, type Clip, type MediaClip, type Op, type Track } from '@mangoai/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TimelineIndex } from '../engine/index';
import type { Player } from '../engine/player';
import { studio, useStudio } from '../store';
import { timecode } from './Transport';

const HEADER = 156;
const RULER = 26;
const SECTIONS = 20;
const CACHE = 4;
const TOP = RULER + SECTIONS + CACHE;
const HEIGHTS: Record<Track['kind'], number> = { video: 46, graphics: 40, captions: 32, audio: 58 };
const EDGE = 6; // px from a clip edge that grabs a trim instead of a move
const SNAP_PX = 8;

const COLORS = {
  bg: '#15171c', lane: '#1b1e25', laneAlt: '#191c22', header: '#20232b', grid: '#2a2e38', text: '#d8dbe2', muted: '#8a90a0',
  video: '#3b6ea8', generator: '#454c5e', title: '#7d55c0', comp: '#c9822b', voice: '#2f8f5b', sfx: '#26897d', music: '#6a8a2e', other: '#5a6070',
  playhead: '#ff5a4f', select: '#ffd400', problem: '#ff4d4d', section: '#262a34', sectionAlt: '#2c313d', snap: '#ffd400',
  anchor: '#3ddc84', request: '#ffb347', range: 'rgba(80,160,240,0.16)', locked: 'rgba(0,0,0,0.35)',
  cached: '#2f8f5b', stale: '#5a6070',
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
  if (c.type === 'title') return c.text ?? c.runs?.map((r) => r[0]).join('') ?? c.id;
  return c.id;
}

/** Tracks top to bottom as an NLE shows them: visual tracks with the top-painted one first, then audio. */
function displayOrder(tracks: Track[]): Track[] {
  const visual = tracks.filter((t) => t.kind !== 'audio').reverse();
  return [...visual, ...tracks.filter((t) => t.kind === 'audio')];
}

interface Snap {
  t: number;
  label: string;
  /** Link to this expression when a clip's start lands on it (words, anchors, sections). */
  expr?: string;
}

type ClipDrag = {
  kind: 'move' | 'trimStart' | 'trimEnd';
  ids: string[];
  primary: string;
  x0: number;
  started: boolean;
  dt: number;
  snap: Snap | null;
  target: string | null;
  snaps: Snap[];
};

type Drag = { kind: 'scrub' } | { kind: 'range'; from: number } | { kind: 'anchor'; name: string; dt: number; x0: number } | ClipDrag;

interface Row {
  track: Track;
  y: number;
  h: number;
}

/** Header toggle buttons, right-aligned: [label, field, which tracks have it]. */
const TOGGLES: [string, 'muted' | 'hidden' | 'locked', (t: Track) => boolean][] = [
  ['L', 'locked', (t) => t.kind !== 'captions'],
  ['M', 'muted', (t) => t.kind === 'audio'],
  ['H', 'hidden', (t) => t.kind !== 'audio'],
];

export function Timeline({ player }: { player: Player }) {
  const s = useStudio();
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ pps: 0, x0: 0, y0: 0 }); // pixels per second, left time, vertical scroll
  const [size, setSize] = useState({ w: 800, h: 300 });
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<string>('default');
  // hover help for what's drawn on the canvas: shown after a short pause on the same thing
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tipWait = useRef<{ text: string; timer: number } | null>(null);
  useEffect(() => () => clearTimeout(tipWait.current?.timer), []);

  const project = s.editor!.project;
  const resolved = s.resolved()!;
  const version = s.editor?.version ?? 0;
  const index = useMemo(() => new TimelineIndex(project, resolved), [project, resolved]);
  const rows: Row[] = useMemo(() => {
    let y = 0;
    return displayOrder(project.tracks).map((t) => {
      const h = HEIGHTS[t.kind];
      const row = { track: t, y, h };
      y += h;
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, version]);
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
  const fit = () => setView((v) => ({ ...v, pps: Math.max(0.02, (size.w - HEADER - 20) / Math.max(1, index.end)), x0: 0 }));
  useEffect(() => {
    if (view.pps === 0 && size.w > HEADER) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, index.end]);

  // redraw on every player frame (playhead) and after every render (view, edits). One pending draw at a
  // time and never cancelled: the player emits from its own animation frame, and the timeline may re-render
  // while playing, so cancelling and re-requesting would push the draw back a frame, every frame, until
  // playback stops (the playhead then only moved on pause). The subscription is made once; it always calls
  // the latest draw.
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => draw();
  const paintRef = useRef<() => void>(() => {});
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        drawRef.current();
      });
    };
    paintRef.current = paint;
    const off = player.onChange(paint);
    paint();
    return () => {
      off();
      cancelAnimationFrame(raf);
      paintRef.current = () => {};
    };
  }, [player]);
  useEffect(() => paintRef.current());

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
    const d = drag.current;

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
      if (d && d.kind === 'move' && d.started && d.target === row.track.id) {
        ctx.fillStyle = 'rgba(255,212,0,0.06)';
        ctx.fillRect(HEADER, y, size.w - HEADER, row.h);
      }
      drawTrack(ctx, row, y, t0, t1);
      if (row.track.locked) {
        ctx.fillStyle = COLORS.locked;
        ctx.fillRect(HEADER, y, size.w - HEADER, row.h);
      }
      drawHeader(ctx, row, y);
    });
    // ghosts of clips being dragged onto another track
    if (d && d.kind === 'move' && d.started && d.target) {
      const row = rows.find((r) => r.track.id === d.target);
      const from = studio.editor?.trackOf(d.primary);
      if (row && from && from.id !== d.target) {
        const y = TOP + row.y - view.y0;
        for (const id of d.ids) {
          const r = resolved.clips.get(id);
          if (!r) continue;
          const x0 = tToX(r.start + d.dt);
          const x1 = tToX((r.end ?? resolved.end) + d.dt);
          ctx.fillStyle = 'rgba(255,212,0,0.35)';
          roundRect(ctx, x0, y + 3, Math.max(2, x1 - x0), row.h - 6, 3);
          ctx.fill();
        }
      }
    }
    // the range (I/O) across all lanes
    if (s.range) {
      const x0 = Math.max(HEADER, tToX(s.range[0]));
      const x1 = Math.min(size.w, tToX(s.range[1]));
      if (x1 > x0) {
        ctx.fillStyle = COLORS.range;
        ctx.fillRect(x0, TOP, x1 - x0, size.h - TOP);
      }
    }
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
    if (s.range) {
      const x0 = Math.max(HEADER, tToX(s.range[0]));
      const x1 = Math.min(size.w, tToX(s.range[1]));
      ctx.fillStyle = 'rgba(80,160,240,0.55)';
      if (x1 > x0) ctx.fillRect(x0, RULER - 6, x1 - x0, 6);
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

    // requests: pins on the ruler, striped placeholders over their ranges in the section band
    for (const r of project.requests ?? []) {
      if (r.status === 'done' || r.status === 'rejected') continue;
      const color = r.status === 'working' ? '#50a0f0' : COLORS.request;
      if (r.range) {
        const x0 = Math.max(HEADER, tToX(r.range[0]));
        const x1 = Math.min(size.w, tToX(r.range[1]));
        if (x1 > x0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, RULER, x1 - x0, SECTIONS);
          ctx.clip();
          ctx.fillStyle = 'rgba(255,179,71,0.25)';
          ctx.fillRect(x0, RULER, x1 - x0, SECTIONS);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 2;
          for (let x = x0 - SECTIONS; x < x1; x += 10) {
            ctx.beginPath();
            ctx.moveTo(x, RULER + SECTIONS);
            ctx.lineTo(x + SECTIONS, RULER);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff';
          ctx.font = '600 11px "Segoe UI", sans-serif';
          ctx.fillText(`✎ ${r.text}`, x0 + 4, RULER + SECTIONS / 2, x1 - x0 - 8);
          ctx.restore();
        }
      }
      const at = r.range?.[0] ?? r.t;
      if (at !== undefined) {
        const x = tToX(at);
        if (x >= HEADER) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, 7, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // anchors: flags on the ruler
    for (const a of project.anchors) {
      const v = resolved.anchors.get(a.name);
      if (v === undefined) continue;
      const x = tToX(d?.kind === 'anchor' && d.name === a.name ? v + d.dt : v);
      if (x < HEADER || x > size.w) continue;
      ctx.fillStyle = COLORS.anchor;
      ctx.fillRect(x - 0.5, 0, 1.5, RULER);
      ctx.beginPath();
      ctx.moveTo(x, RULER - 12);
      ctx.lineTo(x + 8, RULER - 8);
      ctx.lineTo(x, RULER - 4);
      ctx.fill();
      if (view.pps > 15) {
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText(a.name, x + 10, RULER - 8);
      }
    }

    // export cache bar: green = rendered and current, grey = will render on export
    ctx.fillStyle = '#101216';
    ctx.fillRect(HEADER, RULER + SECTIONS, size.w - HEADER, CACHE);
    for (const seg of studio.cachePlan ?? []) {
      const x0 = Math.max(HEADER, tToX(seg.t0));
      const x1 = Math.min(size.w, tToX(seg.t1));
      if (x1 <= x0) continue;
      ctx.fillStyle = seg.cached ? COLORS.cached : COLORS.stale;
      ctx.fillRect(x0, RULER + SECTIONS, Math.max(1, x1 - x0 - 1), CACHE);
    }

    ctx.fillStyle = COLORS.header;
    ctx.fillRect(0, 0, HEADER, TOP);
    ctx.fillStyle = COLORS.muted;
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillText(`${view.pps.toFixed(view.pps < 10 ? 1 : 0)} px/s`, 10, RULER / 2);
    if (s.range) ctx.fillText(`range ${(s.range[1] - s.range[0]).toFixed(2)} s`, 10, RULER + SECTIONS / 2);

    // snap guide
    if (d && 'snap' in d && d.snap && d.started) {
      const x = tToX(d.snap.t);
      ctx.fillStyle = COLORS.snap;
      ctx.fillRect(x - 0.5, RULER, 1.5, size.h - RULER);
      ctx.font = '600 11px "Segoe UI", sans-serif';
      const label = d.snap.label + (d.snap.expr ? ' · link' : '');
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(20,20,20,0.9)';
      ctx.fillRect(x + 4, RULER + 2, w, 16);
      ctx.fillStyle = COLORS.snap;
      ctx.fillText(label, x + 9, RULER + 10);
    }

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

  function drawHeader(ctx: CanvasRenderingContext2D, row: Row, y: number) {
    const t = row.track;
    ctx.fillStyle = COLORS.header;
    ctx.fillRect(0, y, HEADER, row.h);
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(0, y + row.h - 1, size.w, 1);
    ctx.fillStyle = COLORS.text;
    ctx.font = '600 12px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.id, 10, y + row.h / 2 - 7);
    ctx.fillStyle = COLORS.muted;
    ctx.font = '11px "Segoe UI", sans-serif';
    const gain = t.gain ? ` ${t.gain > 0 ? '+' : ''}${t.gain} dB` : '';
    const sub = [t.name, t.kind === 'audio' ? t.role : t.kind].filter(Boolean).join(' · ') + gain;
    ctx.fillText(sub, 10, y + row.h / 2 + 8, HEADER - 76);
    let x = HEADER - 22;
    for (const [label, field, has] of TOGGLES) {
      if (!has(t)) continue;
      const on = t[field] === true;
      ctx.fillStyle = on ? (field === 'locked' ? '#c9822b' : '#ff6b5f') : '#2c313d';
      roundRect(ctx, x, y + row.h / 2 - 9, 18, 18, 3);
      ctx.fill();
      ctx.fillStyle = on ? '#111' : COLORS.muted;
      ctx.font = '700 10px "Segoe UI", sans-serif';
      ctx.fillText(label, x + 5, y + row.h / 2 + 1);
      x -= 21;
    }
  }

  function toggleAt(row: Row, x: number, y: number): 'muted' | 'hidden' | 'locked' | null {
    let bx = HEADER - 22;
    const cy = TOP + row.y - view.y0 + row.h / 2;
    for (const [, field, has] of TOGGLES) {
      if (!has(row.track)) continue;
      if (x >= bx && x <= bx + 18 && Math.abs(y - cy) <= 10) return field;
      bx -= 21;
    }
    return null;
  }

  function drawTrack(ctx: CanvasRenderingContext2D, row: Row, y: number, t0: number, t1: number) {
    const track = row.track;
    const h = row.h;
    if (track.kind === 'captions') return drawWords(ctx, y, h, t0, t1);
    const spans = index.tracks.get(track.id)?.query(t0 - 30, t1) ?? [];
    const d = drag.current;
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const lanes: number[] = [];
    const laneOf = new Map<string, number>();
    for (const sp of sorted) {
      let lane = lanes.findIndex((end) => end <= sp.start + 1e-6);
      if (lane < 0) lane = lanes.push(0) - 1;
      lanes[lane] = sp.end;
      laneOf.set(sp.id, lane);
    }
    const laneH = (h - 6) / Math.max(1, lanes.length);
    for (const sp of sorted) {
      let start = sp.start;
      let end = sp.end;
      let alpha = sp.clip.type === 'generator' ? 0.6 : 0.9;
      if (d && 'ids' in d && d.started && d.ids.includes(sp.id)) {
        if (d.kind === 'move') {
          if (d.target && d.target !== track.id) alpha = 0.3;
          else {
            start += d.dt;
            end += d.dt;
          }
        } else if (d.kind === 'trimStart') start += d.dt;
        else end += d.dt;
      }
      const x0 = tToX(start);
      const x1 = tToX(end);
      const cx0 = Math.max(HEADER, x0);
      const cx1 = Math.min(size.w, x1);
      if (cx1 < cx0) continue;
      const top = y + 3 + laneOf.get(sp.id)! * laneH;
      const c = sp.clip;
      const sel = s.selected.includes(c.id);
      ctx.fillStyle = clipColor(c, track);
      ctx.globalAlpha = alpha;
      roundRect(ctx, x0, top, Math.max(1.5, x1 - x0), laneH - 2, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (track.kind === 'audio' && c.type === 'media') drawWave(ctx, c, start, x0, x1, top, laneH - 2);
      drawFades(ctx, c, x0, x1, top, laneH - 2);
      if (c.pivot && x1 - x0 > 4) {
        const hx = tToX(start + c.pivot); // the SFX hit point
        ctx.fillStyle = '#ffd400';
        ctx.fillRect(hx - 0.5, top, 1.5, laneH - 2);
      }
      if (typeof c.start === 'string' && x1 - x0 > 10) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; // linked start
        ctx.beginPath();
        ctx.arc(x0 + 4, top + laneH - 7, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (problemIds.has(c.id) || sel) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = sel ? COLORS.select : COLORS.problem;
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
        if (c.type === 'media' && c.gain !== undefined && laneH > 30) {
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.fillText(`${c.gain > 0 ? '+' : ''}${c.gain} dB`, cx0 + 5, top + laneH - 16);
        }
        ctx.restore();
      }
    }
  }

  function drawFades(ctx: CanvasRenderingContext2D, c: Clip, x0: number, x1: number, top: number, h: number) {
    const [fi, fo] = c.type === 'title' ? c.fade ?? [0, 0] : c.type === 'media' ? [c.fadeIn ?? 0, c.fadeOut ?? 0] : [0, 0];
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    if (fi > 0) {
      ctx.beginPath();
      ctx.moveTo(x0, top);
      ctx.lineTo(x0 + fi * view.pps, top);
      ctx.lineTo(x0, top + h);
      ctx.fill();
    }
    if (fo > 0) {
      ctx.beginPath();
      ctx.moveTo(x1, top);
      ctx.lineTo(x1 - fo * view.pps, top);
      ctx.lineTo(x1, top + h);
      ctx.fill();
    }
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
    const words = resolved.words;
    if (!words.length) return;
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

  // --- snapping ----------------------------------------------------------------------------------
  function buildSnaps(exclude: Set<string>): Snap[] {
    const out: Snap[] = [{ t: 0, label: 'start' }, { t: resolved.end, label: 'end' }, { t: player.time(), label: 'playhead' }];
    resolved.sections.forEach((sec) => {
      out.push({ t: sec.t0, label: `${sec.id} start`, expr: `${sec.id}.start` }, { t: sec.t1, label: `${sec.id} end`, expr: `${sec.id}.end` });
    });
    for (const [name, v] of resolved.anchors) out.push({ t: v, label: `anchor ${name}`, expr: name });
    for (const [id, r] of resolved.clips) {
      if (exclude.has(id)) continue;
      out.push({ t: r.start, label: `${id} start` });
      if (r.end !== null) out.push({ t: r.end, label: `${id} end` });
      const c = studio.editor?.clip(id);
      if (c?.pivot) out.push({ t: r.start + c.pivot, label: `${id} hit` });
    }
    const w = studio.words;
    if (w)
      w.words.forEach((word, i) => {
        out.push({ t: word.s, label: `"${word.w}"`, expr: w.refOf(i) });
        out.push({ t: word.e, label: `"${word.w}" end`, expr: w.refOf(i, true) });
      });
    return out.sort((a, b) => a.t - b.t);
  }

  function nearest(snaps: Snap[], t: number): Snap | null {
    let lo = 0;
    let hi = snaps.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (snaps[m]!.t < t) lo = m + 1;
      else hi = m;
    }
    let best: Snap | null = null;
    for (const i of [lo - 1, lo]) {
      const sn = snaps[i];
      if (sn && Math.abs(sn.t - t) * view.pps <= SNAP_PX && (!best || Math.abs(sn.t - t) < Math.abs(best.t - t))) best = sn;
    }
    return best;
  }

  // --- input -------------------------------------------------------------------------------------
  function rowAt(y: number): Row | undefined {
    const yy = y - TOP + view.y0;
    return rows.find((r) => yy >= r.y && yy < r.y + r.h);
  }

  function hit(x: number, y: number): { clip?: Clip; t: number; edge?: 'start' | 'end'; row?: Row } {
    const t = xToT(x);
    if (y < TOP) return { t };
    const row = rowAt(y);
    if (!row || row.track.kind === 'captions') return { t, ...(row && { row }) };
    const spans = index.tracks.get(row.track.id)?.query(t - EDGE / view.pps, t + EDGE / view.pps) ?? [];
    if (!spans.length) return { t, row };
    const under = spans.filter((sp) => t >= sp.start && t < sp.end);
    const pool = under.length ? under : spans;
    const sp = pool[pool.length - 1]!;
    const xs = tToX(sp.start);
    const xe = tToX(sp.end);
    let edge: 'start' | 'end' | undefined;
    if (xe - xs > EDGE * 3) {
      if (Math.abs(x - xs) <= EDGE) edge = 'start';
      else if (Math.abs(x - xe) <= EDGE) edge = 'end';
    } else if (x > xe - 2) edge = 'end';
    return { clip: sp.clip, t, row, ...(edge && { edge }) };
  }

  function anchorAt(x: number, y: number): string | null {
    if (y > RULER) return null;
    for (const a of project.anchors) {
      const v = resolved.anchors.get(a.name);
      if (v !== undefined && Math.abs(tToX(v) - x) <= 5) return a.name;
    }
    return null;
  }

  /** What the pointer is over, in words: the hover help for the canvas. */
  function tipAt(x: number, y: number): string | null {
    const fps = project.fps;
    const tc = (t: number) => timecode(t, fps);
    if (x < HEADER) {
      if (y < TOP) return null;
      const row = rowAt(y);
      if (!row) return null;
      const field = toggleAt(row, x, y);
      const t = row.track;
      if (field === 'locked') return t.locked ? 'Unlock track' : 'Lock track: no moving or trimming its clips';
      if (field === 'muted') return t.muted ? 'Unmute track' : 'Mute track';
      if (field === 'hidden') return t.hidden ? 'Show track' : 'Hide track: leave it out of the preview and export';
      const kind = t.kind === 'audio' ? `${t.role ?? 'audio'} audio` : t.kind;
      return `${t.id}${t.name ? ` · ${t.name}` : ''} · ${kind} track${t.gain ? ` · ${t.gain > 0 ? '+' : ''}${t.gain} dB` : ''}`;
    }
    const t = xToT(x);
    if (y < RULER) {
      const a = anchorAt(x, y);
      if (a) return `Marker "${a}" at ${tc(resolved.anchors.get(a) ?? 0)} · drag to move it`;
      for (const r of project.requests ?? []) {
        if (r.status === 'done' || r.status === 'rejected') continue;
        const at = r.range?.[0] ?? r.t;
        if (at !== undefined && Math.abs(tToX(at) - x) <= 6) return `Request ${r.id} (${r.status === 'working' ? 'Claude is on it' : 'open'}): ${r.text}`;
      }
      return 'Ruler: click or drag to move the playhead · Shift-drag (or I / O) to set a range';
    }
    if (y < RULER + SECTIONS) {
      for (const r of project.requests ?? []) {
        if (r.status === 'done' || r.status === 'rejected' || !r.range) continue;
        if (t >= r.range[0] && t < r.range[1]) return `Request ${r.id} (${r.status === 'working' ? 'Claude is on it' : 'open'}): ${r.text}`;
      }
      const sec = resolved.sections.find((x2) => t >= x2.t0 && t < x2.t1);
      if (!sec) return null;
      const note = project.sections.find((x2) => x2.id === sec.id)?.note;
      return `Section ${sec.id} · ${tc(sec.t0)} – ${tc(sec.t1)}${note ? ` · ${note}` : ''}`;
    }
    if (y < TOP) return 'Export cache: green is already rendered, grey renders on the next export';
    const h = hit(x, y);
    if (h.row?.track.kind === 'captions') return 'Captions, made from the transcript: edit the words in the Transcript tab';
    if (!h.clip) return null;
    const c = h.clip;
    const rc = resolved.clips.get(c.id);
    const name = ('label' in c && c.label) || ('src' in c && typeof c.src === 'string' && c.src.split('/').pop()) || c.id;
    const span = rc ? ` · ${tc(rc.start)}${rc.end !== null ? ` – ${tc(rc.end)}` : ''}` : '';
    if (h.row?.track.locked) return `${name}${span} · track is locked`;
    if (h.edge) return `${name} · drag to trim the ${h.edge} (Alt: no snap)`;
    return `${name}${span} · drag to move · double-click to jump here · S splits at the playhead`;
  }

  const showTip = (text: string | null, x: number, y: number) => {
    const w = tipWait.current;
    if (text && w?.text === text) return;
    if (w) clearTimeout(w.timer);
    setTip(null);
    tipWait.current = text ? { text, timer: window.setTimeout(() => setTip({ text, x, y }), 450) } : null;
  };
  const hideTip = () => showTip(null, 0, 0);

  const onDown = (e: React.MouseEvent) => {
    hideTip();
    if (e.button !== 0) return;
    const r = cv.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < HEADER) {
      const row = y >= TOP ? rowAt(y) : undefined;
      if (!row) return;
      const field = toggleAt(row, x, y);
      if (field) {
        const on = row.track[field] === true;
        studio.apply([{ op: 'update_track', id: row.track.id, set: { [field]: on ? null : true } }], `${on ? 'un' : ''}${{ muted: 'muted', hidden: 'hid', locked: 'locked' }[field]} track ${row.track.id}`);
      }
      return;
    }
    const anchor = anchorAt(x, y);
    if (anchor) drag.current = { kind: 'anchor', name: anchor, dt: 0, x0: x };
    else if (y < TOP && e.shiftKey) {
      drag.current = { kind: 'range', from: xToT(x) };
      studio.setRange(null);
    } else {
      const h = hit(x, y);
      if (h.clip && y >= TOP) {
        const id = h.clip.id;
        if (e.shiftKey || e.ctrlKey || e.metaKey) studio.select(id, true);
        else if (!studio.selected.includes(id)) studio.select(id);
        const kind = h.edge === 'start' ? 'trimStart' : h.edge === 'end' ? 'trimEnd' : 'move';
        const ids = kind === 'move' ? (studio.selected.includes(id) ? [...studio.selected] : [id]) : [id];
        drag.current = {
          kind,
          ids,
          primary: id,
          x0: x,
          started: false,
          dt: 0,
          snap: null,
          target: studio.editor?.trackOf(id)?.id ?? null,
          snaps: buildSnaps(new Set(ids)),
        };
      } else {
        if (y >= TOP) studio.select(null);
        drag.current = { kind: 'scrub' };
        player.seek(h.t);
      }
    }
    const move = (ev: MouseEvent) => onMove(ev, r);
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onUp(ev);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  function onMove(ev: MouseEvent, r: DOMRect) {
    const d = drag.current;
    if (!d) return;
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    if (d.kind === 'scrub') return player.seek(xToT(x));
    if (d.kind === 'range') return studio.setRange([d.from, xToT(x)]);
    if (d.kind === 'anchor') {
      d.dt = (x - d.x0) / view.pps;
      return draw();
    }
    const home = studio.editor?.trackOf(d.primary)?.id;
    if (!d.started) {
      const vertical = d.kind === 'move' && rowAt(y) !== undefined && rowAt(y)!.track.id !== home;
      if (Math.abs(x - d.x0) < 3 && !vertical) return;
    }
    d.started = true;
    const rc = resolved.clips.get(d.primary);
    const c = studio.editor?.clip(d.primary);
    if (!rc || !c) return;
    let dt = (x - d.x0) / view.pps;
    d.snap = null;
    if (!ev.altKey) {
      // the point that may link (start, or an SFX's hit) is tried first; ends only snap
      const linkPoint = d.kind === 'move' ? rc.start + (c.pivot ?? 0) : d.kind === 'trimStart' ? rc.start : (rc.end ?? rc.start);
      const points: [number, boolean][] = [[linkPoint, d.kind !== 'trimEnd']];
      if (d.kind === 'move' && rc.end !== null) points.push([rc.end, false]);
      let best: { sn: Snap; delta: number; links: boolean } | null = null;
      for (const [p, links] of points) {
        const sn = nearest(d.snaps, p + dt);
        if (sn && (!best || Math.abs(sn.t - (p + dt)) < Math.abs(best.delta))) best = { sn, delta: sn.t - (p + dt), links };
      }
      if (best) {
        dt += best.delta;
        d.snap = best.links ? best.sn : { t: best.sn.t, label: best.sn.label };
      }
    }
    d.dt = dt;
    if (d.kind === 'move') {
      const row = rowAt(y);
      const clips = d.ids.map((id) => studio.editor?.clip(id)).filter(Boolean) as Clip[];
      const sameTrack = d.ids.every((id) => studio.editor?.trackOf(id)?.id === home);
      d.target = row && sameTrack && !row.track.locked && clips.every((cl) => clipAllowedOn(cl, row.track.kind)) ? row.track.id : (home ?? null);
    }
    draw();
  }

  function onUp(ev: MouseEvent) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const ed = studio.editor;
    if (!ed) return;
    if (d.kind === 'anchor') {
      const a = project.anchors.find((x) => x.name === d.name);
      if (a && Math.abs(d.dt) > 1 / 120) studio.apply([{ op: 'set_anchor', name: d.name, at: shiftExpr(a.at, Math.round(d.dt * 1e4) / 1e4) }], `moved anchor ${d.name}`);
      return draw();
    }
    if (d.kind === 'scrub' || d.kind === 'range') return draw();
    if (!d.started) {
      if (!(ev.shiftKey || ev.ctrlKey || ev.metaKey) && studio.selected.length > 1) studio.select(d.primary);
      return draw();
    }
    const link = d.snap?.expr;
    if (d.kind === 'move') {
      const from = ed.trackOf(d.primary)?.id;
      studio.run(
        (e) => {
          const ops = moveClips(e, d.ids, d.dt, d.target && d.target !== from ? d.target : undefined);
          if (link) setOnClip(ops, d.primary, 'start', link);
          return ops;
        },
        `moved ${d.ids.length > 1 ? `${d.ids.length} clips` : d.primary}${link ? ` onto ${d.snap!.label}` : ''}${d.target && d.target !== from ? ` to ${d.target}` : ''}`,
      );
    } else {
      const rc = resolved.clips.get(d.primary)!;
      const edge = d.kind === 'trimStart' ? 'start' : 'end';
      const at = (edge === 'start' ? rc.start : (rc.end ?? rc.start)) + d.dt;
      studio.run(
        (e) => {
          const ops = trimClip(e, d.primary, edge, at);
          if (link && edge === 'start' && !e.clip(d.primary)?.pivot) setOnClip(ops, d.primary, 'start', link);
          return ops;
        },
        `trimmed the ${edge} of ${d.primary}${link ? ` to ${d.snap!.label}` : ''}`,
      );
    }
  }

  const onDouble = (e: React.MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const h = hit(e.clientX - r.left, e.clientY - r.top);
    if (h.clip) {
      const rc = resolved.clips.get(h.clip.id);
      if (rc) player.seek(rc.start);
    }
  };

  const onHover = (e: React.MouseEvent) => {
    if (drag.current) return;
    const r = cv.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let cursor = 'default';
    if (x >= HEADER) {
      if (anchorAt(x, y)) cursor = 'ew-resize';
      else {
        const h = hit(x, y);
        if (h.clip && y >= TOP) cursor = h.row?.track.locked ? 'not-allowed' : h.edge ? 'col-resize' : 'grab';
        else if (y < TOP) cursor = 'text';
      }
    } else if (y >= TOP) {
      const row = rowAt(y);
      if (row && toggleAt(row, x, y)) cursor = 'pointer';
    }
    if (cursor !== hover) setHover(cursor);
    showTip(tipAt(x, y), x, y);
  };

  // drop files from the media pool
  const onDrop = async (e: React.DragEvent) => {
    const path = e.dataTransfer.getData('text/mango-path');
    const kind = e.dataTransfer.getData('text/mango-kind');
    if (!path) return;
    e.preventDefault();
    const r = cv.current!.getBoundingClientRect();
    const t = Math.max(0, xToT(e.clientX - r.left));
    const row = rowAt(e.clientY - r.top);
    const src = studio.srcOf(path);
    await studio.probe([src]);
    const info = studio.opened?.media[src];
    const ed = studio.editor!;
    const isAudio = kind === 'audio';
    const wantKind: Track['kind'] = isAudio ? 'audio' : 'video';
    const ops: Op[] = [];
    let track = row && row.track.kind === wantKind && !row.track.locked ? row.track : null;
    if (!track) {
      track = { id: ed.freshId(isAudio ? 'A' : 'V'), kind: wantKind, ...(isAudio && { role: 'other' as const }), clips: [] };
      // a new visual track goes above the other visual tracks; audio at the bottom
      const idx = isAudio ? project.tracks.length : project.tracks.filter((x) => x.kind !== 'audio').length;
      ops.push({ op: 'add_track', track, index: idx });
    }
    const dur = kind === 'image' ? 3 : (info?.duration ?? 5);
    const k = project.width / 1080;
    const clip = {
      id: ed.freshId(isAudio ? 'a' : 'v'),
      type: 'media',
      src,
      start: Math.round(t * 1e4) / 1e4,
      end: Math.round((t + dur) * 1e4) / 1e4,
      ...(kind === 'image' && { still: true }),
      ...(!isAudio && { cardW: 1080, cy: Math.round(project.height / k / 2) }),
    } as Clip;
    ops.push({ op: 'add_clip', track: track.id, clip });
    if (studio.apply(ops, `added ${src.split('/').pop()} at ${timecode(t, project.fps)}`)) studio.select(clip.id);
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
        const pps = Math.min(4000, Math.max(0.02, view.pps * Math.exp(-e.deltaY * 0.0015)));
        setView((v) => ({ ...v, pps, x0: Math.max(0, at - (Math.max(HEADER, x) - HEADER) / pps) }));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dx = (e.deltaX || e.deltaY) / view.pps;
        setView((v) => ({ ...v, x0: Math.max(0, v.x0 + dx) }));
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
        <span title="Scroll to pan, Ctrl + wheel to zoom">Timeline</span>
        <button className="ghost" onClick={fit} title="Fit the whole timeline">Fit</button>
        <button className="ghost" onClick={() => setView((v) => ({ ...v, pps: v.pps * 1.5 }))} title="Zoom in (Ctrl + wheel)">＋</button>
        <button className="ghost" onClick={() => setView((v) => ({ ...v, pps: v.pps / 1.5 }))} title="Zoom out (Ctrl + wheel)">－</button>
        <span className="muted small">
          drag to move · drag edges to trim · Alt: no snap · S split · Del delete · Shift+Del ripple · , . nudge · Shift-drag the ruler or I / O: range · M marker
        </span>
      </div>
      <div
        className="timeline-canvas"
        ref={wrap}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/mango-path')) e.preventDefault();
        }}
        onDrop={(e) => void onDrop(e)}
      >
        <canvas ref={cv} style={{ width: size.w, height: size.h, cursor: hover }} onMouseDown={onDown} onMouseMove={onHover} onMouseLeave={hideTip} onDoubleClick={onDouble} />
        {tip && (
          <div className="canvas-tip" style={{ left: Math.min(tip.x + 12, size.w - 320), top: tip.y + 18 > size.h - 30 ? tip.y - 30 : tip.y + 18 }}>
            {tip.text}
          </div>
        )}
      </div>
    </section>
  );
}

function setOnClip(ops: Op[], id: string, field: 'start' | 'end', expr: string) {
  const op = ops.find((o) => o.op === 'update_clip' && o.id === id);
  if (op && op.op === 'update_clip') op.set[field] = expr;
  else ops.unshift({ op: 'update_clip', id, set: { [field]: expr } });
}

function niceStep(raw: number): number {
  const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  return steps.find((s) => s >= raw) ?? 3600;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}
