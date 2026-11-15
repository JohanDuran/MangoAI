import { describe, expect, it } from 'vitest';
import { evalTime, normWord, parseWordsTsv, termsOf, TimeError, WordIndex } from '../src/time.js';

const words = new WordIndex([
  { w: 'So,', s: 0.1, e: 0.3 },
  { w: 'use', s: 0.5, e: 0.7 },
  { w: 'this', s: 1.0, e: 1.2 },
  { w: 'USE', s: 2.0, e: 2.25 },
  { w: "don't", s: 3.0, e: 3.4 },
]);
const scope = (names: Record<string, number> = {}) => ({ words, names: new Map(Object.entries(names)) });

describe('time expressions (toolbox-compatible)', () => {
  it('reads numbers and numeric strings', () => {
    expect(evalTime(1.5, scope())).toBe(1.5);
    expect(evalTime('31.10', scope())).toBe(31.1);
    expect(evalTime('-0.5', scope())).toBe(-0.5);
  });

  it('finds words by occurrence, start or end, ignoring case and punctuation', () => {
    expect(evalTime('word:so', scope())).toBe(0.1);
    expect(evalTime('word:use#2', scope())).toBe(2.0);
    expect(evalTime('word:use#2.end', scope())).toBe(2.25);
    expect(evalTime("word:don't", scope())).toBe(3.0);
  });

  it('adds and subtracts terms, rounding to 4 decimals', () => {
    expect(evalTime('word:this - 0.06', scope())).toBe(0.94);
    expect(evalTime('chat + 0.1 - 0.05', scope({ chat: 1 }))).toBe(1.05);
    expect(evalTime('words_end + 0.9', scope())).toBe(4.3);
  });

  it('reports useful errors', () => {
    expect(() => evalTime('word:use#3', scope())).toThrow(/only 2 time/);
    expect(() => evalTime('nope', scope())).toThrow(TimeError);
    expect(() => evalTime('word:', scope())).toThrow(/bad word reference/);
  });

  it('lists the names an expression depends on', () => {
    expect(termsOf('s01.end - 0.2 + word:so')).toEqual(['s01.end', 'word:so']);
  });

  it('normalizes like the toolbox', () => {
    expect(normWord('“Hello,”')).toBe('hello');
    expect(normWord('built-on')).toBe('built-on');
    expect(normWord('Ñandú!')).toBe('ñandú');
  });

  it('parses words.tsv with a BOM and CRLF', () => {
    const w = parseWordsTsv('﻿start\tend\tscore\tword\r\n0.05\t0.43\t0.84\tSomeone\r\n0.47\t0.65\t0.8\tjust\r\n');
    expect(w).toEqual([
      { w: 'Someone', s: 0.05, e: 0.43 },
      { w: 'just', s: 0.47, e: 0.65 },
    ]);
  });
});
