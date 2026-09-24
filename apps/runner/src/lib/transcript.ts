import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';
import { findRawVideo } from './video.js';
import { log } from './log.js';
import { readJson, writeJsonAtomic } from './store.js';
import { spawnHidden, runCommand } from './proc.js';
import { ffmpegBin, ffprobeBin } from './bin.js';
import { assertFreeSpace } from './disk.js';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const transcriptFile = (id: string) => path.join(projectDir(id), '01_transcript', 'transcript.json');
// Whisper accepts at most 25 MB per request. Audio is sent in pieces of this length, which at the
// extraction bitrate (64 kbps) is about 14 MB, so any video length works.
const CHUNK_SECONDS = Number(process.env.MANGO_TRANSCRIBE_CHUNK_SECONDS) || 30 * 60;
const MAX_WHISPER_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 4;

export function readTranscript(id: string): TranscriptSegment[] {
  const file = transcriptFile(id);
  if (!fs.existsSync(file)) return [];
  const data = readJson<{ segments?: TranscriptSegment[] }>(file);
  return data.segments ?? [];
}

// Lets the editor persist manual corrections to a transcript (e.g. fixing a misheard word)
// without re-running Whisper.
export function writeTranscript(id: string, segments: TranscriptSegment[]): void {
  const file = transcriptFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { segments });
}

function runFfmpeg(args: string[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(ffmpegBin(), args);
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${what} failed (exit code ${code}): ${stderr.slice(-500)}`));
    });
    child.on('error', (err) => {
      reject(new Error(`Could not run ffmpeg (is it installed and on PATH?): ${err.message}`));
    });
  });
}

// Strips the (often large) video stream and re-encodes just the audio as a low-bitrate
// mono mp3 — typically 10-20x smaller than the source video, and Whisper transcribes it
// just as well since it resamples internally regardless of input quality.
const extractAudio = (videoPath: string, outPath: string) =>
  runFfmpeg(['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', outPath], 'audio extraction');

async function audioDuration(file: string): Promise<number> {
  const result = await runCommand(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

async function splitAudio(audioPath: string, dir: string): Promise<string[]> {
  const pattern = path.join(dir, 'chunk_%03d.mp3');
  await runFfmpeg(['-y', '-i', audioPath, '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-c', 'copy', '-reset_timestamps', '1', pattern], 'audio splitting');
  return fs
    .readdirSync(dir)
    .filter((f) => /^chunk_\d+\.mp3$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

// Turns an OpenAI failure into something the user can act on.
export function explainOpenAIError(status: number, body: string): string {
  let detail = '';
  try {
    detail = (JSON.parse(body) as { error?: { message?: string; code?: string } }).error?.message ?? '';
  } catch {
    detail = body.slice(0, 200);
  }
  if (status === 401) return 'OpenAI rejected your API key. Enter it again in the Status panel.';
  if (status === 403) return 'OpenAI refused the request (403). The key may lack access to transcription.';
  if (status === 429) return /quota|billing|credit/i.test(detail) ? 'Your OpenAI account is out of credit. Add credit or check billing, then try again.' : 'OpenAI is rate limiting this key. Wait a minute and try again.';
  if (status >= 500) return `OpenAI is having problems (${status}). Try again in a few minutes.`;
  return `OpenAI transcription failed (${status})${detail ? `: ${detail}` : ''}`;
}

class RetryableError extends Error {}

async function transcribeChunk(file: string, apiKey: string, label: string): Promise<TranscriptSegment[]> {
  let lastError: Error = new Error('unknown');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(file)]), 'audio.mp3');
      form.append('model', 'whisper-1');
      form.append('response_format', 'verbose_json');
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text();
        const message = explainOpenAIError(response.status, body);
        // Rate limits and server errors are worth another try (unless the account is out of credit); a bad key is not.
        const transient = response.status >= 500 || (response.status === 429 && !/out of credit/.test(message));
        if (transient) throw new RetryableError(message);
        throw new Error(message);
      }
      const data = (await response.json()) as { segments?: Array<{ start: number; end: number; text: string }> };
      return (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const network = err instanceof TypeError; // fetch reports connection failures as TypeError
      if (err instanceof RetryableError || timedOut || network) {
        lastError = new Error(timedOut ? 'OpenAI did not answer in time.' : network ? 'Could not reach OpenAI. Check your internet connection.' : (err as Error).message);
        if (attempt < MAX_ATTEMPTS) {
          const delay = 1000 * 3 ** (attempt - 1);
          log('warn', 'transcribe.retry', { chunk: label, attempt, delayMs: delay, error: lastError.message });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// Extracts the audio, sends it to Whisper (in pieces when it is long) and stores the segments.
export async function transcribeProject(id: string): Promise<TranscriptSegment[]> {
  const videoPath = findRawVideo(id);
  if (!videoPath) throw new Error('No video uploaded for this project');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('No OpenAI API key is set. Add it in the Status panel to transcribe.');

  const workDir = path.join(projectDir(id), '01_transcript');
  const audioPath = path.join(workDir, 'audio.mp3');
  const chunkDir = path.join(workDir, 'chunks');
  const started = Date.now();
  log('info', 'transcribe.start', { project: id });
  assertFreeSpace(workDir, 300 * 1024 ** 2, 'the audio extraction');

  try {
    await extractAudio(videoPath, audioPath);
    const audioSize = fs.statSync(audioPath).size;
    const duration = await audioDuration(audioPath);
    log('info', 'transcribe.audio', { project: id, audioMB: Math.round((audioSize / 1024 / 1024) * 10) / 10, seconds: Math.round(duration) });

    let files: string[];
    if (audioSize <= MAX_WHISPER_BYTES && duration <= CHUNK_SECONDS * 1.5) {
      files = [audioPath];
    } else {
      fs.rmSync(chunkDir, { recursive: true, force: true });
      fs.mkdirSync(chunkDir, { recursive: true });
      files = await splitAudio(audioPath, chunkDir);
      if (files.length === 0) throw new Error('Could not split the audio for transcription.');
      const tooBig = files.find((f) => fs.statSync(f).size > MAX_WHISPER_BYTES);
      if (tooBig) throw new Error('A piece of the audio is still larger than OpenAI allows (25 MB). Trim the video and try again.');
    }

    const segments: TranscriptSegment[] = [];
    let offset = 0;
    for (const [index, file] of files.entries()) {
      const label = `${index + 1}/${files.length}`;
      const part = await transcribeChunk(file, apiKey, label);
      for (const s of part) segments.push({ start: s.start + offset, end: s.end + offset, text: s.text });
      offset += files.length > 1 ? (await audioDuration(file)) || CHUNK_SECONDS : 0;
      log('info', 'transcribe.chunk', { project: id, chunk: label, segments: part.length });
    }

    writeTranscript(id, segments);
    log('info', 'transcribe.done', { project: id, segments: segments.length, chunks: files.length, ms: Date.now() - started });
    return segments;
  } finally {
    fs.rmSync(audioPath, { force: true });
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}

export function transcriptForRange(id: string, start: number, end: number): TranscriptSegment[] {
  return readTranscript(id).filter((s) => s.start < end && s.end > start);
}
