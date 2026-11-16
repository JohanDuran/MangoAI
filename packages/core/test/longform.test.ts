// Long-form editing at 50-minute scale: a recording cut into many clips, its transcript mapped through
// them, and transcript cuts (ripple on every track) — all must stay interactive.
import { describe, expect, it } from 'vitest';
import { cutRanges, Editor, emptyProject, pauses, rippleDelete, type Clip, type Word } from '../src/index.js';

function longProject() {
  const words: Word[] = [];
  let t = 0.3;
  for (let i = 0; i < 8000; i++) {
    const d = 0.18 + (i % 7) * 0.03;
    words.push({ w: `w${i % 400}${i % 13 === 12 ? '.' : ''}`, s: +t.toFixed(3), e: +(t + d).toFixed(3) });
    t += d + (i % 50 === 49 ? 1.2 : 0.08);
  }
  const p = emptyProject({ width: 1920, height: 1080, title: 'long' });
  p.transcripts = { rec: 'rec.words.tsv' };
  const video: Clip[] = [];
  const audio: Clip[] = [];
  // 900 pieces of one 3,000 s recording, back to back on the timeline
  let at = 0;
  for (let i = 0; i < 900; i++) {
    const inPt = i * 3.3;
    const len = 3;
    video.push({ id: `v${i}`, type: 'media', src: 'rec.mp4', in: inPt, start: +at.toFixed(4), end: +(at + len).toFixed(4), transcript: 'rec' });
    audio.push({ id: `a${i}`, type: 'media', src: 'rec.mp4', in: inPt, start: +at.toFixed(4), end: +(at + len).toFixed(4), transcript: 'rec' });
    at += len;
  }
  p.tracks = [
    { id: 'V1', kind: 'video', clips: video },
    { id: 'A1', kind: 'audio', role: 'voice', clips: audio },
  ];
  return { p, words };
}

describe('long-form at 50 minutes', () => {
  it('maps the transcript through 900 clips quickly', () => {
    const { p, words } = longProject();
    const ed = new Editor(p, { durations: new Map([['rec.mp4', 3000]]), transcripts: { rec: words } });
    const t0 = performance.now();
    const r = ed.resolve();
    const ms = performance.now() - t0;
    expect(r.words.length).toBeGreaterThan(5000);
    expect(r.end).toBeCloseTo(2700);
    expect(ms).toBeLessThan(400);
  });

  it('cuts a range on every track and closes the gap, interactively', () => {
    const { p, words } = longProject();
    const ed = new Editor(p, { durations: new Map([['rec.mp4', 3000]]), transcripts: { rec: words } });
    const t0 = performance.now();
    ed.apply(rippleDelete(ed, 1200.5, 1210.25, null), { author: 'you' });
    const ms = performance.now() - t0;
    expect(ed.resolve().end).toBeCloseTo(2690.25);
    expect(ms).toBeLessThan(2000);
  });

  it('cuts every long pause in one change', () => {
    const { p, words } = longProject();
    const ed = new Editor(p, { durations: new Map([['rec.mp4', 3000]]), transcripts: { rec: words } });
    const ranges = pauses(ed.resolve().words, 0.8).slice(0, 25);
    const t0 = performance.now();
    ed.apply(cutRanges(ed, ranges), { author: 'you' });
    const ms = performance.now() - t0;
    const removed = ranges.reduce((n, [a, b]) => n + b - a, 0);
    expect(ed.resolve().end).toBeCloseTo(2700 - removed, 1);
    console.log(`25 pause cuts on 900+900 clips: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  });
});
