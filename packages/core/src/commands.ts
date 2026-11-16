// Editing commands: what a mouse gesture or a Claude request means, turned into plain ops. Shared by the
// editor UI and the MCP server so both edit the same way. Each returns ops; the caller applies them as one
// change. Times stay linked: moving a clip that starts at "word:so" gives "word:so + 0.3", not a number.
import type { Editor, Op } from './ops.js';
import { OpError } from './ops.js';
import type { Clip, MediaClip, TimeExpr } from './schema.js';
import { round4, shiftExpr } from './time.js';

const FRAME = 1 / 30;

function resolvedOf(ed: Editor, id: string) {
  const r = ed.resolve().clips.get(id);
  if (!r) throw new OpError(`clip ${id} has no resolved time (fix its start first)`);
  return r;
}

/** Source length available to a media clip, in timeline seconds from its start; Infinity if unknown/looping. */
function mediaRoom(ed: Editor, c: Clip, inPt: number, speed: number): number {
  if (c.type !== 'media' || c.loop || c.still) return Infinity;
  const d = ed.resolveOpts.durations?.get(c.src);
  return d === undefined ? Infinity : (d - inPt) / speed;
}

/** speedTo clips: write the in point and speed out explicitly, so the clip can be trimmed or split. */
function unSpeedTo(ed: Editor, c: MediaClip): Record<string, unknown> {
  if (!c.speedTo) return {};
  const r = resolvedOf(ed, c.id);
  return { speedTo: null, in: round4(r.in ?? 0), speed: round4(r.speed ?? 1) };
}

/** Move clips by `delta` seconds (and optionally onto another track). */
export function moveClips(ed: Editor, ids: string[], delta: number, toTrack?: string): Op[] {
  const ops: Op[] = [];
  // never move anything before 0: clamp the whole group by its earliest clip
  for (const id of ids) {
    const r = ed.resolve().clips.get(id);
    if (r && r.start + delta < 0) delta = -r.start;
  }
  for (const id of ids) {
    const c = ed.clip(id);
    if (!c) throw new OpError(`no clip ${id}`);
    const t = ed.trackOf(id)!;
    if (t.locked) throw new OpError(`track ${t.id} is locked`);
    const set: Record<string, unknown> = {};
    if (Math.abs(delta) >= 5e-5) {
      set.start = shiftExpr(c.start, delta);
      if (c.end !== undefined) set.end = shiftExpr(c.end, delta);
    }
    if (Object.keys(set).length) ops.push({ op: 'update_clip', id, set });
    if (toTrack && toTrack !== t.id) ops.push({ op: 'move_clip', id, track: toTrack });
  }
  return ops;
}

/** Move one edge of a clip to time `t` (timeline seconds). The head trim also moves the source in point. */
export function trimClip(ed: Editor, id: string, edge: 'start' | 'end', t: number): Op[] {
  const c = ed.clip(id);
  if (!c) throw new OpError(`no clip ${id}`);
  if (ed.trackOf(id)!.locked) throw new OpError(`track ${ed.trackOf(id)!.id} is locked`);
  const r = resolvedOf(ed, id);
  const speed = r.speed ?? 1;
  const inPt = r.in ?? 0;
  const end = r.end ?? r.start + mediaRoom(ed, c, inPt, speed);
  const set: Record<string, unknown> = c.type === 'media' ? unSpeedTo(ed, c) : {};
  if (edge === 'end') {
    const room = r.start + mediaRoom(ed, c, inPt, speed);
    const nt = round4(Math.min(room, Math.max(r.start + FRAME, t)));
    if (c.end === undefined || !Number.isFinite(end)) set.end = nt;
    else if (Math.abs(nt - end) >= 5e-5) set.end = shiftExpr(c.end, round4(nt - end));
    else return [];
  } else {
    let nt = Math.min(end - FRAME, t);
    if (c.type === 'media' && !c.still && !c.loop) nt = Math.max(nt, r.start - inPt / speed); // not before the media's first frame
    nt = Math.max(0, nt);
    const delta = round4(nt - r.start);
    if (Math.abs(delta) < 5e-5) return [];
    if (c.type === 'media') set.in = round4(Math.max(0, inPt + delta * speed)) || null;
    if (c.pivot) {
      // keep the hit (pivot) on its word: trimming the head shortens the pivot instead of moving start
      const pivot = round4(c.pivot - delta);
      if (pivot >= 0) set.pivot = pivot || null;
      else {
        set.pivot = null;
        set.start = shiftExpr(c.start, -pivot);
      }
    } else set.start = shiftExpr(c.start, delta);
  }
  return [{ op: 'update_clip', id, set }];
}

