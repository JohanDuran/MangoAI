import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportShortJson, importShortJson } from '../src/import/shortJson.js';
import { formatJson } from '../src/io.js';
import { resolveProject } from '../src/resolve.js';
import { validateProject, type Project } from '../src/schema.js';
import { parseWordsTsv, WordIndex } from '../src/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => {
  const dir = path.join(here, 'fixtures', name);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'short.json'), 'utf-8')) as Record<string, unknown>;
  const words = new WordIndex(parseWordsTsv(fs.readFileSync(path.join(dir, 'transcripts/narration.words.tsv'), 'utf-8')));
  return { spec, words };
};

describe('short.json import/export', () => {
  for (const name of ['railway', 'border07']) {
    it(`${name}: round-trips exactly through the cut.json file format`, () => {
      const { spec, words } = fixture(name);
      const project = importShortJson(structuredClone(spec), { words });
      expect(validateProject(JSON.parse(JSON.stringify(project))).ok).toBe(true);
      const reread = JSON.parse(formatJson(project)) as Project;
      expect(exportShortJson(reread)).toEqual(spec);
      // key order is kept too, so a written-back short.json diffs cleanly
      expect(Object.keys(exportShortJson(reread))).toEqual(Object.keys(spec));
    });
  }

  it('resolves shots to the same times as the media-toolbox (Border_Wars_07, from short_info)', () => {
    const { spec, words } = fixture('border07');
    const r = resolveProject(importShortJson(spec, { words }), { words });
    const toolbox: [string, number, number][] = [
      ['s01_map', 0, 4.21], ['s02_tx1', 4.21, 5.62], ['s03_ar1', 5.62, 7.25], ['s04_split', 7.25, 8.41],
      ['s05_rules', 8.41, 12.98], ['s06_city', 12.98, 17.62], ['s07_bw', 17.62, 20.31], ['s08_tx', 20.31, 24.81],
      ['s09_tx2', 24.81, 27.39], ['s10_ar', 27.39, 31.03], ['s11_ar2', 31.03, 34.34], ['s12_inc', 34.34, 38.33],
      ['s13_prop', 38.33, 43.22], ['s14_arprop', 43.22, 47.07], ['s15_sales', 47.07, 52.5], ['s16_catchup', 52.5, 57.09],
      ['s17_compare', 57.09, 79.15], ['s18_loop', 79.15, 79.5],
    ];
    expect(r.sections.map((s) => [s.id, round2(s.t0), round2(s.t1)])).toEqual(toolbox);
    expect(round2(r.end)).toBe(79.5);
    expect(r.anchors.get('compare')).toBeCloseTo(57.09, 2);
  });

  it('flags a graphic that ends before it starts (real bug in Border_Wars_07: "JUST $100 MORE")', () => {
    const { spec, words } = fixture('border07');
    const r = resolveProject(importShortJson(spec, { words }), { words });
    expect(r.problems.map((p) => p.message)).toEqual(['clip g31 ends before it starts']);
  });

  it('lays tracks out like an NLE: backdrop, shots, titles, captions, voice, SFX, music', () => {
    const { spec, words } = fixture('railway');
    const p = importShortJson(spec, { words });
    expect(p.tracks.map((t) => `${t.id}:${t.kind}${t.role ? '/' + t.role : ''}`)).toEqual([
      'V1:video', 'V2:video', 'C1:captions', 'A1:audio/voice', 'A2:audio/sfx', 'A9:audio/music',
    ]);
    const sfx = p.tracks.find((t) => t.role === 'sfx')!;
    expect(sfx.clips).toHaveLength(1 + 3 + 5 + 12 + 1);
    expect(sfx.clips[0]).toMatchObject({ type: 'media', pivot: 0.155, start: 1.6, gain: -12 });
  });

  it('spreads overlapping SFX over several tracks when media lengths are known', () => {
    const { spec, words } = fixture('railway');
    const durations = new Map<string, number>();
    for (const fx of (spec.audio as { sfx: { file: string }[] }).sfx) durations.set(fx.file, 2.0);
    const p = importShortJson(spec, { words, durations });
    const lanes = p.tracks.filter((t) => t.role === 'sfx');
    expect(lanes.length).toBeGreaterThan(1);
    const r = resolveProject(p, { words, durations });
    for (const t of lanes) {
      const spans = t.clips.map((c) => r.clips.get(c.id)!).sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end!);
    }
    expect(exportShortJson(p)).toEqual(spec);
  });

  it('keeps fields it does not model', () => {
    const spec = {
      version: 1, title: 't', words: 'w.tsv', sources: {}, anchors: {}, future: { a: 1 },
      shots: [{ name: 's1', end: 2, note: '', layers: [{ src: 'x.png', still: true, region: [0, 0, 10, 10], card_w: 1080, cy: 900, wobble: 3 }] }],
      graphics: [{ start: 0, end: 1, style: 'Head', pos: [1, 2], text: 'hi', glow: true }],
      captions: { y: 1, max_words: 3, enabled: false },
      audio: { narration: 'n.wav', music: 'm.wav', music_db: -20, sfx: [], ducking: 'auto' },
      backdrop: { image: 'bg.png' },
      outputs: { shots: 'edit/shots' },
    };
    expect(exportShortJson(importShortJson(structuredClone(spec)))).toEqual(spec);
  });
});

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
