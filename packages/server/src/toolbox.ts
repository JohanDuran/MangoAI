// The media toolbox (github.com/JohanDuran/media-toolbox) runs the GPU models in Docker: transcription,
// voices, sound generation and the shared sound library. MangoAI owns editing and rendering, and calls the
// toolbox only for those models, through its REST API. When the toolbox isn't running, editing still works;
// these calls fail with a clear message.
import fs from 'node:fs/promises';
import path from 'node:path';

export const TOOLBOX_URL = (process.env.MANGO_TOOLBOX_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');

export class ToolboxError extends Error {}

const DOWN = `The media toolbox isn't reachable at ${TOOLBOX_URL}. Start Docker Desktop (the toolbox starts with it), then try again.`;

async function call<T>(method: 'GET' | 'POST', route: string, payload?: unknown, timeoutMs = 15_000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${TOOLBOX_URL}${route}`, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new ToolboxError(`The media toolbox didn't answer ${route} in time.`);
    throw new ToolboxError(DOWN);
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { detail?: string }).detail ?? text;
    } catch {}
    throw new ToolboxError(`toolbox ${route}: ${msg}`);
  }
  return JSON.parse(text) as T;
}

export interface ToolboxStatus {
  up: boolean;
  url: string;
  workers?: Record<string, unknown>;
  voices?: string[];
  error?: string;
}

/** Is it up, and which cloned-voice profiles exist (the toolbox reads them from its voices folder). */
export async function status(): Promise<ToolboxStatus> {
  try {
    const st = await call<{ workers?: Record<string, unknown>; config?: Record<string, unknown> }>('GET', '/api/state', undefined, 3000);
    return { up: true, url: TOOLBOX_URL, workers: st.workers, voices: await voiceProfiles() };
  } catch (e) {
    return { up: false, url: TOOLBOX_URL, error: (e as Error).message };
  }
}

const VOICES_DIR = process.env.MANGO_VOICES_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'media-studio', 'voices');

async function voiceProfiles(): Promise<string[]> {
  try {
    return (await fs.readdir(VOICES_DIR)).filter((f) => f.toLowerCase().endsWith('.wav')).map((f) => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
}

interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | string;
  result?: unknown;
  error?: string | null;
}

/** Run one toolbox job and wait for it (transcription of a long file can take minutes). */
export async function run<T>(tool: string, params: Record<string, unknown>, maxSeconds = 1800): Promise<T> {
  const job = await call<Job>('POST', '/api/jobs', { tool, params, source: 'mangoai' });
  const until = Date.now() + maxSeconds * 1000;
  let j = job;
  while (j.status !== 'done' && j.status !== 'error' && j.status !== 'cancelled') {
    if (Date.now() > until) throw new ToolboxError(`${tool} is still running after ${maxSeconds} s (job ${job.id}); see ${TOOLBOX_URL}`);
    j = await call<Job>('POST', `/api/jobs/${job.id}/wait?timeout=60`, undefined, 75_000);
  }
  if (j.status !== 'done') throw new ToolboxError(`${tool} ${j.status}: ${j.error ?? 'no details'}`);
  return j.result as T;
}

export interface LibraryEntry {
  file: string;
  path: string;
  prompt?: string;
  seconds?: number;
  status?: string;
  tags?: string[];
  used_in?: string[];
  peak_db?: number;
}

/** Search the shared sound library (rejected sounds are left out). */
export async function library(q: string): Promise<LibraryEntry[]> {
  const all = await call<LibraryEntry[]>('GET', `/api/library?q=${encodeURIComponent(q)}`);
  return all.filter((e) => e.status !== 'reject');
}

/** Record that a library sound is used in this project (the library's `used_in`). */
export async function markUsed(file: string, project: string): Promise<void> {
  await call('POST', '/api/library/mark', { file, used_in: project });
}

export async function generateSfx(prompt: string, seconds: number, variations: number): Promise<LibraryEntry[]> {
  const r = await run<{ entries: LibraryEntry[] }>('generate_sfx', { prompt, seconds, variations });
  return r.entries;
}

/** Transcribe a media file into <project>/transcripts; returns the .words.tsv MangoAI reads. */
export async function transcribe(dir: string, file: string, language?: string): Promise<{ wordsTsv: string; source: string }> {
  const out = path.join(dir, 'transcripts');
  await fs.mkdir(out, { recursive: true });
  const r = await run<{ files: { source: string; outputs: string[] }[] }>('transcribe', { files: [file], out_dir: out, ...(language && { language }) });
  const f = r.files[0];
  const tsv = f?.outputs.find((o) => o.toLowerCase().endsWith('.words.tsv'));
  if (!f || !tsv) throw new ToolboxError(`transcribe: no .words.tsv came back for ${file}`);
  return { wordsTsv: tsv, source: f.source };
}

export interface SpeakResult {
  path: string;
  seconds?: number;
}

/** A voiceover line into <project>/audio/lines: Kokoro by default, or a cloned voice profile. */
export async function speak(dir: string, text: string, opts: { voice?: string; clone?: string; speed?: number; name?: string }): Promise<SpeakResult> {
  const out = path.join(dir, 'audio', 'lines');
  await fs.mkdir(out, { recursive: true });
  const slug = (opts.name ?? text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'line';
  let file = path.join(out, `${slug}.wav`);
  for (let i = 2; await exists(file); i++) file = path.join(out, `${slug}-${i}.wav`);
  if (opts.clone) return run<SpeakResult>('speak_clone', { text, voice: opts.clone, out_path: file });
  return run<SpeakResult>('speak', { text, out_path: file, ...(opts.voice && { voice: opts.voice }), ...(opts.speed && { speed: opts.speed }) });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
