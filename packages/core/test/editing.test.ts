import { describe, expect, it } from 'vitest';
import {
  cutRanges,
  Editor,
  emptyProject,
  fillers,
  linkTime,
  moveClips,
  pauses,
  rippleDelete,
  rippleDeleteClips,
  shiftExpr,
  splitAt,
  trimClip,
  WordIndex,
  type Clip,
  type Project,
  type Word,
} from '../src/index.js';

const words: Word[] = [
  { w: 'So', s: 0.5, e: 0.8 },
  { w: 'this', s: 0.9, e: 1.2 },
  { w: 'um', s: 1.3, e: 1.6 },
  { w: 'is', s: 2.8, e: 3.0 },
  { w: 'it.', s: 3.1, e: 3.5 },
];

function project(): Project {
  const p = emptyProject({ title: 't' });
  p.transcripts = { voice: 'w.tsv' };
  p.sections = [
    { id: 's1', end: 2 },
    { id: 's2', end: 5 },
  ];
  p.tracks = [
    { id: 'V1', kind: 'video', clips: [{ id: 'bg', type: 'generator', generator: 'color', params: {}, start: 0, end: 'timeline_end' }] },
    {
      id: 'V2',
      kind: 'video',
      clips: [
        { id: 'a', type: 'media', src: 'rec.mp4', start: 's1.start', end: 's1.end' },
        { id: 'b', type: 'media', src: 'rec.mp4', in: 10, start: 's2.start', end: 's2.end' },
      ],
    },
    { id: 'G1', kind: 'graphics', clips: [{ id: 't', type: 'title', text: 'hi', start: 'word:this', end: 'word:it.end' }] },
    { id: 'A1', kind: 'audio', role: 'voice', clips: [{ id: 'voice', type: 'media', src: 'n.wav', start: 0, transcript: 'voice' }] },
    { id: 'A2', kind: 'audio', role: 'sfx', clips: [{ id: 'hit', type: 'media', src: 'w.wav', start: 'word:is', pivot: 0.2, end: 'word:is + 0.8' }] },
  ];
  return p;
}

const durations = new Map([
  ['rec.mp4', 60],
  ['n.wav', 5],
  ['w.wav', 1],
]);
const editor = () => new Editor(project(), { words: new WordIndex(words), durations, transcripts: { voice: words } });

describe('shiftExpr', () => {
  it('keeps links and folds offsets', () => {
    expect(shiftExpr(2.5, 0.3)).toBe(2.8);
    expect(shiftExpr('word:so', 0.3)).toBe('word:so + 0.3');
    expect(shiftExpr('s02.start + 0.5', 0.3)).toBe('s02.start + 0.8');
    expect(shiftExpr('s02.start + 0.5', -0.5)).toBe('s02.start');
    expect(shiftExpr('a - 0.2', -0.1)).toBe('a - 0.3');
    expect(shiftExpr('4', 1)).toBe(5);
  });
});

