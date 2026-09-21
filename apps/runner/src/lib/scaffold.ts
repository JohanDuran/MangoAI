import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_ROOT, TEMPLATES_ROOT, projectDir, markerFile } from './paths.js';
import { readMarkers, writeMarkers, type Marker, type MarkerRegion } from './markers.js';
import { regenerateRegistry } from './registry.js';
import { defaultSkillNames } from './skills.js';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  // Skills enabled for this project. Absent on projects created before skills existed, which
  // get the built-in defaults.
  skills?: string[];
  // Volume of sounds played by the overlay animations, 0 (muted) to 1. Absent means 1.
  overlayVolume?: number;
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'project';

export function createProject(name: string): Project {
  const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = projectDir(id);

  for (const sub of ['00_input', '01_transcript', '02_assets', '03_remotion_code', '04_output', '05_debug/code_history']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  const project: Project = { id, name, createdAt: new Date().toISOString(), skills: defaultSkillNames() };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  fs.copyFileSync(path.join(TEMPLATES_ROOT, 'CLAUDE.md'), path.join(dir, 'CLAUDE.md'));

  fs.writeFileSync(path.join(dir, '00_input', 'markers.json'), '[]\n');
  fs.writeFileSync(path.join(dir, '00_input', 'preview_state.json'), '{}\n');
  fs.writeFileSync(path.join(dir, '01_transcript', 'transcript.json'), JSON.stringify({ segments: [] }, null, 2));
  fs.writeFileSync(path.join(dir, '02_assets', 'asset_manifest.json'), '[]\n');
  fs.writeFileSync(
    path.join(dir, '03_remotion_code', 'CompositionConfig.json'),
    JSON.stringify({ fps: 30, width: 1920, height: 1080, durationInFrames: 1800 }, null, 2)
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
    .filter((d) => d.isDirectory())
    .map((d) => readProject(d.name))
    .filter((p): p is Project => p !== null);
}

export function readProject(id: string): Project | null {
  const file = path.join(projectDir(id), 'project.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function addMarker(id: string, input: { start: number; end: number; prompt: string; region?: MarkerRegion; assets?: string[] }): Marker {
  const markers = readMarkers(id);
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
  fs.writeFileSync(path.join(projectDir(id), 'project.json'), JSON.stringify(next, null, 2));
  return next;
}

export function overlayVolume(id: string): number {
  return readProject(id)?.overlayVolume ?? 1;
}

export function setOverlayVolume(id: string, volume: number): void {
  const project = readProject(id);
  if (!project) throw new Error(`Project ${id} not found`);
  fs.writeFileSync(path.join(projectDir(id), 'project.json'), JSON.stringify({ ...project, overlayVolume: volume }, null, 2));
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
