import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_ROOT } from './paths.js';
import { listProjects } from './scaffold.js';
import { log } from './log.js';

// Leftovers of an interrupted run: atomic-write temp files, half-made resized images, the audio
// extracted for a transcription that never finished, and partially mixed exports.
const STALE = /(\.tmp(\.[a-z0-9]+)?|\.resize\.tmp\.[a-z0-9]+|\.part)$/i;
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

function directorySize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
    }
  } catch {
    // unreadable entries do not count
  }
  return total;
}

// The render cache only saves time; when it gets large it is simply thrown away and rebuilt.
export function trimRenderCache(maxBytes = 1.5 * 1024 ** 3): void {
  const cache = process.env.MANGO_CACHE_DIR;
  if (!cache || !fs.existsSync(cache)) return;
  const size = directorySize(cache);
  if (size <= maxBytes) return;
  fs.rmSync(path.join(cache, 'node_modules'), { recursive: true, force: true });
  log('info', 'cleanup.cache_cleared', { mb: Math.round(size / 1024 ** 2) });
}
