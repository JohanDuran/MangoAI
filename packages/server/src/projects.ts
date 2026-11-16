// The saved state of each project folder, and every way it changes: your Save from the editor, Claude's
// edits through the MCP tools, restoring a revision. Each save writes cut.json (revision + 1), keeps a copy
// in .mangoai/revisions/, and appends one plain-language line to .mangoai/history.jsonl.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Editor, OpError, parseWordsTsv, validateProject, WordIndex, type Author, type Op, type Project, type Word } from '@mangoai/core';
import { formatJson, openFolder, writeProject, type OpenedFrom } from '@mangoai/core/node';
import { broadcast } from './events.js';
import { probe } from './media.js';

export const cacheOf = (dir: string) => path.join(dir, '.mangoai');
const HOME = os.homedir();

export interface State {
  dir: string;
  project: Project;
  from: OpenedFrom;
  words: Word[] | null;
  transcripts: Record<string, Word[]>;
  durations: Map<string, number>;
  mtime: number | null;
}

export interface HistoryLine {
  rev: number;
  author: Author;
  at: string;
  label: string;
  summary: string[];
  ops?: Op[];
  base?: number;
}

const states = new Map<string, State>();
const locks = new Map<string, Promise<unknown>>();
/** mtime of the cut.json we wrote ourselves, so the folder watcher can tell outside edits apart. */
export const ownWrites = new Map<string, number>();
const k = (dir: string) => path.resolve(dir).toLowerCase();

/** Run fn for one project folder at a time (saves and Claude's edits never interleave). */
export function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(k(dir)) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(k(dir), next.catch(() => {}));
  return next;
}

export function mediaSrcs(p: Project): string[] {
  const out = new Set<string>();
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.type === 'media') out.add(c.src);
      if (c.type === 'generator' && typeof c.params.image === 'string') out.add(c.params.image);
    }
  return [...out];
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export async function loadTranscripts(dir: string, p: Project): Promise<Record<string, Word[]>> {
  const out: Record<string, Word[]> = {};
  await Promise.all(
    Object.entries(p.transcripts).map(async ([name, rel]) => {
      try {
        out[name] = parseWordsTsv(await fs.readFile(path.resolve(dir, rel), 'utf-8'));
      } catch {}
    }),
  );
  return out;
}

/** The saved project (cut.json, else short.json imported in memory), cached until cut.json changes. */
export async function load(dir: string, force = false): Promise<State> {
  const cut = path.join(dir, 'cut.json');
  const m = await mtimeOf(cut);
  const cached = states.get(k(dir));
  if (cached && !force && cached.mtime === m) return cached;
  const { project, from } = await openFolder(dir);
  const transcripts = await loadTranscripts(dir, project);
  const first = Object.keys(project.transcripts)[0];
  const durations = new Map<string, number>();
  await Promise.all(
    mediaSrcs(project).map(async (src) => {
      const info = await probe(path.resolve(dir, project.sources[src] ?? src), cacheOf(dir));
      if (info.duration !== undefined && info.kind !== 'image') durations.set(src, info.duration);
    }),
  );
  const st: State = { dir, project, from, words: first ? (transcripts[first] ?? null) : null, transcripts, durations, mtime: m };
  states.set(k(dir), st);
  return st;
}

export function editorFor(st: State): Editor {
  const words = st.words ? new WordIndex(st.words) : undefined;
  return new Editor(structuredClone(st.project), { ...(words && { words }), durations: st.durations, transcripts: st.transcripts });
}

async function appendHistory(dir: string, line: HistoryLine) {
  await fs.mkdir(cacheOf(dir), { recursive: true });
  await fs.appendFile(path.join(cacheOf(dir), 'history.jsonl'), JSON.stringify(line) + '\n', 'utf-8');
}

async function writeRevision(dir: string, project: Project) {
  const file = path.join(dir, 'cut.json');
  await writeProject(file, project);
  ownWrites.set(k(dir), (await mtimeOf(file)) ?? 0);
  const revs = path.join(cacheOf(dir), 'revisions');
  await fs.mkdir(revs, { recursive: true });
  await fs.writeFile(path.join(revs, `r${String(project.revision).padStart(4, '0')}.json`), formatJson(project), 'utf-8');
}

export class Conflict extends Error {
  constructor(readonly revision: number, readonly since: HistoryLine[]) {
    super(`the project changed since revision you started from (now at ${revision})`);
  }
}

/** Your Save from the editor: the whole project as the editor has it, plus what changed (for history). */
export async function saveFromEditor(
  dir: string,
  body: { client?: string; base: number; changes: { label: string; summary: string[]; ops: Op[] }[]; project: unknown },
): Promise<number> {
  return locked(dir, async () => {
    const st = await load(dir);
    const current = st.from === 'cut.json' ? st.project.revision : 0;
    if (body.base !== current) throw new Conflict(current, await history(dir, body.base));
    const v = validateProject(body.project);
    if (!v.ok) throw new Error(`can't save, the project has problems:\n${v.problems.map((p) => `${p.path}: ${p.message}`).join('\n')}`);
    const project = v.project;
    project.revision = current + 1;
    await writeRevision(dir, project);
    const ops = body.changes.flatMap((c) => c.ops);
    const summary = body.changes.flatMap((c) => c.summary);
    const label = body.changes.length === 1 ? body.changes[0]!.label : `${body.changes.length} edits`;
    await appendHistory(dir, { rev: project.revision, author: 'you', at: new Date().toISOString(), label, summary, ops, base: current });
    await clearDraft(dir);
    await load(dir, true);
    broadcast(dir, { type: 'saved', revision: project.revision, base: current, author: 'you', label, ops, client: body.client });
    return project.revision;
  });
}

