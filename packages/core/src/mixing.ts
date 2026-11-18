// Mixing helpers shared by the live preview and the export, so both sound the same:
//   ducking:    a track with `duck` dips while the voice speaks (phrases from the timeline words, else the
//               voice clips), with a short attack and a slower release.
//   gain keys:  volume keyframes on a clip, [seconds from the clip's start, dB], linear between keys.
import type { Resolved } from './resolve.js';
import type { Project } from './schema.js';

/** Seconds the duck takes to go down before speech, and to come back after it. */
export const DUCK_ATTACK = 0.12;
export const DUCK_RELEASE = 0.35;

/**
 * When the voice is speaking on the timeline: merged phrases [start, end]. Words closer than `gap` join one
 * phrase, so the music doesn't pump between words. Muted voice tracks don't count.
 */
export function speechSpans(project: Project, resolved: Resolved, gap = 0.6): [number, number][] {
  const voiceTracks = project.tracks.filter((t) => t.kind === 'audio' && t.role === 'voice' && !t.muted);
  if (!voiceTracks.length) return [];
  const voiceClips = new Set(voiceTracks.flatMap((t) => t.clips.map((c) => c.id)));
  const raw: [number, number][] = [];
  const words = resolved.words.filter((w) => !w.clip || voiceClips.has(w.clip));
  if (words.length) for (const w of words) raw.push([w.s, w.e]);
  else
    for (const id of voiceClips) {
      const rc = resolved.clips.get(id);
      if (rc) raw.push([rc.start, rc.end ?? resolved.end]);
    }
  raw.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of raw) {
    const last = out[out.length - 1];
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** How far the duck is engaged at time t: 0 (none) to 1 (full depth). */
export function duckAmount(spans: readonly [number, number][], t: number): number {
  let best = 0;
  for (const [a, b] of spans) {
    if (t < a - DUCK_ATTACK) break;
    const up = t < a ? (t - (a - DUCK_ATTACK)) / DUCK_ATTACK : t <= b ? 1 : 1 - (t - b) / DUCK_RELEASE;
    best = Math.max(best, Math.min(1, Math.max(0, up)));
  }
  return best;
}

/** Volume keyframes at clip-local time `local`, in dB (0 when the clip has none). */
export function gainKeyAt(keys: readonly (readonly [number, number])[] | undefined, local: number): number {
  if (!keys?.length) return 0;
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  if (local <= k[0]![0]) return k[0]![1];
  for (let i = 0; i < k.length - 1; i++) {
    const [t0, d0] = k[i]!;
    const [t1, d1] = k[i + 1]!;
    if (local <= t1) return t1 === t0 ? d1 : d0 + ((d1 - d0) * (local - t0)) / (t1 - t0);
  }
  return k[k.length - 1]![1];
}

const f = (n: number) => n.toFixed(3);

/**
 * An ffmpeg `volume` expression (eval=frame) for ducking by `depthDb` over `spans`, with `t` on the
 * timeline. Phrases are at least `gap` apart, so their ramps don't overlap and the terms can be summed.
 */
export function duckExpr(spans: readonly [number, number][], depthDb: number): string {
  if (!spans.length || depthDb >= 0) return '1';
  const depth = 1 - Math.pow(10, depthDb / 20);
  const terms = spans.map(([a, b]) => `clip((t-${f(a - DUCK_ATTACK)})/${f(DUCK_ATTACK)},0,1)*clip((${f(b + DUCK_RELEASE)}-t)/${f(DUCK_RELEASE)},0,1)`);
  // sum, capped at 1 in case two ramps touch
  return `1-${depth.toFixed(5)}*min(1,${terms.join('+')})`;
}

/** An ffmpeg `volume` expression for gain keys, with `t` local to the clip (seconds from its start). */
export function gainKeysExpr(keys: readonly (readonly [number, number])[]): string {
  if (!keys.length) return '1';
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  // dB as a piecewise-linear function of t, then to a factor
  let db = String(k[k.length - 1]![1]);
  for (let i = k.length - 2; i >= 0; i--) {
    const [t0, d0] = k[i]!;
    const [t1, d1] = k[i + 1]!;
    const seg = t1 === t0 ? String(d1) : `${d0}+(${d1 - d0})*(t-${f(t0)})/${f(t1 - t0)}`;
    db = `if(lt(t,${f(t1)}),${seg},${db})`;
  }
  db = `if(lt(t,${f(k[0]![0])}),${k[0]![1]},${db})`;
  return `pow(10,(${db})/20)`;
}
