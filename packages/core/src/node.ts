// Node-only helpers (file system, ffprobe). The browser imports '@mangoai/core' and never this.
import path from 'node:path';
import fs from 'node:fs/promises';
import { importShortJson } from './import/shortJson.js';
import { loadWords, probeProjectMedia, readJson } from './io.js';
import { validateProject, type Project } from './schema.js';

export * from './io.js';

/** Import a short.json with its words and media lengths (so overlapping SFX get their own tracks). */
export async function importFolder(dir: string, file = path.join(dir, 'short.json')): Promise<Project> {
  const spec = await readJson(file);
  const words = await loadWords(dir, (spec.words as string) ?? 'transcripts/narration.words.tsv');
  const audio = (spec.audio ?? {}) as { sfx?: { file: string }[] };
  const durations = await probeProjectMedia(dir, (audio.sfx ?? []).map((s) => s.file));
  return importShortJson(spec, { ...(words && { words }), durations });
}

export type OpenedFrom = 'cut.json' | 'short.json';

/** Open a project folder: its cut.json, else its short.json imported in memory (nothing is written). */
export async function openFolder(dir: string): Promise<{ project: Project; from: OpenedFrom }> {
  const cut = path.join(dir, 'cut.json');
  try {
    await fs.access(cut);
    const v = validateProject(await readJson(cut));
    if (!v.ok) throw new Error(`cut.json is invalid:\n${v.problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`);
    return { project: v.project, from: 'cut.json' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const project = await importFolder(dir);
  const v = validateProject(JSON.parse(JSON.stringify(project)));
  if (!v.ok) throw new Error(`short.json imports to an invalid project:\n${v.problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`);
  return { project, from: 'short.json' };
}
