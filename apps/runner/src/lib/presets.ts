import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_ROOT, markerFile } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';
import { findMarker, type MarkerRegion } from './markers.js';
import { readProject } from './scaffold.js';

// Style presets: a finished marker's look, saved so later markers (in any project) can match it.
// A preset keeps a copy of the marker's code, which Claude gets as a style reference (palette, fonts,
// sizes, motion), and the marker's area, which can be applied to another marker. Presets live beside
// the projects in a folder whose name is not a valid project id, so it is never listed as one.

export interface StylePreset {
  id: string;
  name: string;
  createdAt: string;
  // Where it was saved from, for showing.
  fromProject: string;
  // The area of the marker it was saved from; absent for full screen.
  region?: MarkerRegion;
  // The marker's code when it was saved.
  code: string;
}

export type PresetSummary = Omit<StylePreset, 'code'>;

const PRESET_ID = /^p-[0-9a-f]{8}$/;
const presetsDir = () => path.join(PROJECTS_ROOT, '.presets');
const presetFile = (presetId: string) => path.join(presetsDir(), `${presetId}.json`);

export const isPresetId = (v: unknown): v is string => typeof v === 'string' && PRESET_ID.test(v);

export function readPreset(presetId: string): StylePreset | null {
  if (!isPresetId(presetId)) return null;
  const file = presetFile(presetId);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson<StylePreset>(file);
  } catch {
    return null;
  }
}

export function listPresets(): PresetSummary[] {
  if (!fs.existsSync(presetsDir())) return [];
  return fs
    .readdirSync(presetsDir())
    .filter((f) => f.endsWith('.json') && PRESET_ID.test(f.slice(0, -5)))
    .map((f) => readPreset(f.slice(0, -5)))
    .filter((p): p is StylePreset => p !== null)
    .map(({ code: _code, ...summary }) => summary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Saves a generated marker's look as a new preset.
export function savePreset(projectId: string, markerId: string, name: string): PresetSummary {
  const marker = findMarker(projectId, markerId);
  if (marker.status !== 'ready') throw new Error('Only a generated marker can be saved as a style. Generate it first.');
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) throw new Error('Give the style a name.');
  const preset: StylePreset = {
    id: `p-${crypto.randomBytes(4).toString('hex')}`,
    name: trimmed,
    createdAt: new Date().toISOString(),
    fromProject: readProject(projectId)?.name ?? projectId,
    ...(marker.region && { region: marker.region }),
    code: fs.readFileSync(markerFile(projectId, markerId), 'utf-8'),
  };
  fs.mkdirSync(presetsDir(), { recursive: true });
  writeJsonAtomic(presetFile(preset.id), preset);
  const { code: _code, ...summary } = preset;
  return summary;
}

// Deleting a preset leaves markers that used it alone; they simply have no style reference any more.
export function deletePreset(presetId: string): boolean {
  if (!isPresetId(presetId)) return false;
  const file = presetFile(presetId);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
  return true;
}
