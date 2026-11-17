import { describe, expect, it } from 'vitest';
import { Editor, OpError } from '../src/ops.js';
import { emptyProject, validateProject, type Project } from '../src/schema.js';

function sample(): Project {
  const p = emptyProject({ title: 'test' });
  p.tracks.push(
    { id: 'V1', kind: 'video', clips: [{ id: 'c1', type: 'media', src: 'rec.mp4', start: 0, end: 10, in: 5 }] },
    { id: 'V2', kind: 'video', clips: [] },
    { id: 'G1', kind: 'graphics', clips: [{ id: 't1', type: 'title', start: 1, end: 3, text: 'HELLO' }] },
    { id: 'A1', kind: 'audio', role: 'sfx', clips: [{ id: 's1', type: 'media', src: 'whoosh.wav', start: 2, pivot: 0.4 }] },
  );
  return p;
}

describe('Editor ops', () => {
  it('moves and changes clips, and undo/redo restore exactly', () => {
    const e = new Editor(sample());
    const before = structuredClone(e.project);
    const ch = e.apply(
      [
        { op: 'update_clip', id: 's1', set: { start: 2.3, gain: -6 } },
        { op: 'move_clip', id: 'c1', track: 'V2' },
        { op: 'update_clip', id: 't1', set: { text: 'HI', fs: 60 } },
      ],
      { author: 'you' },
    );
    expect(e.trackOf('c1')?.id).toBe('V2');
    expect(e.clip('s1')).toMatchObject({ start: 2.3, gain: -6 });
    expect(ch.summary[0]).toBe('changed media s1: start → 2.3, gain → -6');
    const after = structuredClone(e.project);
    e.undo();
    expect(e.project).toEqual(before);
    e.redo();
    expect(e.project).toEqual(after);
  });

  it('removes a field with null', () => {
    const e = new Editor(sample());
    e.apply([{ op: 'update_clip', id: 's1', set: { pivot: null } }], { author: 'claude' });
    expect(e.clip('s1')).not.toHaveProperty('pivot');
    e.undo();
    expect(e.clip('s1')).toHaveProperty('pivot', 0.4);
  });

  it('splits a media clip and carries the source in point', () => {
    const e = new Editor(sample());
    const before = structuredClone(e.project);
    e.apply([{ op: 'split_clip', id: 'c1', at: 4, newId: 'c1b' }], { author: 'you' });
    expect(e.clip('c1')).toMatchObject({ start: 0, end: 4, in: 5 });
    expect(e.clip('c1b')).toMatchObject({ start: 4, end: 10, in: 9 });
    expect(e.resolve().clips.get('c1b')).toMatchObject({ start: 4, end: 10, in: 9 });
    e.undo();
    expect(e.project).toEqual(before);
  });

  it('is all-or-nothing: a failing op rolls back the ones before it', () => {
    const e = new Editor(sample());
    const before = structuredClone(e.project);
    expect(() =>
      e.apply(
        [
          { op: 'update_clip', id: 'c1', set: { start: 1 } },
          { op: 'move_clip', id: 't1', track: 'A1' }, // a title can't go on an audio track
        ],
        { author: 'claude' },
      ),
    ).toThrow(OpError);
    expect(e.project).toEqual(before);
    expect(e.canUndo).toBe(false);
  });

  it('rejects invalid values and duplicate ids', () => {
    const e = new Editor(sample());
    expect(() => e.apply([{ op: 'update_clip', id: 'c1', set: { speed: -1 } }], { author: 'you' })).toThrow(/speed/);
    expect(() =>
      e.apply([{ op: 'add_clip', track: 'V2', clip: { id: 'c1', type: 'media', src: 'x', start: 0, end: 1 } }], { author: 'you' }),
    ).toThrow(/already used/);
    expect(() => e.apply([{ op: 'update_clip', id: 'c1', set: { type: 'title' } }], { author: 'you' })).toThrow(/can't be changed/);
  });

  it('adds and removes tracks, anchors and sections, staying valid', () => {
    const e = new Editor(sample());
    e.apply(
      [
        { op: 'add_track', track: { id: 'A2', kind: 'audio', role: 'music', clips: [] } },
        { op: 'set_anchor', name: 'hook', at: 'word:so - 0.1' },
        { op: 'add_section', section: { id: 's01', end: 'hook' } },
        { op: 'update_clip', id: 't1', set: { start: 's01.start', end: 's01.end' } },
        { op: 'remove_track', id: 'V2' },
        { op: 'set_title', title: 'renamed' },
      ],
      { author: 'claude', label: 'structure' },
    );
    expect(validateProject(e.project).ok).toBe(true);
    e.undo();
    expect(e.project).toEqual(sample());
  });

  it('registers a transcript and undoes it exactly', () => {
    const e = new Editor(sample());
    const before = structuredClone(e.project);
    e.apply([{ op: 'set_transcript', name: 'rec', file: 'transcripts/rec.words.tsv' }], { author: 'you' });
    expect(e.project.transcripts.rec).toBe('transcripts/rec.words.tsv');
    expect(validateProject(e.project).ok).toBe(true);
    e.undo();
    expect(e.project).toEqual(before);
    expect(() => e.apply([{ op: 'set_transcript', name: 'bad name', file: 'x.tsv' }], { author: 'you' })).toThrow(/transcript name/);
  });

  it('resolve() is cached until the next change', () => {
    const e = new Editor(sample());
    const r1 = e.resolve();
    expect(e.resolve()).toBe(r1);
    e.apply([{ op: 'update_clip', id: 't1', set: { end: 4 } }], { author: 'you' });
    expect(e.resolve()).not.toBe(r1);
    expect(e.resolve().clips.get('t1')?.end).toBe(4);
    expect(e.resolve().clips.get('s1')?.start).toBeCloseTo(1.6);
  });
});