describe('commands', () => {
  it('moves a linked clip by offsetting its expressions', () => {
    const ed = editor();
    ed.apply(moveClips(ed, ['t'], 0.25), { author: 'you' });
    expect(ed.clip('t')!.start).toBe('word:this + 0.25');
    expect(ed.resolve().clips.get('t')!.start).toBeCloseTo(1.15);
  });

  it('trims the head of a media clip and moves its in point', () => {
    const ed = editor();
    ed.apply(trimClip(ed, 'b', 'start', 2.5), { author: 'you' });
    const c = ed.clip('b') as Extract<Clip, { type: 'media' }>;
    expect(c.start).toBe('s2.start + 0.5');
    expect(c.in).toBe(10.5);
  });

  it('trimming an SFX head keeps its hit on the word', () => {
    const ed = editor();
    const before = ed.resolve().clips.get('hit')!;
    ed.apply(trimClip(ed, 'hit', 'start', before.start + 0.1), { author: 'you' });
    const c = ed.clip('hit')!;
    expect(c.start).toBe('word:is');
    expect(c.pivot).toBe(0.1);
    expect(ed.resolve().clips.get('hit')!.start + c.pivot!).toBeCloseTo(2.8);
  });

  it('splits everything under the playhead and undoes as one change', () => {
    const ed = editor();
    const n = ed.project.tracks.reduce((x, t) => x + t.clips.length, 0);
    ed.apply(splitAt(ed, 3), { author: 'you' });
    expect(ed.project.tracks.reduce((x, t) => x + t.clips.length, 0)).toBeGreaterThan(n);
    ed.undo();
    expect(ed.project.tracks.reduce((x, t) => x + t.clips.length, 0)).toBe(n);
  });

  it('ripple-deletes a range on every track, sections and words follow', () => {
    const ed = editor();
    ed.apply(rippleDelete(ed, 1.3, 2.8, null), { author: 'you' });
    const r = ed.resolve();
    expect(r.end).toBeCloseTo(3.5);
    expect(r.sections[0]!.t1).toBeCloseTo(1.3);
    // the voice was cut and closed up: "is" now heard at 1.3, and what's linked to it moved too
    const is = r.words.find((w) => w.w === 'is')!;
    expect(is.s).toBeCloseTo(1.3);
    expect(r.words.some((w) => w.w === 'um')).toBe(false);
    expect(r.clips.get('hit')!.start + 0.2).toBeCloseTo(1.3);
    // b was cut at 2.8: its first part went with the cut, the rest starts where s2 now starts
    expect(ed.clip('b')).toBeUndefined();
    expect(r.clips.get('b.split1')!.start).toBeCloseTo(1.3);
    expect(r.clips.get('b.split1')!.in).toBeCloseTo(10.8);
    // the title linked to words keeps its words: from "this" (0.9) to "it." end, now 2.0
    expect(r.clips.get('t')!.start).toBeCloseTo(0.9);
    expect(ed.clip('t')!.start).toBe('word:this');
    ed.undo();
    expect(ed.resolve().end).toBeCloseTo(5);
  });

  it('ripple-deletes one clip on its own track only', () => {
    const ed = editor();
    ed.apply(rippleDeleteClips(ed, ['a']), { author: 'you' });
    const r = ed.resolve();
    expect(ed.clip('a')).toBeUndefined();
    expect(r.clips.get('b')!.start).toBeCloseTo(0);
    expect(r.sections[1]!.t0).toBeCloseTo(2); // other tracks and sections stay
  });

  it('links a start to a word, keeping it in place', () => {
    const ed = editor();
    ed.apply(moveClips(ed, ['bg'], 0.95), { author: 'you' });
    ed.apply(linkTime(ed, 'bg', 'start', 'word:this'), { author: 'you' });
    expect(ed.clip('bg')!.start).toBe('word:this + 0.05');
  });

  it('pauses and fillers become cuts', () => {
    expect(pauses(words, 0.8)).toEqual([[1.75, 2.65]]);
    expect(fillers(words)).toEqual([[1.3, 1.9]]);
    const ed = editor();
    ed.apply(cutRanges(ed, [...fillers(words), ...pauses(words)]), { author: 'you' });
    expect(ed.resolve().words.map((w) => w.w)).toEqual(['So', 'this', 'is', 'it.']);
  });
});

describe('saving and rebasing', () => {
  it('knows what is unsaved, including undoing past a save', () => {
    const ed = editor();
    ed.markSaved();
    expect(ed.dirty).toBe(false);
    ed.apply(moveClips(ed, ['t'], 0.1), { author: 'you' });
    expect(ed.unsaved()).toHaveLength(1);
    ed.markSaved();
    ed.undo();
    expect(ed.unsaved()[0]!.label).toMatch(/^undo: /);
  });

  it("puts Claude's saved change under your unsaved edits", () => {
    const ed = editor();
    ed.markSaved();
    ed.apply(moveClips(ed, ['t'], 0.1), { author: 'you', label: 'mine' });
    const { dropped } = ed.rebase([{ op: 'update_clip', id: 'b', set: { label: 'from claude' } }], { author: 'claude' });
    expect(dropped).toHaveLength(0);
    expect(ed.clip('b')!.label).toBe('from claude');
    expect(ed.clip('t')!.start).toBe('word:this + 0.1');
    expect(ed.unsaved().map((c) => c.label)).toEqual(['mine']);
  });

  it('keeps out your edits that no longer fit', () => {
    const ed = editor();
    ed.markSaved();
    ed.apply(moveClips(ed, ['t'], 0.1), { author: 'you', label: 'move t' });
    const { dropped } = ed.rebase([{ op: 'remove_clip', id: 't' }], { author: 'claude' });
    expect(dropped.map((c) => c.label)).toEqual(['move t']);
    expect(ed.dirty).toBe(false);
  });
});

describe('comp variables', () => {
  it('turns "@" time expressions into seconds from the clip start', () => {
    const p = project();
    p.tracks[2]!.clips.push({ id: 'c', type: 'comp', comp: 'animations/x', start: 2, end: 5, vars: { at: '@word:it', title: 'Hello', n: 3 } });
    const ed = new Editor(p, { words: new WordIndex(words), durations, transcripts: { voice: words } });
    expect(ed.resolve().clips.get('c')!.vars).toEqual({ at: 1.1, title: 'Hello', n: 3 });
  });
});
