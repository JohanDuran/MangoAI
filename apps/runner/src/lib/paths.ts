import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RUNNER_ROOT = path.resolve(__dirname, '..', '..');
export const PROJECTS_ROOT = path.join(RUNNER_ROOT, 'proyectos');
export const TEMPLATES_ROOT = path.join(RUNNER_ROOT, 'templates');

export const projectDir = (id: string) => path.join(PROJECTS_ROOT, id);
export const inputDir = (id: string) => path.join(projectDir(id), '00_input');
export const markerFile = (id: string, markerId: string) =>
  path.join(projectDir(id), '03_remotion_code', `marker_${markerId}.tsx`);
export const SKILLS_ROOT = path.resolve(RUNNER_ROOT, '..', '..', 'skills');
