// MangoAI local server. Binds to 127.0.0.1 only and serves files only from under the user's home folder.
// Writes go to a project's cut.json (on Save, or a Claude edit through the MCP tools) and its .mangoai/
// folder (cache, history, drafts, versions), plus renders/ on export.
//   npm start                       → http://localhost:4780
//   npm start -- --port 4790
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cutRanges,
  deleteClips,
  fillers,
  linkTime,
  moveClips,
  OpError,
  parseWordsTsv,
  pauses,
  rippleDelete,
  rippleDeleteClips,
  setFades,
  setGain,
  splitAt,
  trimClip,
  unlinkTime,
  VERSION,
  type CompClip,
  type Editor,
  type Op,
  type Project,
} from '@mangoai/core';
import { compPage, compStills, folderOf, freeGraphicsTrack, HF_RUNTIME, renderFolder, scaffoldComp, snapshot, snapshotVersion, switchVersion, tokenOf, versions, watchProject } from './comps.js';
import { broadcast, connected, sendToNewest, subscribe } from './events.js';
import { exportOtio, jobOf, plan, startExport, waitFor } from './export.js';
import { kindOf, peaks, probe, proxyState, type MediaInfo } from './media.js';
import {
  applyClaude,
  cacheOf,
  Conflict,
  editorFor,
  getDraft,
  history,
  load,
  markSeen,
  mediaSrcs,
  register,
  report,
  reportOf,
  restore,
  saveFromEditor,
  setDraft,
} from './projects.js';
import * as toolbox from './toolbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// From source (npm start) the editor is served by Vite in dev mode from packages/web. In the published
// `mangoai` package the server is bundled to dist/server.js and the editor is prebuilt next to it in dist/web.
const webRoot = path.resolve(here, '../../web');
const builtWeb = path.resolve(here, 'web');
const HOME = path.resolve(os.homedir());
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || Number(process.env.MANGOAI_PORT) || 4780;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Only paths under the home folder, resolved (no ../ escapes). */
interface RenderJob {
  id: string;
  state: 'running' | 'done' | 'error';
  folder: string;
  output?: string;
  seconds?: number;
  error?: string;
}
const renderJobs = new Map<string, RenderJob>();

/** Toolbox failures (down, bad input, a failed job) reach the editor as a readable 502. */
async function viaToolbox<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof toolbox.ToolboxError) throw new HttpError(502, e.message);
    throw e;
  }
}

function safePath(p: string | null | undefined): string {
  if (!p) throw new HttpError(400, 'path is required');
  const abs = path.resolve(p);
  const rel = path.relative(HOME, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, 'only files under your home folder');
  return abs;
}

async function studioRoot(): Promise<string> {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(HOME, '.video-studio', 'config.json'), 'utf-8')) as { studio?: string };
    if (cfg.studio) return path.resolve(cfg.studio);
  } catch {}
  return HOME;
}

// --- reading -----------------------------------------------------------------------------------------
export interface OpenedMedia extends MediaInfo {
  url: string;
}

async function mediaInfo(dir: string, p: Project, srcs: string[]): Promise<Record<string, OpenedMedia>> {
  const media: Record<string, OpenedMedia> = {};
  await Promise.all(
    srcs.map(async (src) => {
      const abs = safePath(path.resolve(dir, p.sources[src] ?? src));
      const info = await probe(abs, cacheOf(dir));
      const q = `path=${encodeURIComponent(abs)}&dir=${encodeURIComponent(dir)}`;
      media[src] = { ...info, url: info.kind === 'video' && info.playable === false ? `/api/proxy?${q}` : `/api/file?${q}` };
    }),
  );
  return media;
}

async function apiOpen(dir: string) {
  const st = await load(dir, true);
  const media = await mediaInfo(dir, st.project, mediaSrcs(st.project));
  await register(dir);
  watchProject(dir);
  return { dir, name: path.basename(dir), from: st.from, project: st.project, words: st.words, transcripts: st.transcripts, media, draft: await getDraft(dir), comps: {} };
}

const SKIP = new Set(['.mangoai', 'node_modules', '.git', '.hyperframes']);

