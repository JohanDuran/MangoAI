// The 50-minute benchmark (docs/DESIGN.md section 13): 2,000 clips, 8,000 words, word-anchored SFX and
// titles. Budgets are generous so slow CI machines pass; locally these run far under them.
import { describe, expect, it } from 'vitest';
import { formatJson } from '../src/io.js';
import { Editor } from '../src/ops.js';
import { resolveProject } from '../src/resolve.js';
import { emptyProject, validateProject, type Project } from '../src/schema.js';
import { WordIndex, type Word } from '../src/time.js';

const VOCAB = ['so', 'this', 'is', 'the', 'part', 'where', 'we', 'deploy', 'docker', 'claude', 'code', 'server', 'cache', 'key'];

function longProject(): { project: Project; words: WordIndex } {
  const words: Word[] = [];
  for (let i = 0; i < 8000; i++) words.push({ w: VOCAB[i % VOCAB.length]!, s: i * 0.375, e: i * 0.375 + 0.3 });
  const p = emptyProject({ width: 1920, height: 1080, title: '50-minute benchmark' });
  p.transcripts.voice = 'transcripts/narration.words.tsv';
  const cuts = 1500;
  const len = 3000 / cuts;
  p.tracks.push(
    {
      id: 'V1', kind: 'video',
      clips: Array.from({ length: cuts }, (_, i) => ({ id: `cut${i}`, type: 'media' as const, src: 'rec.mkv', start: i * len, end: (i + 1) * len, in: i * len * 1.1 })),
    },
    {
      id: 'G1', kind: 'graphics',
      clips: Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, type: 'title' as const, start: `word:docker#${i + 1}`, end: `word:docker#${i + 1} + 2`, text: `T${i}` })),
    },
    { id: 'A1', kind: 'audio', role: 'voice', clips: [{ id: 'voice', type: 'media', src: 'narration.wav', start: 0 }] },
    {
      id: 'A2', kind: 'audio', role: 'sfx',
      clips: Array.from({ length: 200 }, (_, i) => ({ id: `fx${i}`, type: 'media' as const, src: 'pop.wav', start: `word:cache#${i + 1} - 0.05`, pivot: 0.02 })),
    },
  );
  return { project: p, words: new WordIndex(words) };
}

const time = (fn: () => void) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('50-minute project', () => {
  it('builds, validates and serializes in budget', () => {
    const { project } = longProject();
    expect(project.tracks.reduce((n, t) => n + t.clips.length, 0)).toBe(2001);
    expect(time(() => expect(validateProject(project).ok).toBe(true))).toBeLessThan(500);
    const json = formatJson(project);
    // ~1 KB per clip or less, so saves stay instant and diffs readable
    expect(json.length / 2001).toBeLessThan(400);
  });

  it('resolves 2,000 clips against 8,000 words in budget', () => {
    const { project, words } = longProject();
    let r!: ReturnType<typeof resolveProject>;
    const ms = time(() => (r = resolveProject(project, { words })));
    expect(r.problems).toEqual([]);
    expect(r.clips.get('fx199')!.start).toBeCloseTo(words.lookup('word:cache#200') - 0.07, 4);
    expect(ms).toBeLessThan(100);
  });

  it('applies 1,000 single-clip edits (a long drag) in budget, with cheap undo', () => {
    const { project, words } = longProject();
    const e = new Editor(project, { words });
    const ms = time(() => {
      for (let i = 0; i < 1000; i++) e.apply([{ op: 'update_clip', id: 'fx100', set: { start: 1000 + i * 0.01 } }], { author: 'you' });
    });
    expect(ms).toBeLessThan(500);
    const undoMs = time(() => {
      while (e.canUndo) e.undo();
    });
    expect(undoMs).toBeLessThan(500);
    expect(e.clip('fx100')!.start).toBe('word:cache#101 - 0.05');
  });

  it('splits deep in a long timeline without touching other clips', () => {
    const { project, words } = longProject();
    const e = new Editor(project, { words });
    const c = e.resolve().clips.get('cut1200')!;
    const ms = time(() => e.apply([{ op: 'split_clip', id: 'cut1200', at: c.start + 1, newId: 'cut1200b' }], { author: 'you' }));
    expect(ms).toBeLessThan(150);
    expect(e.trackOf('cut1201')?.clips[1202]?.id).toBe('cut1201');
  });
});
