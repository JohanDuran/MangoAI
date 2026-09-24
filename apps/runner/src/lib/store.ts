import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A crash or power loss in the middle of writeFileSync leaves a truncated file. Writing to a temp
// file and renaming it over the target is atomic on the same volume, so readers see either the
// old content or the new content, never half of one.
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  // Antivirus and indexers sometimes hold a just-written file on Windows, which fails the rename briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      const until = Date.now() + 40 * (attempt + 1);
      while (Date.now() < until) {
        // brief synchronous back-off; these files are tiny and this path is rare
      }
    }
  }
}

// Writes JSON atomically and keeps the previous version as <file>.bak so a corrupted file can be recovered.
export function writeJsonAtomic(file: string, value: unknown): void {
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // A missing backup must not block saving the new data.
    }
  }
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

// Reads JSON, falling back to the .bak copy when the file is unreadable or invalid.
export function readJson<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    const backup = `${file}.bak`;
    if (fs.existsSync(backup)) {
      try {
        const recovered = JSON.parse(fs.readFileSync(backup, 'utf-8')) as T;
        fs.copyFileSync(backup, file);
        return recovered;
      } catch {
        // fall through to the original error
      }
    }
    throw new Error(`${path.basename(file)} is unreadable and no valid backup exists: ${err instanceof Error ? err.message : err}`);
  }
}