/** Split clips at time t. `ids` empty: every clip under t on unlocked tracks. */
export function splitAt(ed: Editor, t: number, ids: string[] = []): Op[] {
  const res = ed.resolve();
  let targets = ids;
  if (targets.length === 0) {
    targets = [];
    for (const tr of ed.project.tracks) {
      if (tr.locked || tr.kind === 'captions') continue;
      for (const c of tr.clips) {
        const r = res.clips.get(c.id);
        if (r && r.end !== null && t > r.start + FRAME / 2 && t < r.end - FRAME / 2 && !c.pivot) targets.push(c.id);
      }
    }
  }
  const ops: Op[] = [];
  const taken = new Set<string>();
  for (const id of targets) {
    const c = ed.clip(id);
    const r = res.clips.get(id);
    if (!c || !r || r.end === null || !(t > r.start && t < r.end) || c.pivot) continue;
    const newId = ed.freshId(`${id.replace(/\.split\d+$/, '')}.split`, taken);
    taken.add(newId);
    if (c.type === 'media' && c.speedTo) ops.push({ op: 'update_clip', id, set: unSpeedTo(ed, c) });
    ops.push({ op: 'split_clip', id, at: round4(t), newId });
  }
  return ops;
}

export function deleteClips(ed: Editor, ids: string[]): Op[] {
  return ids.map((id) => {
    const t = ed.trackOf(id);
    if (!t) throw new OpError(`no clip ${id}`);
    if (t.locked) throw new OpError(`track ${t.id} is locked`);
    return { op: 'remove_clip', id } as Op;
  });
}

/**
 * Delete time [a, b) and close the gap: what's after b moves left by the gap. `trackIds`: which tracks ripple
 * (null: every unlocked track, and sections and anchors move too). Clips that straddle the range are cut.
 * Linked times are respected: things linked to words, sections or anchors that moved already follow them,
 * so each item gets exactly the offset that lands it where it belongs (see settle).
 */
export function rippleDelete(ed: Editor, a: number, b: number, trackIds: string[] | null = null): Op[] {
  return rippleMany(ed, [[a, b]], trackIds);
}

