// HyperFrames comps in MangoAI: live preview pages (the comp's own index.html with the HyperFrames runtime
// injected, so the editor can seek it), versions you can flip between, scaffolding a new comp for a
// request, stills for Claude's own check, renders for export, and the folder watcher.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CompClip, Op, Project } from '@mangoai/core';
import { broadcast } from './events.js';
import { cacheOf, load, ownWrites } from './projects.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const HF_DIR = path.dirname(require.resolve('hyperframes/package.json'));
export const HF_BIN = path.join(HF_DIR, 'bin', 'hyperframes.mjs');
export const HF_RUNTIME = path.join(HF_DIR, 'dist', 'hyperframe.runtime.iife.js');
const SKIP = new Set(['node_modules', '.hyperframes', 'renders', '.git', '.mangoai']);

/** URL-safe token for a folder, so a comp's relative asset URLs resolve under /comp/<token>/. */
export const tokenOf = (abs: string) => Buffer.from(abs, 'utf-8').toString('base64url');
export const folderOf = (token: string) => Buffer.from(token, 'base64url').toString('utf-8');

export function compDir(dir: string, comp: string): string {
  return path.resolve(dir, comp);
}

/** The comp's index.html with variables and the runtime added; everything else as is. */
export async function compPage(folder: string, vars: string | null): Promise<string> {
  let html = await fs.readFile(path.join(folder, 'index.html'), 'utf-8');
  let v: unknown = {};
  try {
    v = vars ? JSON.parse(vars) : {};
  } catch {}
  const head = `<script>window.__hfVariables=${JSON.stringify(v).replace(/</g, '\\u003c')};window.__timelines=window.__timelines||{};window.__MANGO__=true;</script>` +
    '<style>html,body{background:transparent!important}</style>';
  const tail = '<script src="/hf-runtime.js"></script>';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : head + html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tail + '</body>') : html + tail;
  return html;
}

// --- versions -----------------------------------------------------------------------------------
interface VersionIndex {
  versions: { v: number; at: string; note?: string }[];
  /** The version the comp folder holds right now; null = edited since (not a saved version). */
  current: number | null;
}

const vdir = (dir: string, clip: string) => path.join(cacheOf(dir), 'versions', clip.replace(/[^\w.-]/g, '_'));
/** Folders we just wrote ourselves (a version switch), so the watcher doesn't call them edits. */
const quiet = new Map<string, number>();

async function readIndex(dir: string, clip: string): Promise<VersionIndex> {
  try {
    return JSON.parse(await fs.readFile(path.join(vdir(dir, clip), 'index.json'), 'utf-8'));
  } catch {
    return { versions: [], current: null };
  }
}

async function writeIndex(dir: string, clip: string, idx: VersionIndex) {
  await fs.mkdir(vdir(dir, clip), { recursive: true });
  await fs.writeFile(path.join(vdir(dir, clip), 'index.json'), JSON.stringify(idx, null, 1), 'utf-8');
}

async function copyTree(from: string, to: string) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b);
    else await fs.copyFile(a, b);
  }
}

