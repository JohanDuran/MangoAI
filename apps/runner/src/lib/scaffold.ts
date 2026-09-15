import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_ROOT, TEMPLATES_ROOT, projectDir, markerFile } from './paths.js';
import { readMarkers, writeMarkers, type Marker } from './markers.js';
import { regenerateRegistry } from './registry.js';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
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

  const project: Project = { id, name, createdAt: new Date().toISOString() };
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

export function addMarker(id: string, input: { start: number; end: number; prompt: string }): Marker {
  const markers = readMarkers(id);
  const marker: Marker = {
    marker_id: `m${markers.length + 1}`,
    start: input.start,
    end: input.end,
    prompt: input.prompt,
    feedback: '',
    status: 'draft',
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
