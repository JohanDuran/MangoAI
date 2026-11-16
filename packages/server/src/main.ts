// MangoAI local server. Binds to 127.0.0.1 only, serves files only from under the user's home folder,
// and never writes outside a project's .mangoai/ cache (phase 1 is read-only for project files).
//   npm start                       → http://localhost:4780
//   npm start -- --port 4790
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFolder, loadWords } from '@mangoai/core/node';
import type { Project } from '@mangoai/core';
import { kindOf, peaks, probe, proxyState, type MediaInfo } from './media.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../web');
const HOME = path.resolve(os.homedir());
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || Number(process.env.MANGOAI_PORT) || 4780;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Only paths under the home folder, resolved (no ../ escapes). */
function safePath(p: string | null): string {
  if (!p) throw new HttpError(400, 'path is required');
  const abs = path.resolve(p);
  const rel = path.relative(HOME, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, 'only files under your home folder');
  return abs;
}

const cacheOf = (dir: string) => path.join(dir, '.mangoai');

async function studioRoot(): Promise<string> {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(HOME, '.video-studio', 'config.json'), 'utf-8')) as { studio?: string };
    if (cfg.studio) return path.resolve(cfg.studio);
  } catch {}
  return HOME;
}

// --- API ---------------------------------------------------------------------------------------

function mediaSrcs(p: Project): string[] {
  const out = new Set<string>();
  for (const t of p.tracks)
    for (const c of t.clips) {
      if (c.type === 'media') out.add(c.src);
      if (c.type === 'generator' && typeof c.params.image === 'string') out.add(c.params.image);
    }
  return [...out];
}

export interface OpenedMedia extends MediaInfo {
  url: string;
}

async function apiOpen(dir: string) {
  const { project, from } = await openFolder(dir);
  const transcript = Object.values(project.transcripts)[0];
  const words = transcript ? await loadWords(dir, transcript) : undefined;
  const media: Record<string, OpenedMedia> = {};
  await Promise.all(
    mediaSrcs(project).map(async (src) => {
      const abs = path.resolve(dir, project.sources[src] ?? src);
      const info = await probe(abs, cacheOf(dir));
      const q = `path=${encodeURIComponent(abs)}&dir=${encodeURIComponent(dir)}`;
      media[src] = { ...info, url: info.kind === 'video' && info.playable === false ? `/api/proxy?${q}` : `/api/file?${q}` };
    }),
  );
  return { dir, name: path.basename(dir), from, project, words: words?.words ?? null, media };
}

const SKIP = new Set(['.mangoai', 'node_modules', '.git']);

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
  '.json': 'application/json', '.tsv': 'text/tab-separated-values', '.md': 'text/markdown', '.html': 'text/html',
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

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/open':
      return json(res, 200, await apiOpen(safePath(q.get('dir'))));
    case '/api/pool':
      return json(res, 200, await apiPool(safePath(q.get('dir'))));
    case '/api/browse':
      return json(res, 200, await apiBrowse(q.get('dir')));
    case '/api/file':
      return sendFile(req, res, safePath(q.get('path')));
    case '/api/peaks': {
      const p = await peaks(safePath(q.get('path')), cacheOf(safePath(q.get('dir'))));
      return p ? json(res, 200, p) : json(res, 404, { error: 'no audio' });
    }
    case '/api/snapshot': {
      // a PNG of the live viewer, posted by the page (for Claude's frame checks); kept in .mangoai/snapshots
      if (req.method !== 'POST') throw new HttpError(405, 'POST a PNG');
      const dir = safePath(q.get('dir'));
      const name = (q.get('name') ?? `frame-${Date.now()}`).replace(/[^\w.-]/g, '_');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 30e6) throw new HttpError(413, 'too large');
        chunks.push(c as Buffer);
      }
      const out = path.join(cacheOf(dir), 'snapshots', `${name}.png`);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, Buffer.concat(chunks));
      return json(res, 200, { path: out });
    }
    case '/api/proxy': {
      const state = await proxyState(safePath(q.get('path')), cacheOf(safePath(q.get('dir'))));
      if ('ready' in state) return sendFile(req, res, state.ready);
      if ('pending' in state) return json(res, 202, { pending: true });
      return json(res, 500, { error: 'proxy failed' });
    }
    default:
      throw new HttpError(404, `no route ${url.pathname}`);
  }
}

// --- server --------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

async function main() {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { port: port + 1 } },
    appType: 'spa',
  });
  const server = http.createServer((req, res) => {
    // DNS-rebinding guard: only answer requests addressed to this machine.
    if (!LOCAL_HOSTS.has(req.headers.host ?? '')) {
      res.writeHead(403).end('MangoAI only answers on localhost');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((e: Error) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(e);
        if (!res.headersSent) json(res, status, { error: e.message });
        else res.end();
      });
      return;
    }
    vite.middlewares(req, res);
  });
  server.listen(port, '127.0.0.1', () => console.log(`MangoAI → http://localhost:${port}`));
}

void main();
