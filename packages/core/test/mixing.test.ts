import { describe, expect, it } from 'vitest';
import { checkProject } from '../src/checks.js';
import { duckAmount, duckExpr, gainKeyAt, gainKeysExpr, speechSpans } from '../src/mixing.js';
import { Editor } from '../src/ops.js';
import { emptyProject, type Project } from '../src/schema.js';
import { WordIndex } from '../src/time.js';

function project(): Project {
  const p = emptyProject();
  p.tracks.push(
    { id: 'V1', kind: 'video', clips: [{ id: 'v', type: 'media', src: 'a.mp4', start: 1, end: 10 }] },
    { id: 'A1', kind: 'audio', role: 'voice', clips: [{ id: 'voice', type: 'media', src: 'n.wav', start: 0, end: 10 }] },
    { id: 'A2', kind: 'audio', role: 'music', duck: -10, clips: [{ id: 'm', type: 'media', src: 'm.wav', start: 0, end: 10 }] },
  );
  return p;
}

describe('mixing', () => {
  it('joins close words into phrases and ducks with ramps', () => {
    const words = new WordIndex([
      { w: 'one', s: 1, e: 1.3 },
      { w: 'two', s: 1.5, e: 1.8 },
      { w: 'three', s: 4, e: 4.4 },
    ]);
    const e = new Editor(project(), { words });
    const spans = speechSpans(e.project, e.resolve());
    expect(spans).toEqual([
      [1, 1.8],
      [4, 4.4],
    ]);
    expect(duckAmount(spans, 0)).toBe(0);
    expect(duckAmount(spans, 1.5)).toBe(1);
    expect(duckAmount(spans, 1.8 + 0.35 / 2)).toBeCloseTo(0.5);
    expect(duckAmount(spans, 3)).toBe(0);
    expect(duckExpr(spans, -10)).toContain('clip(');
    expect(duckExpr([], -10)).toBe('1');
  });

  it('interpolates gain keys', () => {
    const k: [number, number][] = [
      [0, 0],
      [2, -20],
    ];
    expect(gainKeyAt(k, -1)).toBe(0);
    expect(gainKeyAt(k, 1)).toBe(-10);
    expect(gainKeyAt(k, 5)).toBe(-20);
    expect(gainKeyAt(undefined, 1)).toBe(0);
    expect(gainKeysExpr(k)).toMatch(/^pow\(10,/);
  });

  it('sets and clears the master loudness, undoably', () => {
    const e = new Editor(project());
    e.apply([{ op: 'set_master', set: { loudness: -16 } }], { author: 'you' });
    expect(e.project.master).toEqual({ loudness: -16 });
    e.undo();
    expect(e.project.master).toBeUndefined();
  });
});

describe('checks', () => {
  it('finds black gaps, missing files and open requests', () => {
    const p = project();
    p.requests = [{ id: 'r1', kind: 'create', status: 'open', text: 'logo', t: 2, created: '2026-01-01T00:00:00Z' }];
    const e = new Editor(p);
    const out = checkProject(e.project, e.resolve(), { missing: new Set(['a.mp4']) });
    const text = out.map((c) => c.message).join('\n');
    expect(text).toContain('black at 0.00 s');
    expect(text).toContain('Missing file a.mp4');
    expect(text).toContain('Request r1');
  });
});