/** Delete several time ranges at once (one pass, however many: a transcript's pauses on a 50-min video). */
export function rippleMany(ed: Editor, input: [number, number][], trackIds: string[] | null = null): Op[] {
  const ranges = mergeRanges(input).filter(([a, b]) => b - a >= FRAME / 2);
  if (!ranges.length) return [];
  const tracks = () => ed.project.tracks.filter((t) => !t.locked && t.kind !== 'captions' && (trackIds === null || trackIds.includes(t.id)));
  // 1. cut every clip at every range edge it straddles: latest edge first, always splitting the first part
  const res = ed.resolve();
  const edges = ranges.flat();
  const cuts: Op[] = [];
  const taken = new Set<string>();
  for (const tr of tracks())
    for (const c of tr.clips) {
      const r = res.clips.get(c.id);
      if (!r || r.end === null || c.pivot) continue;
      const inside = edges.filter((t) => t > r.start + 1e-4 && t < r.end! - 1e-4).sort((x, y) => y - x);
      if (!inside.length) continue;
      if (c.type === 'media' && c.speedTo) cuts.push({ op: 'update_clip', id: c.id, set: { speedTo: null, in: round4(r.in ?? 0), speed: round4(r.speed ?? 1) } });
      for (const t of inside) {
        const newId = ed.freshId(`${c.id.replace(/\.split\d+$/, '')}.split`, taken);
        taken.add(newId);
        cuts.push({ op: 'split_clip', id: c.id, at: round4(t), newId });
      }
    }
  // where a time goes: before the first range stays, inside a range goes to its start, after moves left
  const before = (t: number) => {
    let removed = 0;
    for (const [a, b] of ranges) {
      if (t >= b - 1e-4) removed += b - a;
      else if (t > a) return round4(a - removed);
      else break;
    }
    return round4(t - removed);
  };
  const inRange = (t: number) => ranges.some(([a, b]) => t > a + 1e-4 && t < b - 1e-4);
  const covered = (s: number, e: number) => ranges.some(([a, b]) => s >= a - 1e-4 && e <= b + 1e-4);
  return ed.trial(cuts, () => {
    const r2 = ed.resolve();
    const pre: Op[] = [];
    const want: Targets = { clips: new Map(), sections: new Map(), anchors: new Map() };
    for (const tr of tracks())
      for (const c of tr.clips) {
        const r = r2.clips.get(c.id);
        if (!r) continue;
        const end = r.end ?? Infinity;
        if (c.pivot) {
          // an SFX goes where its hit goes (and is cut with it); the sound keeps its length
          const hit = r.start + c.pivot;
          if (inRange(hit)) pre.push({ op: 'remove_clip', id: c.id });
          else {
            const st = round4(before(hit) - c.pivot);
            want.clips.set(c.id, { start: st, end: r.end === null ? null : round4(st + (r.end - r.start)) });
          }
        } else if (covered(r.start, end)) pre.push({ op: 'remove_clip', id: c.id });
        else want.clips.set(c.id, { start: before(r.start), end: r.end === null ? null : before(r.end) });
      }
    if (trackIds === null) {
      ed.project.sections.forEach((sec, i) => {
        const rs = r2.sections[i];
        if (!rs) return;
        if (covered(rs.t0, rs.t1)) pre.push({ op: 'remove_section', id: sec.id });
        else want.sections.set(sec.id, before(rs.t1));
      });
      for (const [name, v] of r2.anchors) want.anchors.set(name, before(v));
    }
    return [...cuts, ...ed.trial(pre, () => settle(ed, want)), ...pre].sort(byKind);
  });
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const s = ranges.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** Removals first, then everything else (so a settle op never refers to a clip removed later). */
function byKind(x: Op, y: Op): number {
  const rank = (o: Op) => (o.op === 'split_clip' || (o.op === 'update_clip' && 'speedTo' in o.set) ? 0 : o.op === 'remove_clip' || o.op === 'remove_section' ? 1 : 2);
  return rank(x) - rank(y);
}

interface Targets {
  clips: Map<string, { start: number; end: number | null }>;
  sections: Map<string, number>;
  anchors: Map<string, number>;
}

/**
 * Ops that put clips, section ends and anchors at their target times. Items linked to each other (a title
 * on a word, a clip at "s03.start") move when what they're linked to moves, so the offsets are found by
 * iterating: apply, re-resolve, correct what's still off. Each item gets one folded offset in the end.
 */
export function settle(ed: Editor, want: Targets): Op[] {
  const orig = {
    clips: new Map([...want.clips.keys()].map((id) => [id, ed.clip(id)] as const)),
    sections: new Map(ed.project.sections.map((s) => [s.id, s.end] as const)),
    anchors: new Map(ed.project.anchors.map((x) => [x.name, x.at] as const)),
  };
  const dStart = new Map<string, number>();
  const dEnd = new Map<string, number>();
  const dSec = new Map<string, number>();
  const dAnc = new Map<string, number>();
  const build = (): Op[] => {
    const ops: Op[] = [];
    for (const [id, c] of orig.clips) {
      if (!c) continue;
      const set: Record<string, unknown> = {};
      const ds = dStart.get(id) ?? 0;
      const de = dEnd.get(id) ?? 0;
      if (Math.abs(ds) >= 5e-5) set.start = shiftExpr(c.start, round4(ds));
      if (c.end !== undefined && Math.abs(de) >= 5e-5) set.end = shiftExpr(c.end, round4(de));
      if (Object.keys(set).length) ops.push({ op: 'update_clip', id, set });
    }
    for (const [id, d] of dSec) if (Math.abs(d) >= 5e-5) ops.push({ op: 'update_section', id, set: { end: shiftExpr(orig.sections.get(id)!, round4(d)) } });
    for (const [name, d] of dAnc) if (Math.abs(d) >= 5e-5) ops.push({ op: 'set_anchor', name, at: shiftExpr(orig.anchors.get(name)!, round4(d)) });
    return ops;
  };
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (let iter = 0; iter < 6; iter++) {
    const off = ed.trial(build(), () => {
      const r = ed.resolve();
      let worst = 0;
      const fix: (() => void)[] = [];
      for (const [id, w] of want.clips) {
        const rc = r.clips.get(id);
        const c = orig.clips.get(id);
        if (!rc || !c) continue;
        const es = w.start - rc.start;
        if (Math.abs(es) >= 5e-5) fix.push(() => add(dStart, id, es));
        worst = Math.max(worst, Math.abs(es));
        if (c.end !== undefined && w.end !== null && rc.end !== null) {
          const ee = w.end - rc.end;
          if (Math.abs(ee) >= 5e-5) fix.push(() => add(dEnd, id, ee));
          worst = Math.max(worst, Math.abs(ee));
        }
      }
      r.sections.forEach((rs) => {
        const w = want.sections.get(rs.id);
        if (w === undefined) return;
        const e = w - rs.t1;
        if (Math.abs(e) >= 5e-5) fix.push(() => add(dSec, rs.id, e));
        worst = Math.max(worst, Math.abs(e));
      });
      for (const [name, w] of want.anchors) {
        const v = r.anchors.get(name);
        if (v === undefined) continue;
        const e = w - v;
        if (Math.abs(e) >= 5e-5) fix.push(() => add(dAnc, name, e));
        worst = Math.max(worst, Math.abs(e));
      }
      return { worst, fix };
    });
    if (off.worst < 5e-5) break;
    for (const f of off.fix) f();
  }
  return build();
}

/** Ops that put each clip at its desired resolved start/end, given whatever already moved it. */
export function placeOps(ed: Editor, desired: Map<string, { start: number; end: number | null }>): Op[] {
  return settle(ed, { clips: desired, sections: new Map(), anchors: new Map() });
}

/** Remove clips and close the gaps they leave on their own tracks. */
export function rippleDeleteClips(ed: Editor, ids: string[]): Op[] {
  const res = ed.resolve();
  // one clip at a time, latest first, so earlier gaps don't shift later ranges
  const items = ids
    .map((id) => ({ id, r: res.clips.get(id), t: ed.trackOf(id) }))
    .filter((x) => x.r && x.r.end !== null && x.t)
    .sort((x, y) => y.r!.start - x.r!.start);
  let ops: Op[] = [];
  for (const it of items) {
    const more = ed.trial(ops, () => {
      const r = ed.resolve().clips.get(it.id)!;
      return rippleDelete(ed, r.start, r.end!, [it.t!.id]);
    });
    ops = [...ops, ...more];
  }
  return ops;
}

export function setGain(ids: string[], db: number | null): Op[] {
  return ids.map((id) => ({ op: 'update_clip', id, set: { gain: db === null ? null : round4(db) } }) as Op);
}

export function setFades(ed: Editor, ids: string[], fadeIn?: number | null, fadeOut?: number | null): Op[] {
  return ids.map((id) => {
    const c = ed.clip(id);
    const set: Record<string, unknown> = {};
    if (c?.type === 'title') {
      const f = c.fade ?? [0, 0];
      const next: [number, number] = [fadeIn ?? f[0], fadeOut ?? f[1]];
      set.fade = next[0] || next[1] ? next : null;
    } else {
      if (fadeIn !== undefined) set.fadeIn = fadeIn ? round4(fadeIn) : null;
      if (fadeOut !== undefined) set.fadeOut = fadeOut ? round4(fadeOut) : null;
    }
    return { op: 'update_clip', id, set } as Op;
  });
}

/** Link a clip's start (or end) to a time expression, keeping it where it is now ("word:so + 0.12"). */
export function linkTime(ed: Editor, id: string, edge: 'start' | 'end', expr: TimeExpr): Op[] {
  const c = ed.clip(id);
  if (!c) throw new OpError(`no clip ${id}`);
  const r = resolvedOf(ed, id);
  const pivot = c.pivot ?? 0;
  const now = edge === 'start' ? r.start + pivot : r.end;
  if (now === null) throw new OpError(`clip ${id} has no end to link`);
  const probe = ed.trial([{ op: 'update_clip', id, set: { [edge]: expr } }], () => {
    const rr = ed.resolve().clips.get(id);
    const hasProblem = ed.resolve().problems.some((p) => p.message.includes(String(expr)));
    if (!rr || hasProblem) return null;
    return edge === 'start' ? rr.start + pivot : rr.end;
  });
  if (probe === null) throw new OpError(`${JSON.stringify(expr)} doesn't resolve`);
  return [{ op: 'update_clip', id, set: { [edge]: shiftExpr(expr, round4(now - probe)) } }];
}

/** Unlink: replace the expression with the number it resolves to now. */
export function unlinkTime(ed: Editor, id: string, edge: 'start' | 'end'): Op[] {
  const c = ed.clip(id);
  if (!c) throw new OpError(`no clip ${id}`);
  const r = resolvedOf(ed, id);
  const v = edge === 'start' ? r.start + (c.pivot ?? 0) : r.end;
  if (v === null) return [];
  return [{ op: 'update_clip', id, set: { [edge]: round4(v) } }];
}

/** Next free clip id like "t3" for a new clip. */
export function newClipId(ed: Editor, prefix: string): string {
  return ed.freshId(prefix);
}
