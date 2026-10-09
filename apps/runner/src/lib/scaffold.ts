import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_ROOT, TEMPLATES_ROOT, SAFE_ID, projectDir, markerFile } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';
import { readMarkers, writeMarkers, type Marker, type MarkerRegion } from './markers.js';
import { regenerateRegistry } from './registry.js';
import { defaultSkillNames } from './skills.js';
import { DEFAULT_BASE_LAYER, type BaseLayer } from './baseLayer.js';
import type { CaptionSettings } from './captions.js';
import type { MusicSettings } from './music.js';

// Bump when the on-disk project layout changes and add a step to migrate.ts.
export const CURRENT_SCHEMA_VERSION = 1;

export interface Project {
  id: string;
  // Absent on projects created before versioning existed (treated as 0 by the migrations).
  schemaVersion?: number;
  name: string;
  createdAt: string;
  // Skills enabled for this project. Absent on projects created before skills existed, which
  // get the built-in defaults.
  skills?: string[];
  // Volume of sounds played by the overlay animations, 0 (muted) to 1. Absent means 1.
  overlayVolume?: number;
  // Volume of the markers' voiceover, 0 (muted) to 1. Absent means 1.
  voiceVolume?: number;
  // The voice last picked for a voiceover, used for new lines (and lines from a plan).
  voice?: string;
  // Describe newly uploaded images with Claude automatically (costs a small Claude call each).
  autoDescribeImages?: boolean;
  // What the timeline is built on top of. Absent means 'video' (projects created before this
  // existed always expect an uploaded raw video).
  baseLayer?: BaseLayer;
  // Caption settings (see captions.ts). Absent means captions are off.
  captions?: CaptionSettings;
  // Background music (see music.ts). Absent means none.
  music?: MusicSettings;
  // The style preset new markers start with (see presets.ts).
  stylePreset?: string;
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'project';

export interface CreateProjectOptions {
  baseLayer?: BaseLayer;
  fps?: number;
  width?: number;
  height?: number;
  durationInFrames?: number;
}

export function createProject(name: string, opts: CreateProjectOptions = {}): Project {
  const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = projectDir(id);

  for (const sub of ['00_input', '01_transcript', '02_assets', '03_remotion_code', '04_output', '05_debug/code_history']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  const baseLayer = opts.baseLayer ?? DEFAULT_BASE_LAYER;
  const project: Project = {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name,
    createdAt: new Date().toISOString(),
    skills: defaultSkillNames(),
    ...(baseLayer.type !== 'video' ? { baseLayer } : {}),
  };
  writeJsonAtomic(path.join(dir, 'project.json'), project);
  fs.copyFileSync(path.join(TEMPLATES_ROOT, 'CLAUDE.md'), path.join(dir, 'CLAUDE.md'));

  fs.writeFileSync(path.join(dir, '00_input', 'markers.json'), '[]\n');
  fs.writeFileSync(path.join(dir, '00_input', 'preview_state.json'), '{}\n');
  fs.writeFileSync(path.join(dir, '01_transcript', 'transcript.json'), JSON.stringify({ segments: [] }, null, 2));
  fs.writeFileSync(path.join(dir, '02_assets', 'asset_manifest.json'), '[]\n');
  fs.writeFileSync(
    path.join(dir, '03_remotion_code', 'CompositionConfig.json'),
    JSON.stringify(
      {
        fps: opts.fps ?? 30,
        width: opts.width ?? 1920,
        height: opts.height ?? 1080,
        durationInFrames: opts.durationInFrames ?? 1800,
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, '05_debug', 'errors.json'), '[]\n');
  fs.writeFileSync(path.join(dir, '05_debug', 'failed_attempts.log'), '');

  regenerateRegistry(id);
  return project;
}

export function listProjects(): Project[] {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SAFE_ID.test(d.name))
    .map((d) => readProject(d.name))
    .filter((p): p is Project => p !== null);
}

export function readProject(id: string): Project | null {
  const file = path.join(projectDir(id), 'project.json');
  if (!fs.existsSync(file)) return null;
  return readJson<Project>(file);
}

export function writeProject(project: Project): void {
  writeJsonAtomic(path.join(projectDir(project.id), 'project.json'), project);
}

export function addMarker(id: string, input: { start: number; end: number; prompt: string; region?: MarkerRegion; assets?: string[] }): Marker {
  const markers = readMarkers(id);
  const projectStyle = readProject(id)?.stylePreset;
  // Based on the highest existing numeric suffix, not the array length — deleting a
  // marker must not free up its id for reuse (it may still be referenced in
  // 05_debug/code_history, and reusing it would confuse "which generation is this").
  const maxNum = markers.reduce((max, m) => {
    const n = Number(/^m(\d+)$/.exec(m.marker_id)?.[1]);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  const marker: Marker = {
    marker_id: `m${maxNum + 1}`,
    start: input.start,
    end: input.end,
    prompt: input.prompt,
    feedback: '',
    status: 'draft',
    ...(input.region ? { region: input.region } : {}),
    ...(input.assets && input.assets.length > 0 ? { assets: input.assets } : {}),
    // New markers start with the project's style, so a whole video looks consistent.
    ...(projectStyle ? { stylePreset: projectStyle } : {}),
  };
  markers.push(marker);
  writeMarkers(id, markers);

  const tmpl = fs.readFileSync(path.join(TEMPLATES_ROOT, 'marker.tsx.tmpl'), 'utf-8');
  const content = tmpl
    .replace(/__EXPORT_NAME__/g, `Marker_${marker.marker_id}`)
    .replace(/__PROMPT__/g, marker.prompt.replace(/[`${}]/g, ''));
  fs.writeFileSync(markerFile(id, marker.marker_id), content);

  regenerateRegistry(id);
  return marker;
}

export function enabledSkillNames(id: string): string[] {
  return readProject(id)?.skills ?? defaultSkillNames();
}

export function setProjectSkills(id: string, skills: string[]): Project {
  const project = readProject(id);
  if (!project) throw new Error(`Project ${id} not found`);
  const next: Project = { ...project, skills };
  writeProject(next);
  return next;
}

export function setAutoDescribeImages(id: string, value: boolean): Project {
  const project = readProject(id);
  if (!project) throw new Error(`Project ${id} not found`);
  const next: Project = { ...project, autoDescribeImages: value };
  writeProject(next);
  return next;
}

export function overlayVolume(id: string): number {
  return readProject(id)?.overlayVolume ?? 1;
}

export function baseLayerOf(id: string): BaseLayer {
  return readProject(id)?.baseLayer ?? DEFAULT_BASE_LAYER;
}

export function setOverlayVolume(id: string, volume: number): void {
  const project = readProject(id);
  if (!project) throw new Error(`Project ${id} not found`);
  writeProject({ ...project, overlayVolume: volume });
}

export function voiceVolume(id: string): number {
  return readProject(id)?.voiceVolume ?? 1;
}

export function updateProjectSettings(id: string, change: Partial<Pick<Project, 'voiceVolume' | 'voice' | 'captions' | 'music' | 'stylePreset'>>): Project {
  const project = readProject(id);
  if (!project) throw new Error(`Project ${id} not found`);
  const next = { ...project, ...change };
  writeProject(next);
  return next;
}

const CLAUDE_MD_VERSION = /^<!-- mangoai-claude-md: \d+ -->/;

// The project's CLAUDE.md is a copy of templates/CLAUDE.md. When the template changes, projects
// created earlier would keep instructions that contradict the current behavior, so an outdated
// copy is replaced (the old one is kept in 05_debug/).
export function refreshClaudeMd(id: string): void {
  const template = fs.readFileSync(path.join(TEMPLATES_ROOT, 'CLAUDE.md'), 'utf-8');
  const target = path.join(projectDir(id), 'CLAUDE.md');
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  const wanted = CLAUDE_MD_VERSION.exec(template)?.[0];
  if (wanted && current.startsWith(wanted)) return;

  if (current) {
    const debugDir = path.join(projectDir(id), '05_debug');
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, `CLAUDE.md.${Date.now()}.bak`), current);
  }
  fs.writeFileSync(target, template);
}
