import fs from 'node:fs';
import { PROJECTS_ROOT } from './paths.js';
import { CURRENT_SCHEMA_VERSION, listProjects, readProject, writeProject, type Project } from './scaffold.js';
import { log } from './log.js';

// Each step upgrades a project from schema version N to N+1 (steps[N]). Data files are only ever
// changed by adding a step here, so a project created by an older release still opens after an update.
const steps: ((project: Project) => Project)[] = [
  // 0 -> 1: projects created before versioning existed; the layout itself did not change.
  (project) => project,
];

export function migrateProjects(): void {
  if (!fs.existsSync(PROJECTS_ROOT)) return;
  for (const listed of listProjects()) {
    try {
      let project = readProject(listed.id);
      if (!project) continue;
      const from = project.schemaVersion ?? 0;
      if (from > CURRENT_SCHEMA_VERSION) {
        log('warn', 'migrate.newer', { project: listed.id, schema: from, supported: CURRENT_SCHEMA_VERSION });
        continue;
      }
      if (from === CURRENT_SCHEMA_VERSION) continue;
      for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) project = steps[v](project);
      writeProject({ ...project, schemaVersion: CURRENT_SCHEMA_VERSION });
      log('info', 'migrate.done', { project: listed.id, from, to: CURRENT_SCHEMA_VERSION });
    } catch (err) {
      log('error', 'migrate.failed', { project: listed.id, error: err });
    }
  }
}
