// Words of a source (in source time) mapped through the clips that play it onto the timeline.
// No imports beyond types, so resolve.ts can use it without an import cycle.
import type { Project } from './schema.js';
import type { Word } from './time.js';

export interface TimelineWord extends Word {
  /** Transcript name and index of the word in it. */
  transcript: string;
  i: number;
  /** The clip it's heard in (absent for words not tied to a clip). */
  clip?: string;
}

interface ClipTimes {
  start: number;
  end: number | null;
  in?: number;
  speed?: number;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** True when some media clip says which transcript its source has (words follow that clip). */
export function hasMappedTranscripts(project: Project): boolean {
  return project.tracks.some((t) => t.clips.some((c) => c.type === 'media' && c.transcript !== undefined));
}

/**
 * Every word on the timeline, in timeline time, sorted. Words come from clips with a `transcript`; when no
 * clip has one, the first transcript is taken to be in timeline time already.
 */
export function mapWords(project: Project, clips: ReadonlyMap<string, ClipTimes>, transcripts: Readonly<Record<string, readonly Word[]>>): TimelineWord[] {
  const out: TimelineWord[] = [];
  const seen = new Set<string>();
  if (!hasMappedTranscripts(project)) {
    const name = Object.keys(project.transcripts)[0] ?? Object.keys(transcripts)[0];
    const words = name ? transcripts[name] : undefined;
    if (name && words) words.forEach((w, i) => out.push({ ...w, transcript: name, i }));
    return out;
  }
  for (const track of project.tracks) {
    if (track.kind === 'audio' && track.muted) continue;
    for (const c of track.clips) {
      if (c.type !== 'media' || !c.transcript) continue;
      const words = transcripts[c.transcript];
      const r = clips.get(c.id);
      if (!words || !r) continue;
      const speed = r.speed ?? 1;
      const a = r.in ?? 0;
      const b = r.end === null ? Infinity : a + (r.end - r.start) * speed;
      for (let i = firstEnding(words, a); i < words.length && words[i]!.s < b; i++) {
        const w = words[i]!;
        if (w.s < a - 0.02) continue;
        const s = r4(r.start + (w.s - a) / speed);
        const key = `${c.transcript}:${i}:${Math.round(s * 100)}`;
        if (seen.has(key)) continue; // the same recording on a video and an audio track
        seen.add(key);
        out.push({ w: w.w, s, e: r4(r.start + (Math.min(w.e, b) - a) / speed), transcript: c.transcript, i, clip: c.id });
      }
    }
  }
  return out.sort((x, y) => x.s - y.s);
}

function firstEnding(words: readonly Word[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (words[m]!.e <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
