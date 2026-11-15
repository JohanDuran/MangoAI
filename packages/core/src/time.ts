// Time expressions, compatible with the media-toolbox short.json spec (workers/common/shorts_spec.py):
//   1.5            seconds
//   word:so        start of the 1st "so" in the transcript (case and punctuation ignored)
//   word:use#2     start of the 2nd "use"
//   word:so.end    end of the 1st "so"
//   chat           a named anchor
//   words_end      end of the last spoken word
//   start / dur    clip-local terms (zoom keys): the clip's start and its length
// MangoAI adds:
//   s01_hook.start / s01_hook.end   a section's start or end
//   timeline_end                    end of the timeline
// Terms are joined by " + " / " - " with spaces around the operator.
import type { TimeExpr } from './schema.js';

export interface Word {
  w: string;
  s: number;
  e: number;
}

export class TimeError extends Error {}

const OP = /\s+([+-])\s+/;
const WORD = /^word:([^#.]+)(?:#(\d+))?(\.end)?$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Same normalization as the toolbox: drop everything but word characters, ' and -, lower-case. */
export function normWord(w: string): string {
  return w.replace(/[^\p{L}\p{M}\p{N}_'-]/gu, '').toLowerCase();
}

/** Words grouped by normalized text, so `word:` lookups stay O(1) on an 8,000-word transcript. */
export class WordIndex {
  readonly words: readonly Word[];
  private readonly byText = new Map<string, Word[]>();

  constructor(words: readonly Word[]) {
    this.words = words;
    for (const w of words) {
      const k = normWord(w.w);
      let list = this.byText.get(k);
      if (!list) this.byText.set(k, (list = []));
      list.push(w);
    }
  }

  lookup(ref: string): number {
    const m = WORD.exec(ref);
    if (!m) throw new TimeError(`bad word reference ${JSON.stringify(ref)} (use word:so, word:use#2, word:so.end)`);
    const text = m[1]!;
    const n = Number(m[2] ?? 1);
    const hits = this.byText.get(normWord(text)) ?? [];
    if (hits.length < n) throw new TimeError(`${JSON.stringify(ref)}: the transcript says "${text}" only ${hits.length} time(s)`);
    const w = hits[n - 1]!;
    return m[3] ? w.e : w.s;
  }

  get end(): number {
    const last = this.words[this.words.length - 1];
    if (!last) throw new TimeError('words_end: the transcript is empty');
    return last.e;
  }
}

export interface TimeScope {
  words?: WordIndex;
  /** Anchors, section .start/.end, timeline_end, and clip-local terms. */
  names: ReadonlyMap<string, number> | ((name: string) => number | undefined);
}

export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Evaluate a time expression. Throws TimeError with a readable message. */
export function evalTime(expr: TimeExpr, scope: TimeScope): number {
  if (typeof expr === 'number') return expr;
  const parts = expr.trim().split(OP);
  let total = 0;
  let sign = 1;
  parts.forEach((tok, i) => {
    if (i % 2) {
      sign = tok === '+' ? 1 : -1;
      return;
    }
    total += sign * term(tok, scope);
  });
  return round4(total);
}

function term(tok: string, scope: TimeScope): number {
  if (NUMBER.test(tok)) return Number(tok);
  if (tok.startsWith('word:')) {
    if (!scope.words) throw new TimeError(`${tok}: this project has no transcript`);
    return scope.words.lookup(tok);
  }
  const v = typeof scope.names === 'function' ? scope.names(tok) : scope.names.get(tok);
  if (v !== undefined) return v;
  if (tok === 'words_end') {
    if (!scope.words) throw new TimeError('words_end: this project has no transcript');
    return scope.words.end;
  }
  throw new TimeError(`unknown time term ${JSON.stringify(tok)}`);
}

/** Names (anchors, sections, timeline_end, start/dur) an expression refers to; for dependency checks. */
export function termsOf(expr: TimeExpr): string[] {
  if (typeof expr === 'number') return [];
  return expr
    .trim()
    .split(OP)
    .filter((_, i) => i % 2 === 0)
    .filter((t) => !NUMBER.test(t));
}

export function frameOf(t: number, fps: number): number {
  return Math.round(t * fps);
}

/** Parse a WhisperX words.tsv (start, end, score, word columns, tab separated, with a header). */
export function parseWordsTsv(text: string): Word[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines.shift()?.split('\t') ?? [];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new TimeError(`words.tsv has no "${name}" column`);
    return i;
  };
  const [si, ei, wi] = [col('start'), col('end'), col('word')];
  return lines.map((l, n) => {
    const f = l.split('\t');
    const s = Number(f[si]);
    const e = Number(f[ei]);
    if (!Number.isFinite(s) || !Number.isFinite(e)) throw new TimeError(`words.tsv line ${n + 2}: bad times`);
    return { w: f[wi] ?? '', s, e };
  });
}