async function apiPool(dir: string) {
  const out: { path: string; rel: string; kind: string; size: number }[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 5 || out.length > 5000) return;
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else {
        const kind = kindOf(full);
        if (kind === 'other' && !/\.(json|tsv|md|html)$/i.test(e.name)) continue;
        const st = await fs.stat(full);
        out.push({ path: full, rel: path.relative(dir, full).split(path.sep).join('/'), kind, size: st.size });
      }
    }
  };
  await walk(dir, 0);
  return { dir, files: out.sort((a, b) => a.rel.localeCompare(b.rel)) };
}

async function apiBrowse(dir: string | null) {
  const root = dir ? safePath(dir) : await studioRoot();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map(async (e) => {
        const full = path.join(root, e.name);
        const has = async (f: string) => fs.access(path.join(full, f)).then(() => true, () => false);
        return { name: e.name, path: full, project: (await has('cut.json')) || (await has('short.json')) };
      }),
  );
  const parent = path.dirname(root);
  return { dir: root, parent: parent !== root && !path.relative(HOME, parent).startsWith('..') ? parent : null, folders: folders.sort((a, b) => a.name.localeCompare(b.name)) };
}

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.tsv': 'text/tab-separated-values', '.md': 'text/markdown', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/** Static file with Range support (video seeking needs it). */
async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, 'not found');
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Last-Modified': st.mtime.toUTCString() };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 60e6): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function body<T>(req: http.IncomingMessage): Promise<T> {
  const b = await readBody(req);
  try {
    return JSON.parse(b.toString('utf-8') || '{}') as T;
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

// --- Claude's view of a project ------------------------------------------------------------------
const r3 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);

function clipView(c: Project['tracks'][number]['clips'][number], rc: { start: number; end: number | null; in?: number; speed?: number } | undefined) {
  const v: Record<string, unknown> = { id: c.id, type: c.type, t: [r3(rc?.start), r3(rc?.end)] };
  if (typeof c.start === 'string') v.start = c.start;
  if (typeof c.end === 'string') v.end = c.end;
  if (c.label) v.label = c.label;
  if (c.pivot) v.pivot = c.pivot;
  if (c.type === 'media') {
    v.src = c.src;
    if (rc?.in) v.in = r3(rc.in);
    if (rc?.speed !== undefined && rc.speed !== 1) v.speed = r3(rc.speed);
    for (const k of ['gain', 'fadeIn', 'fadeOut', 'loop', 'still', 'region', 'cardW', 'cy', 'dim', 'transcript'] as const) if (c[k] !== undefined) v[k] = c[k];
  } else if (c.type === 'title') {
    v.text = c.text ?? c.runs?.map((x) => x[0]).join('');
    for (const k of ['style', 'pos', 'color', 'fs', 'box'] as const) if (c[k] !== undefined) v[k] = c[k];
  } else if (c.type === 'comp') {
    v.comp = c.comp;
    if (c.vars) v.vars = c.vars;
  } else v.generator = c.generator;
  return v;
}

async function state(dir: string, from?: number, to?: number, claude = false) {
  const st = await load(dir);
  const ed = editorFor(st);
  const r = ed.resolve();
  const p = ed.project;
  const a = from ?? 0;
  const b = to ?? Infinity;
  const rep = reportOf(dir);
  const out = {
    dir,
    revision: st.from === 'cut.json' ? p.revision : 0,
    from: st.from,
    title: p.title,
    format: `${p.width}x${p.height} ${p.fps}fps`,
    length: r3(r.end),
    window: from !== undefined || to !== undefined ? [a, to ?? null] : undefined,
    editor: { open_tabs: connected(dir), unsaved: rep?.dirty ?? false, unsaved_edits: rep?.unsaved ?? [], playhead: rep ? r3(rep.t) : null },
    sections: r.sections.filter((s) => s.t1 > a && s.t0 < b).map((s) => ({ id: s.id, t: [r3(s.t0), r3(s.t1)], note: p.sections.find((x) => x.id === s.id)?.note })),
    anchors: p.anchors.map((x) => ({ name: x.name, at: x.at, t: r3(r.anchors.get(x.name)) })),
    tracks: p.tracks.map((t) => {
      const clips = t.clips.filter((c) => {
        const rc = r.clips.get(c.id);
        return !rc || ((rc.end ?? Infinity) > a && rc.start < b);
      });
      return {
        id: t.id,
        kind: t.kind,
        ...(t.role && { role: t.role }),
        ...(t.name && { name: t.name }),
        ...(t.gain !== undefined && { gain: t.gain }),
        ...(t.muted && { muted: true }),
        ...(t.hidden && { hidden: true }),
        ...(t.locked && { locked: true }),
        ...(t.kind === 'captions' && { transcript: t.transcript, style: t.style, enabled: t.enabled !== false }),
        clips: clips.length > 400 ? `${clips.length} clips (narrow the window with from/to)` : clips.map((c) => clipView(c, r.clips.get(c.id))),
      };
    }),
    requests: (p.requests ?? []).filter((x) => x.status === 'open' || x.status === 'working').map((x) => ({ id: x.id, kind: x.kind, status: x.status, text: x.text })),
    problems: r.problems.slice(0, 50),
  };
  if (claude) await markSeen(dir, out.revision);
  return out;
}

