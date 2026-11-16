// Transcript editing: the timeline's words (see wordmap.ts) become cuts. Deleting words, pauses or fillers
// is cutting every track at those times and closing the gaps.
import { rippleMany } from './commands.js';
import type { Editor, Op } from './ops.js';
import { round4, type Word } from './time.js';

export type { TimelineWord } from './wordmap.js';

/** Silences longer than `min` seconds between words, minus `keep` seconds of air on each side. */
export function pauses(words: readonly Word[], min = 0.8, keep = 0.15): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1]!.e + keep;
    const b = words[i]!.s - keep;
    if (words[i]!.s - words[i - 1]!.e >= min && b - a > 0.05) out.push([round4(a), round4(b)]);
  }
  return out;
}

const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'hmm', 'mm', 'uhm', 'ah', 'eh']);

/** Filler words (um, uh, …) as ranges to cut, each running to the next word so no gap is left. */
export function fillers(words: readonly Word[]): [number, number][] {
  const out: [number, number][] = [];
  words.forEach((w, i) => {
    if (!FILLERS.has(w.w.toLowerCase().replace(/[^a-z]/g, ''))) return;
    const next = words[i + 1];
    out.push([round4(w.s), round4(next ? Math.min(next.s, w.e + 0.3) : w.e)]);
  });
  return out;
}

/** Cut several time ranges out of every unlocked track, closing each gap (one pass). */
export function cutRanges(ed: Editor, ranges: [number, number][]): Op[] {
  return rippleMany(ed, ranges, null);
}
