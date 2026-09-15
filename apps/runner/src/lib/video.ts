import fs from 'node:fs';
import path from 'node:path';
import { inputDir } from './paths.js';

export const RAW_VIDEO_BASENAME = 'raw_video';

export function findRawVideo(id: string): string | null {
  const dir = inputDir(id);
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find((f) => f.startsWith(`${RAW_VIDEO_BASENAME}.`));
  return match ? path.join(dir, match) : null;
}

export function removeExistingRawVideo(id: string): void {
  const dir = inputDir(id);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${RAW_VIDEO_BASENAME}.`)) fs.rmSync(path.join(dir, f));
  }
}