async function requestsFor(dir: string, status?: string) {
  const st = await load(dir);
  const ed = editorFor(st);
  const r = ed.resolve();
  const p = ed.project;
  const list = (p.requests ?? []).filter((x) => !status || x.status === status);
  const out = list.map((q) => {
    const span = q.range ?? (q.clip && r.clips.get(q.clip) ? [r.clips.get(q.clip)!.start, r.clips.get(q.clip)!.end ?? r.end] : q.t !== undefined ? [q.t - 2, q.t + 2] : null);
    const words = span ? r.words.filter((w) => w.e > span[0]! && w.s < span[1]!).map((w) => ({ w: w.w, s: r3(w.s), e: r3(w.e) })) : [];
    const clip = q.clip ? ed.clip(q.clip) : undefined;
    const rc = q.clip ? r.clips.get(q.clip) : undefined;
    return {
      ...q,
      ...(q.still && { still_path: path.join(dir, q.still) }),
      ...(clip && { clip_info: clipView(clip, rc), ...(clip.type === 'comp' && { comp_folder: path.resolve(dir, clip.comp), clip_local_t: q.t !== undefined && rc ? r3(q.t - rc.start) : null }) }),
      ...(q.region && { region_px: [Math.round(q.region[0] * p.width), Math.round(q.region[1] * p.height), Math.round(q.region[2] * p.width), Math.round(q.region[3] * p.height)] }),
      spoken: words,
    };
  });
  await markSeen(dir, st.from === 'cut.json' ? p.revision : 0, list.map((x) => x.id));
  return { revision: st.from === 'cut.json' ? p.revision : 0, size: [p.width, p.height], requests: out };
}

/** Editing commands for Claude (the same ones the editor's mouse and keys use). */
function commandOps(ed: Editor, cmd: string, a: Record<string, unknown>): Op[] {
  const ids = (a.ids as string[] | undefined) ?? (a.id ? [a.id as string] : []);
  const num = (k: string) => {
    const v = a[k];
    if (typeof v !== 'number') throw new OpError(`${cmd}: ${k} (a number of seconds) is required`);
    return v;
  };
  switch (cmd) {
    case 'move':
      return moveClips(ed, ids, a.to !== undefined ? num('to') - (ed.resolve().clips.get(ids[0]!)?.start ?? 0) : num('by'), a.track as string | undefined);
    case 'trim':
      return trimClip(ed, ids[0]!, a.edge === 'start' ? 'start' : 'end', num('at'));
    case 'split':
      return splitAt(ed, num('at'), ids);
    case 'delete':
      return deleteClips(ed, ids);
    case 'ripple_delete':
      return rippleDeleteClips(ed, ids);
    case 'cut_range':
      return rippleDelete(ed, num('from'), num('to'), (a.tracks as string[] | undefined) ?? null);
    case 'cut_ranges':
      return cutRanges(ed, a.ranges as [number, number][]);
    case 'cut_pauses':
      return cutRanges(ed, pauses(ed.resolve().words, (a.min as number) ?? 0.8, (a.keep as number) ?? 0.15));
    case 'cut_fillers':
      return cutRanges(ed, fillers(ed.resolve().words));
    case 'gain':
      return setGain(ids, a.db === null ? null : num('db'));
    case 'fade':
      return setFades(ed, ids, a.in as number | undefined, a.out as number | undefined);
    case 'link':
      return linkTime(ed, ids[0]!, a.edge === 'end' ? 'end' : 'start', a.to as string);
    case 'unlink':
      return unlinkTime(ed, ids[0]!, a.edge === 'end' ? 'end' : 'start');
    default:
      throw new OpError(`unknown command ${cmd} (move, trim, split, delete, ripple_delete, cut_range, cut_ranges, cut_pauses, cut_fillers, gain, fade, link, unlink)`);
  }
}