/** Remove files in `to` that `from` doesn't have (outside the skipped folders). */
async function prune(from: string, to: string) {
  for (const e of await fs.readdir(to, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    const exists = await fs.stat(a).then(() => true, () => false);
    if (!exists) await fs.rm(b, { recursive: true, force: true });
    else if (e.isDirectory()) await prune(a, b);
  }
}

export async function versions(dir: string, clip: string): Promise<VersionIndex> {
  return readIndex(dir, clip);
}

/** Keep a copy of the comp as it is now (Claude does this before editing a comp). */
export async function snapshotVersion(dir: string, clip: string, comp: string, note?: string): Promise<number> {
  const idx = await readIndex(dir, clip);
  if (idx.current !== null) return idx.current; // unchanged since that version
  const v = (idx.versions[idx.versions.length - 1]?.v ?? 0) + 1;
  await copyTree(compDir(dir, comp), path.join(vdir(dir, clip), `v${v}`));
  idx.versions.push({ v, at: new Date().toISOString(), ...(note && { note }) });
  idx.current = v;
  await writeIndex(dir, clip, idx);
  return v;
}

/** Put version v back into the comp folder (the current state is kept as a version first). */
export async function switchVersion(dir: string, clip: string, comp: string, v: number) {
  const idx = await readIndex(dir, clip);
  if (!idx.versions.some((x) => x.v === v)) throw new Error(`no version ${v} of ${clip}`);
  if (idx.current === null) await snapshotVersion(dir, clip, comp, 'before switching');
  const from = path.join(vdir(dir, clip), `v${v}`);
  const to = compDir(dir, comp);
  quiet.set(path.resolve(to).toLowerCase(), Date.now());
  await copyTree(from, to);
  await prune(from, to);
  const idx2 = await readIndex(dir, clip);
  idx2.current = v;
  await writeIndex(dir, clip, idx2);
  broadcast(dir, { type: 'comp-changed', clip });
}

// --- new comps ------------------------------------------------------------------------------------
/** A HyperFrames comp sized to the frame, with a stage box where the request's region is. */
export async function scaffoldComp(
  dir: string,
  p: Project,
  o: { name: string; duration: number; region?: [number, number, number, number] | null; text?: string },
): Promise<string> {
  const rel = `animations/${o.name}`;
  const folder = path.join(dir, rel);
  if (await fs.stat(path.join(folder, 'index.html')).then(() => true, () => false)) throw new Error(`${rel} already exists`);
  await fs.mkdir(folder, { recursive: true });
  const [rx, ry, rw, rh] = o.region ?? [0.1, 0.35, 0.8, 0.3];
  const box = { x: Math.round(rx * p.width), y: Math.round(ry * p.height), w: Math.round(rw * p.width), h: Math.round(rh * p.height) };
  const d = Math.round(o.duration * 1000) / 1000;
  const id = o.name.replace(/[^\w-]/g, '-');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${p.width}, height=${p.height}" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${p.width}px; height: ${p.height}px; overflow: hidden; background: transparent; }
#root { position: relative; width: ${p.width}px; height: ${p.height}px; font-family: "Outfit", sans-serif; color: #F4F2EE; }
/* the box drawn in MangoAI for this request */
#${id}-stage { position: absolute; left: ${box.x}px; top: ${box.y}px; width: ${box.w}px; height: ${box.h}px;
  display: flex; align-items: center; justify-content: center; }
#${id}-title { font-size: ${Math.round(Math.min(box.h * 0.3, box.w / 8))}px; font-weight: 800; text-align: center; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${d}" data-width="${p.width}" data-height="${p.height}">
  <div id="${id}-stage">
    <div id="${id}-title">${escapeHtml(o.text ?? o.name)}</div>
  </div>
</div>
<script>
(function () {
  const tl = gsap.timeline({ paused: true });
  const D = ${d};
  tl.fromTo('#${id}-title', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out' }, 0);
  tl.to('#${id}-title', { opacity: 0, duration: 0.3, ease: 'power2.in' }, Math.max(0.5, D - 0.35));
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
</script>
</body>
</html>
`;
  await fs.writeFile(path.join(folder, 'index.html'), html, 'utf-8');
  return rel;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A graphics track free over [a, b) (no comp or title there), or ops that add one under the captions. */
export function freeGraphicsTrack(p: Project, clipsAt: (trackId: string) => [number, number][], a: number, b: number): { track: string; ops: Op[] } {
  const graphics = p.tracks.filter((t) => t.kind === 'graphics' && !t.locked);
  for (const t of [...graphics].reverse()) if (clipsAt(t.id).every(([s, e]) => e <= a + 1e-3 || s >= b - 1e-3)) return { track: t.id, ops: [] };
  let n = 1;
  while (p.tracks.some((t) => t.id === `G${n}`)) n++;
  const caps = p.tracks.findIndex((t) => t.kind === 'captions');
  const index = caps >= 0 ? caps : p.tracks.filter((t) => t.kind !== 'audio').length;
  return { track: `G${n}`, ops: [{ op: 'add_track', track: { id: `G${n}`, kind: 'graphics', name: 'Animations', clips: [] }, index }] };
}

// --- stills and renders ---------------------------------------------------------------------------
export async function hyperframes(args: string[], cwd?: string, timeout = 600000): Promise<string> {
  const { stdout, stderr } = await run(process.execPath, [HF_BIN, ...args], { cwd, timeout, maxBuffer: 32 << 20, env: { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: '1', HF_NO_TELEMETRY: '1' } });
  return stdout + stderr;
}

/** Stills of one comp at clip-local times, on mid-grey (so white and transparent parts both show). */
export async function compStills(dir: string, clip: CompClip, times: number[], vars: Record<string, unknown> = {}): Promise<string[]> {
  const folder = compDir(dir, clip.comp);
  const out = path.join(cacheOf(dir), 'stills', clip.id.replace(/[^\w.-]/g, '_'));
  await fs.rm(out, { recursive: true, force: true });
  const raw = path.join(out, 'raw');
  const pngs = await snapshot(folder, times, raw, vars);
  const done: string[] = [];
  for (const [i, f] of pngs.entries()) {
    const dest = path.join(out, `still-${i + 1}-at-${times[i]!.toFixed(2)}s.png`);
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=16x16', '-i', f, '-filter_complex', '[0][1]scale2ref[bg][fg];[bg][fg]overlay=format=auto', '-frames:v', '1', dest]);
    done.push(dest);
  }
  return done;
}

/** Transparent PNGs of a comp at the given local times. */
export async function snapshot(folder: string, times: number[], out: string, vars: Record<string, unknown> = {}): Promise<string[]> {
  await fs.rm(out, { recursive: true, force: true });
  // (the snapshot command has no variables option: stills use the comp's declared defaults)
  void vars;
  const args = ['snapshot', folder, '--at', times.map((t) => t.toFixed(3)).join(','), '--no-end', '--output', out];
  await hyperframes(args, folder, 180000);
  const files = (await fs.readdir(out)).filter((f) => /^frame-.*\.png$/.test(f)).sort();
  return files.map((f) => path.join(out, f));
}

/** Hash of everything a comp render depends on: its files, the variables, length, size and fps. */
export async function compHash(folder: string, extra: unknown): Promise<string> {
  const h = createHash('sha1');
  const walk = async (d: string) => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else {
        const st = await fs.stat(f);
        h.update(`${path.relative(folder, f)}:${st.size}:${Math.round(st.mtimeMs)}\n`);
      }
    }
  };
  await walk(folder);
  h.update(JSON.stringify(extra));
  return h.digest('hex').slice(0, 16);
}

/** Render a comp to a transparent .mov (ProRes 4444) for export; cached by hash. */
export async function renderComp(dir: string, clip: CompClip, opts: { fps: number; dur: number; vars: Record<string, unknown>; width: number; height: number }, log: (m: string) => void): Promise<{ file: string; cached: boolean }> {
  const folder = compDir(dir, clip.comp);
  const key = await compHash(folder, { ...opts, v: 1 });
  const file = path.join(cacheOf(dir), 'renders', `comp-${key}.mov`);
  if (await fs.stat(file).then((s) => s.size > 0, () => false)) return { file, cached: true };
  await fs.mkdir(path.dirname(file), { recursive: true });
  log(`rendering comp ${clip.id} (${clip.comp})`);
  const tmp = `${file}.tmp.mov`;
  const args = ['render', folder, '--output', tmp, '--format', 'mov', '--fps', String(opts.fps), '--quality', 'looks'];
  if (Object.keys(opts.vars).length) args.push('--variables', JSON.stringify(opts.vars));
  await hyperframes(args, folder, 3600000);
  await fs.rename(tmp, file);
  return { file, cached: false };
}

/** Folders nothing may be written into (raw recordings). */
const PROTECTED = (process.env.MANGO_PROTECTED_DIRS ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'media-studio', 'recordings'))
  .split(';')
  .filter(Boolean)
  .map((d) => path.resolve(d).toLowerCase() + path.sep);

/**
 * Render any HyperFrames folder to a file: a whole-shot graphic for a short.json, a single-composition video, a
 * transparent overlay (mov). The one HyperFrames renderer in the studio (the toolbox no longer has one).
 */
export async function renderFolder(
  folder: string,
  o: { output?: string; format?: 'mp4' | 'mov' | 'webm'; fps?: number; quality?: 'draft' | 'looks' | 'delivery'; vars?: Record<string, unknown> },
): Promise<{ output: string; seconds: number }> {
  if (!(await fs.stat(path.join(folder, 'index.html')).then(() => true, () => false))) throw new Error(`no index.html in ${folder}`);
  const format = o.format ?? 'mp4';
  const output = path.resolve(o.output ?? path.join(folder, 'renders', `${path.basename(folder)}.${format}`));
  if (PROTECTED.some((d) => (output.toLowerCase() + path.sep).startsWith(d))) throw new Error(`${output} is in a protected folder (raw recordings are read-only)`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const t0 = Date.now();
  const tmp = `${output}.tmp.${format}`;
  const args = ['render', folder, '--output', tmp, '--format', format, '--fps', String(o.fps ?? 30), '--quality', o.quality ?? 'looks'];
  if (o.vars && Object.keys(o.vars).length) args.push('--variables', JSON.stringify(o.vars));
  await hyperframes(args, folder, 3600000);
  await fs.rm(output, { force: true });
  await fs.rename(tmp, output);
  return { output, seconds: (Date.now() - t0) / 1000 };
}

export async function compCached(dir: string, clip: CompClip, opts: { fps: number; dur: number; vars: Record<string, unknown>; width: number; height: number }): Promise<boolean> {
  try {
    const key = await compHash(compDir(dir, clip.comp), { ...opts, v: 1 });
    return await fs.stat(path.join(cacheOf(dir), 'renders', `comp-${key}.mov`)).then((s) => s.size > 0, () => false);
  } catch {
    return false;
  }
}

// --- the folder watcher -------------------------------------------------------------------------------
const watchers = new Map<string, FSWatcher>();

/** Watch a project folder: cut.json edited outside, transcripts re-made, comp files changed. */
export function watchProject(dir: string) {
  const key = path.resolve(dir).toLowerCase();
  if (watchers.has(key)) return;
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = async () => {
    timer = null;
    const files = [...pending];
    pending.clear();
    try {
      const st = await load(dir);
      const p = st.project;
      if (files.some((f) => f === 'cut.json')) {
        const m = (await fs.stat(path.join(dir, 'cut.json')).catch(() => null))?.mtimeMs;
        if (m !== undefined && Math.abs((ownWrites.get(key) ?? 0) - m) > 1) {
          const fresh = await load(dir, true);
          broadcast(dir, { type: 'saved', revision: fresh.project.revision, base: -1, author: 'claude', label: 'cut.json was changed on disk' });
        }
      }
      const tsv = new Set(Object.values(p.transcripts).map((t) => path.normalize(t).toLowerCase()));
      if (files.some((f) => tsv.has(path.normalize(f).toLowerCase()))) {
        await load(dir, true);
        broadcast(dir, { type: 'words-changed' });
      }
      const changedComps = new Set<string>();
      for (const t of p.tracks)
        for (const c of t.clips) {
          if (c.type !== 'comp') continue;
          const rel = path.normalize(c.comp).toLowerCase();
          if (files.some((f) => path.normalize(f).toLowerCase().startsWith(rel + path.sep))) changedComps.add(c.id);
        }
      for (const id of changedComps) {
        const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === id) as CompClip;
        const q = quiet.get(compDir(dir, c.comp).toLowerCase());
        if (!q || Date.now() - q > 3000) {
          const idx = await readIndex(dir, id);
          if (idx.current !== null) await writeIndex(dir, id, { ...idx, current: null });
        }
        broadcast(dir, { type: 'comp-changed', clip: id });
      }
    } catch {}
  };
  try {
    const w = watch(dir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const f = String(name);
      if (/^(\.mangoai|renders|node_modules|\.git)[\\/]/.test(f) || /[\\/]\.hyperframes[\\/]/.test(f) || f.endsWith('.tmp')) return;
      pending.add(f);
      if (!timer) timer = setTimeout(() => void flush(), 400);
    });
    watchers.set(key, w);
  } catch {}
}

export function spawnDetached(cmd: string, args: string[]) {
  spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false }).unref();
}
