// Reading and writing project files on disk (Node only).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Project } from './schema.js';
import { parseWordsTsv, WordIndex } from './time.js';

const run = promisify(execFile);

/** JSON with 2-space indent, but short arrays of plain values on one line (keeps 50-min projects diffable). */
export function formatJson(value: unknown): string {
  const out = (v: unknown, indent: string): string => {
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      if (v.every((x) => x === null || typeof x !== 'object')) {
        const line = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
        if (line.length <= 100) return line;
      }
      const inner = indent + '  ';
      return `[\n${v.map((x) => inner + out(x, inner)).join(',\n')}\n${indent}]`;
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return '{}';
      const inner = indent + '  ';
      return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${out(x, inner)}`).join(',\n')}\n${indent}}`;
    }
    return JSON.stringify(v);
  };
  return out(value, '') + '\n';
}

export async function readJson(file: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(file, 'utf-8');
  return JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
}

export async function loadWords(projectDir: string, rel: string): Promise<WordIndex | undefined> {
  try {
    return new WordIndex(parseWordsTsv(await fs.readFile(path.resolve(projectDir, rel), 'utf-8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Media length in seconds via ffprobe; undefined when the file is missing or unreadable. */
export async function probeDuration(file: string, ffprobe = 'ffprobe'): Promise<number | undefined> {
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Lengths of every audio/video file the project's clips use, keyed by the clip's `src` as written. */
export async function probeProjectMedia(projectDir: string, srcs: Iterable<string>, sources: Record<string, string> = {}): Promise<Map<string, number>> {
  const unique = [...new Set(srcs)];
  const out = new Map<string, number>();
  await Promise.all(
    unique.map(async (src) => {
      const d = await probeDuration(path.resolve(projectDir, sources[src] ?? src));
      if (d !== undefined) out.set(src, d);
    }),
  );
  return out;
}

export async function writeProject(file: string, project: Project): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, formatJson(project), 'utf-8');
  await fs.rename(tmp, file);
}
