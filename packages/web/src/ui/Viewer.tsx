// The live frame: base canvas, HyperFrames comps (iframes, seeked to the clock), a top canvas for layers
// painted above the comps, and in request mode an overlay to draw a box or click an element.
import type { TitleClip } from '@mangoai/core';
import { useEffect, useRef, useState } from 'react';
import type { Player } from '../engine/player';
import { titleBounds } from '../engine/look';
import { studio, useStudio, type Picked } from '../store';

type Box = [number, number, number, number];

export function Viewer({ player }: { player: Player }) {
  const s = useStudio();
  const base = useRef<HTMLCanvasElement>(null);
  const top = useRef<HTMLCanvasElement>(null);
  const comps = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  const outer = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const p = player.project;

  useEffect(() => {
    player.attach(base.current, top.current, comps.current);
    return () => player.attach(null);
  }, [player]);

  // fit the frame in the viewer, keeping its aspect ratio
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth - 20;
      const H = el.clientHeight - 20;
      const sc = Math.max(0.05, Math.min(W / p.width, H / p.height));
      setFit({ w: Math.floor(p.width * sc), h: Math.floor(p.height * sc) });
      setK(sc);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.width, p.height]);

  useEffect(() => {
    // comp files changed (Claude edited a scene): reload those iframes
    for (const [id, v] of s.compVersion) player.compVersion.set(id, v);
    player.rebuild();
  }, [s.compVersion.size, [...s.compVersion.values()].join(','), player]);

  const requestMode = s.mode === 'request';

  /** Pointer position in frame pixels and normalized 0-1. */
  const at = (e: React.MouseEvent) => {
    const r = stage.current!.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { nx, ny, x: nx * p.width, y: ny * p.height };
  };

  const pick = (x: number, y: number): Picked | null => {
    const t = player.time();
    // 1. HyperFrames comps, top first: the exact element under the pointer
    for (const c of player.activeComps(t)) {
      const doc = c.el.contentDocument;
      const el = doc?.elementFromPoint(x, y) as HTMLElement | null;
      if (!doc || !el || el === doc.body || el === doc.documentElement) continue;
      const target = (el.closest('[id]:not(#root):not([data-composition-id])') as HTMLElement | null) ?? el;
      if (target.matches('[data-composition-id]')) continue;
      const b = target.getBoundingClientRect();
      if (b.width >= p.width * 0.98 && b.height >= p.height * 0.98) continue; // a full-frame backdrop: keep looking
      return {
        clip: c.clip,
        selector: cssPath(target),
        ...(target.id && { id: target.id }),
        text: (target.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
        box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
      };
    }
    // 2. built-in titles, top layer first
    const r = studio.resolved();
    const ctx = base.current?.getContext('2d');
    if (!r || !ctx) return null;
    const kk = p.width / 1080;
    const hits: { id: string; box: Box; layer: number }[] = [];
    for (const tr of p.tracks) {
      if (tr.kind !== 'graphics' || tr.hidden) continue;
      for (const c of tr.clips) {
        const rc = r.clips.get(c.id);
        if (c.type !== 'title' || !rc || rc.end === null || t < rc.start || t >= rc.end) continue;
        const [bx, by, bw, bh] = titleBounds(ctx, c as TitleClip);
        if (x >= bx * kk && x <= (bx + bw) * kk && y >= by * kk && y <= (by + bh) * kk)
          hits.push({ id: c.id, box: [bx * kk, by * kk, bw * kk, bh * kk], layer: p.tracks.indexOf(tr) * 10 + (c.layer ?? 1) });
      }
    }
    hits.sort((a, b) => b.layer - a.layer);
    const h = hits[0];
    if (h) {
      const c = studio.editor!.clip(h.id) as TitleClip;
      return { clip: h.id, text: c.text ?? c.runs?.map((x2) => x2[0]).join('') ?? '', box: h.box.map(Math.round) as Box };
    }
    // 3. the top-most visual clip under the pointer
    for (const tr of [...p.tracks].reverse()) {
      if ((tr.kind !== 'video' && tr.kind !== 'graphics') || tr.hidden) continue;
      for (const c of tr.clips) {
        const rc = r.clips.get(c.id);
        if (rc && rc.end !== null && t >= rc.start && t < rc.end && c.type !== 'generator') return { clip: c.id };
      }
    }
    return null;
  };

  const onDown = (e: React.MouseEvent) => {
    if (!requestMode) {
      player.toggle();
      return;
    }
    e.preventDefault();
    const a = at(e);
    let moved = false;
    const move = (ev: MouseEvent) => {
      const r = stage.current!.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const ny = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      if (Math.abs(nx - a.nx) > 0.01 || Math.abs(ny - a.ny) > 0.01) moved = true;
      if (moved) setDraft([Math.min(a.nx, nx), Math.min(a.ny, ny), Math.abs(nx - a.nx), Math.abs(ny - a.ny)]);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved) {
        const r = stage.current!.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        const ny = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
        const box: Box = [Math.min(a.nx, nx), Math.min(a.ny, ny), Math.abs(nx - a.nx), Math.abs(ny - a.ny)].map((v) => Math.round(v * 1e4) / 1e4) as Box;
        studio.setRegion(box);
        setDraft(null);
      } else {
        const picked = pick(a.x, a.y);
        studio.setPicked(picked);
        if (picked) studio.select(picked.clip);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const region = draft ?? s.region;
  const pickedBox = s.picked?.box;
  return (
    <div ref={outer} className={`viewer ${requestMode ? 'requesting' : ''}`}>
      <div ref={stage} className="stage" style={fit ? { width: fit.w, height: fit.h } : { visibility: 'hidden' }} onMouseDown={onDown}>
        <canvas ref={base} width={p.width} height={p.height} />
        <div ref={comps} className="comp-layer" style={{ ['--k' as string]: k }} />
        <canvas ref={top} width={p.width} height={p.height} className="top" />
        <svg className="overlay" viewBox={`0 0 ${p.width} ${p.height}`} preserveAspectRatio="none">
          {region && (
            <rect
              x={region[0] * p.width}
              y={region[1] * p.height}
              width={region[2] * p.width}
              height={region[3] * p.height}
              className="region"
              onDragOver={(e) => e.preventDefault()}
            />
          )}
          {pickedBox && <rect x={pickedBox[0]} y={pickedBox[1]} width={pickedBox[2]} height={pickedBox[3]} className="picked" />}
        </svg>
        {requestMode && (
          <div className="hint">Click a graphic to ask for a change, or drag a box where something new should go</div>
        )}
      </div>
    </div>
  );
}

/** A selector that finds the element again: #id when it has one, else a short nth-of-type path. */
function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== 'BODY' && parts.length < 5) {
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    cur = parent;
  }
  return parts.join(' > ');
}