// --- frames (Claude's `frame` tool): drawn by the open editor tab, comps added here -------------
interface PendingFrame {
  resolve: (file: string) => void;
  reject: (e: Error) => void;
  dir: string;
  base?: string;
}
const frames = new Map<string, PendingFrame>();

async function requestFrame(dir: string, t: number): Promise<string> {
  const id = Math.random().toString(36).slice(2, 10);
  const p = new Promise<string>((resolve, reject) => {
    frames.set(id, { resolve, reject, dir });
    setTimeout(() => {
      if (frames.delete(id)) reject(new HttpError(504, 'the editor tab did not answer (is it open and visible?)'));
    }, 30000);
  });
  if (!sendToNewest(dir, { type: 'frame', id, t })) {
    frames.delete(id);
    throw new HttpError(409, 'MangoAI is not open on this project: call project_open first (frames are drawn by the editor)');
  }
  return p;
}

/** Base layers + each comp's still (HyperFrames snapshot, transparent) + layers above the comps. */
async function composeFrame(dir: string, base: string, top: string, comps: { comp: string; local: number }[], out: string) {
  const st = await load(dir);
  const { width: W, height: H } = st.project;
  const pngs: string[] = [];
  for (const [i, c] of comps.entries()) {
    const shots = await snapshot(path.resolve(dir, c.comp), [c.local], path.join(cacheOf(dir), 'snapshots', `comp-${i}-${Date.now()}`));
    if (shots[0]) pngs.push(shots[0]);
  }
  const inputs = ['-i', base, ...pngs.flatMap((f) => ['-i', f]), '-i', top];
  const g: string[] = [];
  let last = '[0:v]';
  [...pngs, top].forEach((_, i) => {
    g.push(`[${i + 1}:v]scale=${W}:${H}[s${i}]`, `${last}[s${i}]overlay=0:0:format=auto[o${i}]`);
    last = `[o${i}]`;
  });
  const { execFile } = await import('node:child_process');
  await new Promise<void>((res, rej) => execFile('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', g.join(';'), '-map', last, '-frames:v', '1', out], (e) => (e ? rej(e) : res())));
}

