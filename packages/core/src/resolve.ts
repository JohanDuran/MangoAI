// Turns a project's expressions into numbers: anchors, then sections (back to back), then every clip.
// Pure and O(clips + words); a broken expression becomes a Problem on that item instead of failing the
// whole timeline, so the editor can still show everything else.
import type { Clip, Problem, Project } from './schema.js';
import { evalTime, frameOf, TimeError, WordIndex, type TimeScope, type Word } from './time.js';
import { hasMappedTranscripts, mapWords, type TimelineWord } from './wordmap.js';

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
  /** Zoom keys with times resolved (clip-local seconds, as the toolbox uses them). */
  keys?: [number, number, number, number][];
  /** Comp variables with "@" time expressions turned into seconds from the clip's start. */
  vars?: Record<string, unknown>;
}

export interface Resolved {
  anchors: Map<string, number>;
  sections: ResolvedSection[];
  clips: Map<string, ResolvedClip>;
  /** End of the timeline: the last section's end, else the latest clip end. */
  end: number;
  problems: Problem[];
  /** The words as heard on the timeline (mapped through the clips that carry a transcript). */
  words: readonly TimelineWord[];
  /** What `word:` terms were looked up in (the first transcript, on the timeline). */
  wordIndex?: WordIndex;
}

export interface ResolveOptions {
  words?: WordIndex;
  /** Media lengths in seconds by src, to give audio clips without `end` a length. */
  durations?: ReadonlyMap<string, number>;
  /** Every transcript's words in source time, by name; lets words follow the clips that play them. */
  transcripts?: Readonly<Record<string, readonly Word[]>>;
}

/**
 * Resolve every time. When clips carry a transcript (a recording, the narration), words are first mapped
 * through those clips onto the timeline, then `word:` terms are looked up in the mapped words: cut or move
 * the voice and everything linked to its words follows.
 */
export function resolveProject(project: Project, opts: ResolveOptions = {}): Resolved {
  const first = resolveOnce(project, opts);
  if (!opts.transcripts || !hasMappedTranscripts(project)) {
    const name = Object.keys(project.transcripts)[0];
    const words: TimelineWord[] = (opts.words?.words ?? []).map((w, i) => ({ ...w, transcript: name ?? '', i }));
    return { ...first, words, ...(opts.words && { wordIndex: opts.words }) };
  }
  const all = mapWords(project, first.clips, opts.transcripts);
  const name = Object.keys(project.transcripts)[0];
  const index = new WordIndex(all.filter((w) => w.transcript === name));
  const second = resolveOnce(project, { ...opts, words: index });
  return { ...second, words: all, wordIndex: index };
}

function resolveOnce(project: Project, opts: ResolveOptions): Omit<Resolved, 'words' | 'wordIndex'> {
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
    if (c.type === 'comp' && c.vars) {
      const vars: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c.vars)) {
        if (typeof v === 'string' && v.startsWith('@')) {
          const at = tryEval(v.slice(1), `${path}.vars.${k}`);
          vars[k] = at === undefined ? null : Math.round((at - start) * 1e4) / 1e4;
        } else vars[k] = v;
      }
      out.vars = vars;
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
