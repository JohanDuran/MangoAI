import fs from 'node:fs';

const GB = 1024 ** 3;

export function freeBytes(dir: string): number | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    // Unsupported filesystem or permissions; do not block the user on a check that cannot run.
    return null;
  }
}

export const formatBytes = (n: number): string => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export class LowDiskSpaceError extends Error {
  constructor(free: number, needed: number, what: string) {
    super(`Not enough free disk space for ${what}: ${formatBytes(free)} free, about ${formatBytes(needed)} needed. Free up some space and try again.`);
  }
}

// Throws before starting work that would otherwise fail halfway with a truncated file.
export function assertFreeSpace(dir: string, neededBytes: number, what: string): void {
  const free = freeBytes(dir);
  if (free !== null && free < neededBytes) throw new LowDiskSpaceError(free, neededBytes, what);
}
