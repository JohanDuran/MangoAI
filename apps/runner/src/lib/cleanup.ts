import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_ROOT } from './paths.js';
import { listProjects } from './scaffold.js';
import { log } from './log.js';

// Leftovers of an interrupted run: atomic-write temp files, half-made resized images, the audio
// extracted for a transcription that never finished, and partially mixed exports.
const STALE = /(\.tmp(\.[a-z0-9]+)?|\.resize\.tmp\.[a-z0-9]+)$/i;
const SUBDIRS = ['', '00_input', '01_transcript', '02_assets', '03_remotion_code', '04_output', '04_output/by_marker'];

export function cleanupLeftovers(): void {
  if (!fs.existsSync(PROJECTS_ROOT)) return;
  let removed = 0;
  for (const project of listProjects()) {
    const root = path.join(PROJECTS_ROOT, project.id);
    for (const sub of SUBDIRS) {
      const dir = path.join(root, sub);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const stale = STALE.test(entry.name) || (sub === '01_transcript' && entry.name === 'audio.mp3');
        if (!stale) continue;
        try {
          fs.rmSync(path.join(dir, entry.name), { force: true });
          removed++;
        } catch {
          // In use or locked; it will be tried again on the next start.
        }
      }
    }
  }
  if (removed > 0) log('info', 'cleanup.done', { removed });
}