// --- routes -------------------------------------------------------------------------------------------
async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const q = url.searchParams;
  const claude = req.headers['x-mango-client'] === 'claude';
  const dirQ = () => safePath(q.get('dir'));
  switch (url.pathname) {
    case '/api/health':
      return json(res, 200, { ok: true, app: 'mangoai', version: VERSION, port });
    case '/api/open':
      return json(res, 200, await apiOpen(dirQ()));
    case '/api/pool':
      return json(res, 200, await apiPool(dirQ()));
    case '/api/browse':
      return json(res, 200, await apiBrowse(q.get('dir')));
    case '/api/file':
      return sendFile(req, res, safePath(q.get('path')));
    case '/api/peaks': {
      const p = await peaks(safePath(q.get('path')), cacheOf(dirQ()));
      return p ? json(res, 200, p) : json(res, 404, { error: 'no audio' });
    }
    case '/api/proxy': {
      const s = await proxyState(safePath(q.get('path')), cacheOf(dirQ()));
      if ('ready' in s) return sendFile(req, res, s.ready);
      if ('pending' in s) return json(res, 202, { pending: true });
      return json(res, 500, { error: 'proxy failed' });
    }
    case '/api/words': {
      const st = await load(dirQ(), true);
      return json(res, 200, { words: st.words, transcripts: st.transcripts });
    }
    case '/api/media': {
      const b = await body<{ dir: string; srcs: string[] }>(req);
      const dir = safePath(b.dir);
      const st = await load(dir);
      return json(res, 200, { media: await mediaInfo(dir, st.project, b.srcs) });
    }
    case '/api/events':
      return subscribe(dirQ(), q.get('client') ?? '', res);

    // saving
    case '/api/save': {
      const b = await body<{ dir: string; client?: string; base: number; changes: { label: string; summary: string[]; ops: Op[] }[]; project: unknown }>(req);
      try {
        return json(res, 200, { revision: await saveFromEditor(safePath(b.dir), b) });
      } catch (e) {
        if (e instanceof Conflict) throw new HttpError(409, `Claude saved revision ${e.revision} since; your edits are kept, reload to put them on top`, { revision: e.revision });
        throw e;
      }
    }
    case '/api/draft': {
      const b = await body<{ dir: string; base: number; changes: unknown[] }>(req);
      await setDraft(safePath(b.dir), b);
      return json(res, 200, { ok: true });
    }
    case '/api/history':
      return json(res, 200, { lines: (await history(dirQ(), Number(q.get('since') ?? 0))).map(({ ops: _o, ...l }) => l) });
    case '/api/restore': {
      const b = await body<{ dir: string; rev: number }>(req);
      return json(res, 200, { revision: await restore(safePath(b.dir), b.rev, claude ? 'claude' : 'you') });
    }

    // what the editor shows (reported by the tab; read by Claude)
    case '/api/selection': {
      if (req.method === 'POST') {
        const b = await body<{ dir: string } & Parameters<typeof report>[1]>(req);
        report(safePath(b.dir), b);
        return json(res, 200, { ok: true });
      }
      const dir = dirQ();
      const rep = reportOf(dir);
      if (!rep) return json(res, 200, { open: connected(dir) > 0, note: 'nothing reported yet (is MangoAI open on this project?)' });
      const st = await load(dir);
      const ed = editorFor(st);
      const r = ed.resolve();
      return json(res, 200, { ...rep, open: connected(dir) > 0, clips: rep.clips.map((id) => { const c = ed.clip(id); return c ? { ...clipView(c, r.clips.get(id)), track: ed.trackOf(id)?.id } : { id, missing: true }; }) });
    }
    case '/api/snapshot': {
      if (req.method !== 'POST') throw new HttpError(405, 'POST a PNG');
      const dir = dirQ();
      const folder = (q.get('folder') ?? 'snapshots').replace(/[^\w-]/g, '_');
      const name = (q.get('name') ?? `frame-${Date.now()}`).replace(/[^\w.-]/g, '_');
      const layer = q.get('layer') ?? 'all';
      const data = await readBody(req, 40e6);
      const out = path.join(cacheOf(dir), folder, `${name}${layer === 'all' ? '' : `-${layer}`}.png`);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, data);
      const reqId = q.get('req');
      const pend = reqId ? frames.get(reqId) : undefined;
      if (pend) {
        if (layer === 'all') {
          frames.delete(reqId!);
          pend.resolve(out);
        } else if (layer === 'base') pend.base = out;
        else if (layer === 'top' && pend.base) {
          frames.delete(reqId!);
          const final = path.join(cacheOf(dir), folder, `${name}.png`);
          const comps = JSON.parse(q.get('comps') ?? '[]') as { comp: string; local: number }[];
          composeFrame(dir, pend.base, out, comps, final).then(() => pend.resolve(final), (e: Error) => pend.reject(e));
        }
      }
      return json(res, 200, { path: out, rel: path.relative(dir, out).split(path.sep).join('/') });
    }
    case '/api/frame': {
      const b = await body<{ dir: string; t: number }>(req);
      return json(res, 200, { path: await requestFrame(safePath(b.dir), b.t) });
    }

    // Claude
    case '/api/state':
      return json(res, 200, await state(dirQ(), q.has('from') ? Number(q.get('from')) : undefined, q.has('to') ? Number(q.get('to')) : undefined, claude));
    case '/api/changes': {
      const dir = dirQ();
      const since = Number(q.get('since') ?? 0);
      const lines = (await history(dir, since)).map(({ ops: _o, ...l }) => l);
      const st = await load(dir);
      const rev = st.from === 'cut.json' ? st.project.revision : 0;
      if (claude) await markSeen(dir, rev);
      const rep = reportOf(dir);
      return json(res, 200, { revision: rev, since, changes: lines, editor_unsaved: rep?.dirty ? rep.unsaved : [] });
    }
    case '/api/apply':
    case '/api/edit': {
      const b = await body<{ dir: string; base?: number; ops?: Op[]; label?: string; command?: string; args?: Record<string, unknown> }>(req);
      const dir = safePath(b.dir);
      try {
        let ops = b.ops ?? [];
        if (url.pathname === '/api/edit') {
          const st = await load(dir);
          ops = commandOps(editorFor(st), b.command ?? '', b.args ?? {});
          if (!ops.length) throw new OpError(`${b.command}: nothing to change`);
        }
        const out = await applyClaude(dir, b.base, ops, b.label);
        const rep = reportOf(dir);
        return json(res, 200, { ...out, ops: url.pathname === '/api/edit' ? ops : undefined, editor_unsaved: rep?.dirty ? rep.unsaved : [], open_tabs: connected(dir) });
      } catch (e) {
        if (e instanceof Conflict) throw new HttpError(409, `changed since you last looked (now revision ${e.revision}): ${e.since.map((l) => `rev ${l.rev} by ${l.author}: ${l.summary.join('; ')}`).join(' | ')}. Read the state again, then retry with base ${e.revision}.`, { revision: e.revision });
        if (e instanceof OpError) throw new HttpError(422, e.message);
        throw e;
      }
    }
    case '/api/requests':
      return json(res, 200, await requestsFor(dirQ(), q.get('status') ?? undefined));
    case '/api/transcript': {
      const dir = dirQ();
      const st = await load(dir);
      const r = editorFor(st).resolve();
      const a = Number(q.get('from') ?? 0);
      const b = Number(q.get('to') ?? Infinity);
      const find = (q.get('q') ?? '').toLowerCase().trim();
      let words = r.words.filter((w) => w.e > a && w.s < b);
      if (find) {
        const parts = find.split(/\s+/);
        const hits: typeof words = [];
        for (let i = 0; i + parts.length <= words.length; i++) if (parts.every((p2, k) => words[i + k]!.w.toLowerCase().includes(p2))) hits.push(...words.slice(Math.max(0, i - 4), i + parts.length + 4));
        words = [...new Set(hits)];
      }
      return json(res, 200, { count: words.length, words: words.slice(0, 3000).map((w) => [w.w, r3(w.s), r3(w.e)]), truncated: words.length > 3000 });
    }

    // comps
    case '/api/comp/versions': {
      if (req.method === 'POST') {
        const b = await body<{ dir: string; clip: string; comp: string; action: 'switch' | 'snapshot'; v?: number; note?: string }>(req);
        const dir = safePath(b.dir);
        if (b.action === 'snapshot') return json(res, 200, { v: await snapshotVersion(dir, b.clip, b.comp, b.note) });
        await switchVersion(dir, b.clip, b.comp, b.v!);
        return json(res, 200, await versions(dir, b.clip));
      }
      return json(res, 200, await versions(dirQ(), q.get('clip') ?? ''));
    }
    case '/api/comp/create': {
      const b = await body<{ dir: string; base?: number; range: [number, number]; region?: [number, number, number, number]; name?: string; request?: string; text?: string }>(req);
      const dir = safePath(b.dir);
      const st = await load(dir);
      const ed = editorFor(st);
      const r = ed.resolve();
      const p = ed.project;
      const req2 = b.request ? (p.requests ?? []).find((x) => x.id === b.request) : undefined;
      const range = b.range ?? req2?.range;
      if (!range) throw new HttpError(400, 'range is required (or a request with a range)');
      const region = b.region ?? req2?.region ?? null;
      let name = (b.name ?? req2?.id ?? 'scene').replace(/[^\w-]/g, '-');
      for (let i = 2; ed.clip(name) || (await fs.stat(path.join(dir, 'animations', name)).then(() => true, () => false)); i++) name = `${(b.name ?? req2?.id ?? 'scene').replace(/[^\w-]/g, '-')}-${i}`;
      const rel = await scaffoldComp(dir, p, { name, duration: range[1] - range[0], region, text: b.text ?? req2?.text ?? name });
      const free = freeGraphicsTrack(p, (tid) => (ed.track(tid)?.clips ?? []).map((c) => { const rc = r.clips.get(c.id); return [rc?.start ?? 0, rc?.end ?? r.end] as [number, number]; }), range[0], range[1]);
      const clip: CompClip = { id: name, type: 'comp', comp: rel, start: range[0], end: range[1], label: (req2?.text ?? name).slice(0, 40) };
      const ops: Op[] = [...free.ops, { op: 'add_clip', track: free.track, clip }];
      if (req2) ops.push({ op: 'update_request', id: req2.id, set: { status: 'working' } });
      const out = await applyClaude(dir, b.base, ops, `new comp ${name} at ${range[0].toFixed(2)}–${range[1].toFixed(2)} s`);
      await snapshotVersion(dir, name, rel, 'scaffold');
      return json(res, 200, { ...out, clip: name, track: free.track, folder: path.join(dir, rel), index_html: path.join(dir, rel, 'index.html'), size: [p.width, p.height], duration: range[1] - range[0] });
    }
    case '/api/comp/stills': {
      const b = await body<{ dir: string; clip: string; n?: number; times?: number[] }>(req);
      const dir = safePath(b.dir);
      const st = await load(dir);
      const ed = editorFor(st);
      const c = ed.clip(b.clip);
      if (!c || c.type !== 'comp') throw new HttpError(404, `no comp clip ${b.clip}`);
      const rc = ed.resolve().clips.get(b.clip)!;
      const dur = (rc.end ?? rc.start + 3) - rc.start;
      const n = Math.max(1, Math.min(9, b.n ?? 3));
      const times = b.times ?? Array.from({ length: n }, (_, i) => Math.round(((dur * (i + 0.5)) / n) * 1000) / 1000);
      return json(res, 200, { stills: await compStills(dir, c, times, rc.vars ?? {}), times });
    }
    case '/api/comp/render': {
      // any HyperFrames folder (absolute, or relative to dir) to an mp4 / mov / webm file. Renders can take longer
      // than one HTTP request should, so POST starts a job and GET ?id=&wait= waits for it.
      if (req.method === 'GET') {
        const j = renderJobs.get(q.get('id') ?? '');
        if (!j) throw new HttpError(404, 'no such render job');
        const until = Date.now() + Math.min(240, Number(q.get('wait') ?? 0)) * 1000;
        while (j.state === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
        return json(res, 200, j);
      }
      const b = await body<{ dir?: string; folder: string; output?: string; format?: 'mp4' | 'mov' | 'webm'; fps?: number; quality?: 'draft' | 'looks' | 'delivery'; vars?: Record<string, unknown> }>(req);
      const folder = safePath(b.dir ? path.resolve(safePath(b.dir), b.folder) : b.folder);
      const output = b.output ? safePath(b.dir ? path.resolve(safePath(b.dir), b.output) : b.output) : undefined;
      if (b.format && !['mp4', 'mov', 'webm'].includes(b.format)) throw new HttpError(400, 'format: mp4, mov or webm');
      const id = Math.random().toString(36).slice(2, 10);
      const job: RenderJob = { id, state: 'running', folder };
      renderJobs.set(id, job);
      renderFolder(folder, { ...b, output }).then(
        (r) => Object.assign(job, { state: 'done', ...r }),
        (e: Error) => Object.assign(job, { state: 'error', error: e.message.split(/\r?\n/).slice(-6).join('\n') }),
      );
      return json(res, 200, job);
    }
    case '/api/comp/changed': {
      const b = await body<{ dir: string; clip?: string }>(req);
      broadcast(safePath(b.dir), { type: 'comp-changed', ...(b.clip && { clip: b.clip }) });
      return json(res, 200, { ok: true });
    }

    // the media toolbox: GPU models only (transcription, voices, sounds); see toolbox.ts
    case '/api/toolbox/status':
      return json(res, 200, await toolbox.status());
    case '/api/toolbox/library':
      return json(res, 200, { sounds: await viaToolbox(() => toolbox.library(q.get('q') ?? '')) });
    case '/api/toolbox/sfx': {
      const b = await body<{ prompt: string; seconds?: number; variations?: number }>(req);
      if (!b.prompt?.trim()) throw new HttpError(400, 'describe the sound');
      const seconds = Math.max(0.5, Math.min(47, Number(b.seconds) || 3));
      const variations = Math.max(1, Math.min(4, Math.round(Number(b.variations) || 3)));
      return json(res, 200, { sounds: await viaToolbox(() => toolbox.generateSfx(b.prompt.trim(), seconds, variations)) });
    }
    case '/api/toolbox/used': {
      const b = await body<{ dir: string; file: string }>(req);
      await viaToolbox(() => toolbox.markUsed(b.file, path.basename(safePath(b.dir))));
      return json(res, 200, { ok: true });
    }
    case '/api/toolbox/speak': {
      const b = await body<{ dir: string; text: string; voice?: string; clone?: string; speed?: number; name?: string }>(req);
      const dir = safePath(b.dir);
      if (!b.text?.trim()) throw new HttpError(400, 'type the line to say');
      const r = await viaToolbox(() => toolbox.speak(dir, b.text.trim(), b));
      return json(res, 200, { path: r.path, seconds: r.seconds ?? null });
    }
    case '/api/toolbox/transcribe': {
      // transcribe one source of the project; the editor then registers it (set_transcript) and links the clip
      const b = await body<{ dir: string; src: string; language?: string }>(req);
      const dir = safePath(b.dir);
      const file = safePath(path.resolve(dir, b.src));
      const r = await viaToolbox(() => toolbox.transcribe(dir, file, b.language));
      const rel = path.relative(dir, r.wordsTsv).split(path.sep).join('/');
      const words = parseWordsTsv(await fs.readFile(r.wordsTsv, 'utf-8'));
      return json(res, 200, { file: rel, words });
    }

    // export
    case '/api/export/plan':
      return json(res, 200, await plan(dirQ()));
    case '/api/export': {
      const b = await body<{ dir: string; range?: [number, number] }>(req);
      try {
        return json(res, 200, { job: startExport(safePath(b.dir), b.range) });
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
    }
    case '/api/export/job': {
      const id = q.get('id') ?? '';
      const j = q.has('wait') ? await waitFor(id, Math.min(600000, Number(q.get('wait')) * 1000)) : jobOf(id);
      if (!j) throw new HttpError(404, 'no such job');
      return json(res, 200, { job: j });
    }
    case '/api/export/otio': {
      const b = await body<{ dir: string }>(req);
      return json(res, 200, { path: await exportOtio(safePath(b.dir)) });
    }
    default:
      throw new HttpError(404, `no route ${url.pathname}`);
  }
}

