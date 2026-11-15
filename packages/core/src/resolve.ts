// Turns a project's expressions into numbers: anchors, then sections (back to back), then every clip.
// Pure and O(clips + words); a broken expression becomes a Problem on that item instead of failing the
// whole timeline, so the editor can still show everything else.
import type { Clip, Problem, Project } from './schema.js';
import { evalTime, frameOf, TimeError, WordIndex, type TimeScope } from './time.js';

export interface ResolvedSection {
  id: string;
  t0: number;
  t1: number;
}

export interface ResolvedClip {
  trackId: string;
  start: number;
  /** null: runs to the end of its media, whose length isn't known here. */
  end: number | null;
  /** Source in point and speed after speedTo, for media clips. */
  in?: number;
  speed?: number;
  /** Zoom keys with absolute times. */
  keys?: [number, number, number, number][];
}

export interface Resolved {
  anchors: Map<string, number>;
  sections: ResolvedSection[];
  clips: Map<string, ResolvedClip>;
  /** End of the timeline: the last section's end, else the latest clip end. */
  end: number;
  problems: Problem[];
}

export interface ResolveOptions {
  words?: WordIndex;
  /** Media lengths in seconds by src, to give audio clips without `end` a length. */
  durations?: ReadonlyMap<string, number>;
}

export function resolveProject(project: Project, opts: ResolveOptions = {}): Resolved {
  const problems: Problem[] = [];
  const names = new Map<string, number>();
  const anchors = new Map<string, number>();
  const words = opts.words;
  const scope: TimeScope = { names, ...(words && { words }) };

  const tryEval = (expr: Parameters<typeof evalTime>[0], path: string, s: TimeScope = scope): number | undefined => {
    try {
      return evalTime(expr, s);
    } catch (e) {
      if (!(e instanceof TimeError)) throw e;
      problems.push({ path, message: e.message });
      return undefined;
    }
  };

  project.anchors.forEach((a, i) => {
    const v = tryEval(a.at, `anchors.${i}.at`);
    if (v !== undefined) {
      anchors.set(a.name, v);
      names.set(a.name, v);
    }
  });

  const sections: ResolvedSection[] = [];
  let t0 = 0;
  project.sections.forEach((s, i) => {
    names.set(`${s.id}.start`, t0);
    const t1 = tryEval(s.end, `sections.${i}.end`) ?? t0;
    if (frameOf(t1, project.fps) <= frameOf(t0, project.fps))
      problems.push({ path: `sections.${i}.end`, message: `section ${s.id} ends at ${t1.toFixed(2)} s, not after its start ${t0.toFixed(2)} s` });
    names.set(`${s.id}.end`, t1);
    sections.push({ id: s.id, t0, t1 });
    t0 = t1;
  });

  // timeline_end: known now when there are sections; otherwise from clip ends in a second pass.
  const hasSections = sections.length > 0;
  if (hasSections) names.set('timeline_end', t0);

  const clips = new Map<string, ResolvedClip>();
  const deferred: [Clip, string, string][] = [];
  const resolveClip = (c: Clip, trackId: string, path: string) => {
    const pivot = c.pivot ?? 0;
    const startAt = tryEval(c.start, `${path}.start`);
    if (startAt === undefined) return;
    const start = startAt - pivot;
    let end: number | null = null;
    if (c.end !== undefined) end = tryEval(c.end, `${path}.end`) ?? null;
    const out: ResolvedClip = { trackId, start, end };
    if (c.type === 'media') {
      let inPt = c.in !== undefined ? tryEval(c.in, `${path}.in`) ?? 0 : 0;
      let speed = c.speed ?? 1;
      if (c.speedTo && end !== null) {
        const a = tryEval(c.speedTo[0], `${path}.speedTo.0`);
        const b = tryEval(c.speedTo[1], `${path}.speedTo.1`);
        if (a !== undefined && b !== undefined) {
          inPt = a;
          speed = (b - a) / (end - start);
        }
      }
      out.in = inPt;
      out.speed = speed;
      if (end === null && !c.loop) {
        const d = opts.durations?.get(c.src);
        if (d !== undefined) end = out.end = start + (d - inPt) / speed;
      }
      if (c.keys && end !== null) {
        const local = new Map(names);
        local.set('start', start);
        local.set('dur', end - start);
        const ks: TimeScope = { names: local, ...(words && { words }) };
        out.keys = [];
        c.keys.forEach((k, ki) => {
          const t = tryEval(k[0], `${path}.keys.${ki}.0`, ks);
          if (t !== undefined) out.keys!.push([t, k[1], k[2], k[3]]);
        });
      }
    }
    if (end !== null && end < start) problems.push({ path: `${path}.end`, message: `clip ${c.id} ends before it starts` });
    clips.set(c.id, out);
  };

  project.tracks.forEach((t, ti) =>
    t.clips.forEach((c, ci) => {
      const path = `tracks.${ti}.clips.${ci}`;
      const usesEnd = !hasSections && [c.start, c.end].some((e) => typeof e === 'string' && /(^|\s)timeline_end(\s|$)/.test(e));
      if (usesEnd) deferred.push([c, t.id, path]);
      else resolveClip(c, t.id, path);
    }),
  );

  let end = t0;
  if (!hasSections) {
    end = 0;
    for (const r of clips.values()) if (r.end !== null) end = Math.max(end, r.end);
    names.set('timeline_end', end);
    for (const [c, tid, path] of deferred) resolveClip(c, tid, path);
  }

  return { anchors, sections, clips, end, problems };
}
