// Media helpers: probing, waveform peaks, browser-playable proxies. Results are cached in the project's
// .mangoai/ folder, keyed by the file's path, size and mtime, so they're computed once per file version.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type MediaKind = 'video' | 'audio' | 'image' | 'other';

export interface MediaInfo {
  path: string;
  kind: MediaKind;
  exists: boolean;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  /** false: the browser can't play it directly, a proxy is used. */
  playable?: boolean;
}

const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.opus']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const BROWSER_VIDEO = new Set(['.mp4', '.webm', '.m4v', '.mov']);

export function kindOf(file: string): MediaKind {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (IMAGE.has(ext)) return 'image';
  return 'other';
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
  });
}

async function cacheKey(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file);
    return crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

async function readCache<T>(dir: string, key: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function writeCache(dir: string, key: string, value: unknown) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(value));
}

export async function probe(file: string, cacheDir: string): Promise<MediaInfo> {
  const kind = kindOf(file);
  const key = await cacheKey(file);
  if (!key) return { path: file, kind, exists: false };
  const dir = path.join(cacheDir, 'probe');
  const hit = await readCache<MediaInfo>(dir, key);
  if (hit) return hit;
  const info: MediaInfo = { path: file, kind, exists: true };
  const r = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (r.code === 0) {
    const j = JSON.parse(r.stdout.toString()) as {
      format?: { duration?: string };
      streams?: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string; codec_name?: string }[];
    };
    const v = j.streams?.find((s) => s.codec_type === 'video');
    const d = Number(j.format?.duration);
    if (Number.isFinite(d)) info.duration = d;
    if (v?.width) info.width = v.width;
    if (v?.height) info.height = v.height;
    if (v?.avg_frame_rate && kind === 'video') {
      const [n, dd] = v.avg_frame_rate.split('/').map(Number);
      if (n && dd) info.fps = n / dd;
    }
    info.hasAudio = !!j.streams?.some((s) => s.codec_type === 'audio');
    if (kind === 'video') {
      const ext = path.extname(file).toLowerCase();
      info.playable = BROWSER_VIDEO.has(ext) && ['h264', 'vp9', 'av1', 'vp8'].includes(v?.codec_name ?? '');
    }
  }
  await writeCache(dir, key, info);
  return info;
}

export interface Peaks {
  /** Peak pairs per second. */
  rate: number;
  duration: number;
  /** Integrated loudness (LUFS), for preview levelling like the toolbox's loudnorm. */
  lufs: number | null;
  /** base64 of Int8 [min, max] pairs. */
  data: string;
}

const PEAK_RATE = 100; // pairs per second: 50 min = 300k pairs = 600 KB, fine to draw at any zoom
const PCM_RATE = 8000;

export async function peaks(file: string, cacheDir: string): Promise<Peaks | null> {
  const key = await cacheKey(file);
  if (!key) return null;
  const dir = path.join(cacheDir, 'peaks');
  const hit = await readCache<Peaks>(dir, key);
  if (hit) return hit;
  // one decode: mono 8 kHz PCM for the peaks, ebur128 summary on stderr for loudness
  const r = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-vn',
    '-filter_complex', `[0:a:0]asplit=2[a][b];[a]ebur128=framelog=quiet[e];[e]anullsink;[b]aresample=${PCM_RATE},aformat=sample_fmts=s16:channel_layouts=mono[p]`,
    '-map', '[p]', '-f', 's16le', 'pipe:1',
  ]);
  if (r.code !== 0) return null;
  const samples = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.byteLength / 2));
  const per = PCM_RATE / PEAK_RATE;
  const n = Math.ceil(samples.length / per);
  const out = new Int8Array(n * 2);
  for (let i = 0; i < n; i++) {
    let mn = 0;
    let mx = 0;
    const end = Math.min(samples.length, (i + 1) * per);
    for (let j = i * per; j < end; j++) {
      const s = samples[j]!;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    out[i * 2] = Math.round(mn / 258);
    out[i * 2 + 1] = Math.round(mx / 258);
  }
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.split('Summary:').pop() ?? '');
  const result: Peaks = {
    rate: PEAK_RATE,
    duration: samples.length / PCM_RATE,
    lufs: m ? Number(m[1]) : null,
    data: Buffer.from(out.buffer).toString('base64'),
  };
  await writeCache(dir, key, result);
  return result;
}

const proxyJobs = new Map<string, Promise<boolean>>();
const proxyFailed = new Set<string>();

export type ProxyState = { ready: string } | { pending: true } | { failed: true };

/** A 960-wide-or-less H.264 copy with 1 s keyframes (fast seeking). Starts the job on first ask. */
export async function proxyState(file: string, cacheDir: string): Promise<ProxyState> {
  const key = await cacheKey(file);
  if (!key) return { failed: true };
  const out = path.join(cacheDir, 'proxies', `${key}.mp4`);
  try {
    await fs.access(out);
    return { ready: out };
  } catch {}
  if (proxyFailed.has(out)) return { failed: true };
  if (!proxyJobs.has(out)) {
    const job = (async () => {
      await fs.mkdir(path.dirname(out), { recursive: true });
      const tmp = `${out}.part.mp4`;
      const r = await run('ffmpeg', [
        '-hide_banner', '-y', '-i', file, '-vf', "scale='min(960,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '26', '-g', '30', '-keyint_min', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp,
      ]);
      if (r.code !== 0) {
        proxyFailed.add(out);
        return false;
      }
      await fs.rename(tmp, out);
      return true;
    })().finally(() => proxyJobs.delete(out));
    proxyJobs.set(out, job);
  }
  return { pending: true };
}
