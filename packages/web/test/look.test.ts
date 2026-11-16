import { describe, expect, it } from 'vitest';
import { TimelineIndex } from '../src/engine/index';
import { captionGroups, cardGeometry, color, findGroup, keyed } from '../src/engine/look';
import { emptyProject, resolveProject } from '@mangoai/core';

describe('toolbox look, redone live', () => {
  it('eases zoom keys with smoothstep, holding before the first and after the last key', () => {
    const keys: [number, number, number, number][] = [[0, 1, 100, 100], [2, 2, 200, 300]];
    expect(keyed(keys, -1)).toEqual([1, 100, 100]);
    expect(keyed(keys, 1)).toEqual([1.5, 150, 200]);
    expect(keyed(keys, 0.5)[0]).toBeCloseTo(1 + 0.15625, 5);
    expect(keyed(keys, 5)).toEqual([2, 200, 300]);
  });

  it('places a card like build_shot(): centred, height from the crop aspect, zoom window clamped', () => {
    const g = cardGeometry([0, 0, 1920, 1080], 1000, 900, [[0, 2, 0, 0]], 0);
    expect(g).toMatchObject({ dx: 40, dw: 1000, dh: 562, dy: 619 });
    expect(g).toMatchObject({ sx: 0, sy: 0, sw: 960, sh: 540 }); // focus at the corner clamps inside the crop
  });

  it('groups captions like caption_events(): max words, or a break after punctuation', () => {
    const w = (s: number, word: string) => ({ w: word, s, e: s + 0.3 });
    const groups = captionGroups([w(0, 'So,'), w(1, 'this'), w(2, 'is'), w(3, 'the'), w(4, 'end.')], 6, 3);
    expect(groups.map((g) => g.words.map((x) => x.w).join(' '))).toEqual(['So,', 'this is the', 'end.']);
    expect(groups.map((g) => [g.start, g.end])).toEqual([[0, 1], [1, 4], [4, 6]]);
    expect(findGroup(groups, 3.9)?.words[0]?.w).toBe('this');
    expect(findGroup(groups, 7)).toBeNull();
  });

  it('reads the toolbox colour names and hex forms', () => {
    expect(color('yellow', '#000')).toBe('#FFD400');
    expect(color('0x141c28', '#000')).toBe('#141C28');
    expect(color('#3DDC84', '#000')).toBe('#3DDC84');
    expect(color('&H004D4DFF', '#000')).toBe('#FF4D4D');
  });

  it('finds the clips at a time on a 2,000-clip track quickly', () => {
    const p = emptyProject();
    p.tracks.push({ id: 'V1', kind: 'video', clips: Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, type: 'media' as const, src: 'x.mp4', start: i * 1.5, end: (i + 1) * 1.5 })) });
    const idx = new TimelineIndex(p, resolveProject(p));
    const tr = idx.tracks.get('V1')!;
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) tr.at((i * 0.29) % 3000);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(tr.at(1500.2).map((s) => s.id)).toEqual(['c1000']);
    expect(tr.query(10, 13).map((s) => s.id)).toEqual(['c6', 'c7', 'c8']);
  });
});