/** /comp/<token>/<file>: a comp's folder; index.html gets the runtime and the clip's variables. */
async function comp(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const m = /^\/comp\/([\w-]+)\/(.*)$/.exec(url.pathname);
  if (!m) throw new HttpError(404, 'bad comp url');
  const folder = safePath(folderOf(m[1]!));
  const rel = decodeURIComponent(m[2] || 'index.html');
  const file = safePath(path.resolve(folder, rel));
  if (!file.toLowerCase().startsWith(folder.toLowerCase())) throw new HttpError(403, 'outside the comp');
  if (rel === 'index.html') {
    const html = await compPage(folder, url.searchParams.get('vars'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  return sendFile(req, res, file);
}

// --- server --------------------------------------------------------------------------------------
const LOCAL_HOSTS = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

/** The editor's own files: the prebuilt bundle when there is one, otherwise Vite in dev mode. */
async function editorPages(): Promise<(req: http.IncomingMessage, res: http.ServerResponse, url: URL, fail: (e: Error) => void) => void> {
  const built = await fs.stat(path.join(builtWeb, 'index.html')).then(
    (s) => s.isFile(),
    () => false,
  );
  if (built) {
    return (req, res, url, fail) => {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(builtWeb, rel || 'index.html');
      const inside = !path.relative(builtWeb, file).startsWith('..');
      const target = inside && path.extname(file) ? file : path.join(builtWeb, 'index.html'); // SPA fallback
      sendFile(req, res, target).catch(fail);
    };
  }
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { port: port + 1 } },
    appType: 'spa',
  });
  return (req, res) => vite.middlewares(req, res);
}

async function main() {
  const pages = await editorPages();
  const server = http.createServer((req, res) => {
    // DNS-rebinding guard: only answer requests addressed to this machine.
    if (!LOCAL_HOSTS.has(req.headers.host ?? '')) {
      res.writeHead(403).end('MangoAI only answers on localhost');
      return;
    }
    // Writes only from MangoAI's own pages or local tools (no cross-site form posts)
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, ''))) {
      res.writeHead(403).end('cross-origin writes are refused');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const fail = (e: Error) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { error: e.message, ...(e instanceof HttpError ? e.extra : {}) });
      else res.end();
    };
    if (url.pathname.startsWith('/api/')) return void api(req, res, url).catch(fail);
    if (url.pathname.startsWith('/comp/')) return void comp(req, res, url).catch(fail);
    if (url.pathname === '/hf-runtime.js') return void sendFile(req, res, HF_RUNTIME).catch(fail);
    pages(req, res, url, fail);
  });
  server.listen(port, '127.0.0.1', () => console.log(`MangoAI → http://localhost:${port}`));
}

void tokenOf;
void main();
