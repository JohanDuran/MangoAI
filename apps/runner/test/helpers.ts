import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests run against a throwaway data folder. The name contains a space and an accented letter on purpose:
// real Windows profile names look like that, and it is where quoting bugs show up.
export function useTempData(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mango test ñ-'));
  process.env.MANGO_PROJECTS_DIR = path.join(root, 'projects');
  process.env.MANGO_LOG_DIR = path.join(root, 'logs');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// The ffmpeg build that "npm run runtime" stages. Tests that need it skip themselves when it is missing.
export function findFfmpeg(): { ffmpeg: string; ffprobe: string } | null {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..');
  const bundled = { ffmpeg: path.join(repo, 'build', 'runtime', 'bin', 'ffmpeg.exe'), ffprobe: path.join(repo, 'build', 'runtime', 'bin', 'ffprobe.exe') };
  if (fs.existsSync(bundled.ffmpeg) && fs.existsSync(bundled.ffprobe)) return bundled;
  return null;
}