/**
 * Claude's edit: ops on top of the revision Claude last read. Refused when you saved something newer since,
 * so your edits are never overwritten blindly.
 */
export async function applyClaude(dir: string, base: number | undefined, ops: Op[], label?: string) {
  return locked(dir, async () => {
    const st = await load(dir);
    const current = st.from === 'cut.json' ? st.project.revision : 0;
    if (base !== undefined && base !== current) throw new Conflict(current, await history(dir, base));
    const ed = editorFor(st);
    let change;
    try {
      change = ed.apply(ops, { author: 'claude', ...(label && { label }) });
    } catch (e) {
      if (e instanceof OpError || (e as Error).name === 'ZodError') throw new OpError(`refused, nothing changed: ${(e as Error).message}`);
      throw e;
    }
    const v = validateProject(JSON.parse(JSON.stringify(ed.project)));
    if (!v.ok) throw new OpError(`refused, the result would be invalid: ${v.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
    ed.project.revision = current + 1;
    await writeRevision(dir, ed.project);
    await appendHistory(dir, { rev: ed.project.revision, author: 'claude', at: change.at, label: change.label, summary: change.summary, ops, base: current });
    await load(dir, true);
    broadcast(dir, { type: 'saved', revision: ed.project.revision, base: current, author: 'claude', label: change.label, ops });
    await markSeen(dir, ed.project.revision);
    return { revision: ed.project.revision, summary: change.summary, problems: ed.resolve().problems };
  });
}

/** Put an old revision back, as a new revision (nothing is lost). */
export async function restore(dir: string, rev: number, author: Author = 'you') {
  return locked(dir, async () => {
    const st = await load(dir);
    const file = path.join(cacheOf(dir), 'revisions', `r${String(rev).padStart(4, '0')}.json`);
    const v = validateProject(JSON.parse(await fs.readFile(file, 'utf-8')));
    if (!v.ok) throw new Error(`revision ${rev} can't be read`);
    const current = st.from === 'cut.json' ? st.project.revision : 0;
    v.project.revision = current + 1;
    await writeRevision(dir, v.project);
    await appendHistory(dir, { rev: v.project.revision, author, at: new Date().toISOString(), label: `restored revision ${rev}`, summary: [`restored revision ${rev}`], base: current });
    await load(dir, true);
    broadcast(dir, { type: 'saved', revision: v.project.revision, base: current, author, label: `restored revision ${rev}` });
    return v.project.revision;
  });
}

export async function history(dir: string, since = 0): Promise<HistoryLine[]> {
  try {
    const text = await fs.readFile(path.join(cacheOf(dir), 'history.jsonl'), 'utf-8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryLine)
      .filter((l) => l.rev > since);
  } catch {
    return [];
  }
}

// --- drafts: unsaved edits, kept so a closed tab loses nothing ------------------------------------
export async function setDraft(dir: string, draft: { base: number; changes: unknown[] }) {
  const file = path.join(cacheOf(dir), 'draft.json');
  if (!draft.changes.length) return clearDraft(dir);
  await fs.mkdir(cacheOf(dir), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...draft, at: new Date().toISOString() }), 'utf-8');
}

export async function getDraft(dir: string): Promise<{ base: number; changes: unknown[]; at: string } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(cacheOf(dir), 'draft.json'), 'utf-8'));
  } catch {
    return null;
  }
}

async function clearDraft(dir: string) {
  await fs.rm(path.join(cacheOf(dir), 'draft.json'), { force: true });
}

// --- what Claude has seen, and which projects are open (read by the Claude Code hook) --------------
export async function markSeen(dir: string, revision: number, requests?: string[]) {
  const file = path.join(cacheOf(dir), 'claude.json');
  let cur: { seen?: number; requests?: string[] } = {};
  try {
    cur = JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {}
  const next = { seen: Math.max(cur.seen ?? 0, revision), requests: [...new Set([...(cur.requests ?? []), ...(requests ?? [])])], at: new Date().toISOString() };
  await fs.mkdir(cacheOf(dir), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 1), 'utf-8');
}

export async function register(dir: string) {
  const file = path.join(HOME, '.mangoai', 'projects.json');
  let list: { dir: string; opened: string }[] = [];
  try {
    list = JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {}
  list = [{ dir: path.resolve(dir), opened: new Date().toISOString() }, ...list.filter((x) => k(x.dir) !== k(dir))].slice(0, 30);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(list, null, 1), 'utf-8');
}

// --- what the editor tab reports (for Claude's `selection` tool) ----------------------------------
export interface EditorReport {
  clips: string[];
  range: [number, number] | null;
  region: [number, number, number, number] | null;
  picked: unknown;
  t: number;
  dirty: boolean;
  unsaved: string[];
  at: string;
}
export const reports = new Map<string, EditorReport>();
export function report(dir: string, r: Omit<EditorReport, 'at'>) {
  reports.set(k(dir), { ...r, at: new Date().toISOString() });
}
export function reportOf(dir: string): EditorReport | undefined {
  return reports.get(k(dir));
}
