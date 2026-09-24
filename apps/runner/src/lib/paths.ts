import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// In development everything is resolved relative to the repository. The packaged desktop app
// starts the runner with the MANGO_* variables below, pointing at read-only resources inside the
// install folder and at writable data inside the user's profile.
export const RUNNER_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(RUNNER_ROOT, '..', '..');
const RESOURCES = env.MANGO_RESOURCES_DIR ? path.resolve(env.MANGO_RESOURCES_DIR) : null;

export const PACKAGED = env.MANGO_PACKAGED === '1';
export const PROJECTS_ROOT = env.MANGO_PROJECTS_DIR ? path.resolve(env.MANGO_PROJECTS_DIR) : path.join(RUNNER_ROOT, 'proyectos');
export const LOG_DIR = env.MANGO_LOG_DIR ? path.resolve(env.MANGO_LOG_DIR) : path.join(RUNNER_ROOT, 'logs');
export const TEMPLATES_ROOT = RESOURCES ? path.join(RESOURCES, 'templates') : path.join(RUNNER_ROOT, 'templates');
export const SKILLS_ROOT = RESOURCES ? path.join(RESOURCES, 'skills') : path.join(REPO_ROOT, 'skills');
export const EDITOR_DIST = RESOURCES ? path.join(RESOURCES, 'editor') : path.join(REPO_ROOT, 'apps', 'editor', 'dist');

// Where bare imports of generated code (react, remotion, @mangoai/remotion-overlay, ...) are resolved.
// Projects live outside the install folder, so a normal upward node_modules lookup finds nothing.
export const NODE_MODULES_DIR = env.MANGO_NODE_MODULES ? path.resolve(env.MANGO_NODE_MODULES) : path.join(REPO_ROOT, 'node_modules');

// Project ids and marker ids end up in file paths, so they are restricted to a safe alphabet.
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export class InvalidIdError extends Error {
  constructor(what: string, value: string) {
    super(`Invalid ${what}: ${JSON.stringify(value.slice(0, 40))}`);
  }
}

export function assertSafeId(what: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new InvalidIdError(what, String(value));
}

export const projectDir = (id: string) => {
  assertSafeId('project id', id);
  return path.join(PROJECTS_ROOT, id);
};
export const inputDir = (id: string) => path.join(projectDir(id), '00_input');
export const markerFile = (id: string, markerId: string) => {
  assertSafeId('marker id', markerId);
  return path.join(projectDir(id), '03_remotion_code', `marker_${markerId}.tsx`);
};
