import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inputDir, PROJECTS_ROOT } from './paths.js';
import { readMarkers, writeMarkers, type Marker, type MarkerNarration, type SpokenWord } from './markers.js';
import { explainOpenAIError } from './transcript.js';
import { runCommand } from './proc.js';
import { ffprobeBin } from './bin.js';
import { readCompositionConfig } from './composition.js';
import { lengthIsFixed } from './timeline.js';
import { log } from './log.js';

// Voiceover: each marker can carry one spoken line, turned into speech with OpenAI's speech API
// and played from the marker's start. The audio lives next to the markers, not in the generated
// overlay code, so changing the words or the voice never needs Claude.

export const TTS_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const;
export const DEFAULT_VOICE = 'marin';
// OpenAI's limit for one request.
export const MAX_NARRATION_CHARS = 4096;
const TTS_MODEL = () => process.env.MANGO_TTS_MODEL || 'gpt-4o-mini-tts';
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// A voice is never sped up or cut: its marker is made long enough to hold it, with this much air
// after the last word.
export const VOICE_TAIL_SEC = 0.2;
// Files are named after the marker and a hash of what was spoken, so a new take never reuses a URL
// the browser has cached and the files of one marker are easy to find.
const NARRATION_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,80})-([0-9a-f]{12})\.mp3$/;

export const isValidVoice = (v: unknown): v is string => typeof v === 'string' && (TTS_VOICES as readonly string[]).includes(v);

export const narrationDir = (id: string) => path.join(inputDir(id), 'voice');

// The path of a narration file, or null for anything that is not one (the name comes from a URL).
export function narrationFilePath(id: string, file: string): string | null {
  if (!NARRATION_FILE.test(file)) return null;
  const full = path.join(narrationDir(id), file);
  return fs.existsSync(full) ? full : null;
}

// The narration a marker will actually play: generated, matching its current line, and on disk.
export function playableNarration(id: string, marker: Marker): { file: string; durationSec: number } | null {
  const n = marker.narration;
  if (!n?.audio || n.audio.text !== n.text || n.audio.voice !== n.voice) return null;
  const file = narrationFilePath(id, n.audio.file);
  return file ? { file, durationSec: n.audio.durationSec } : null;
}

// Removes a marker's narration files, except those in `keep`.
export function removeNarrationFiles(id: string, markerId: string, keep: string[] = []): void {
  const dir = narrationDir(id);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const m = NARRATION_FILE.exec(f);
    if (m && m[1] === markerId && !keep.includes(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function updateNarration(id: string, markerId: string, change: (current: MarkerNarration | undefined) => MarkerNarration | undefined): Marker {
  const markers = readMarkers(id);
  const marker = markers.find((m) => m.marker_id === markerId);
  if (!marker) throw new Error(`Marker ${markerId} not found in project ${id}`);
  const next = change(marker.narration);
  if (next) marker.narration = next;
  else delete marker.narration;
  writeMarkers(id, markers);
  return marker;
}

// Saves the line and voice. An empty line removes the narration and its audio. The audio already
// generated is kept until a new take replaces it, so undoing an edit needs no new request.
export function setMarkerNarration(id: string, markerId: string, input: { text: string; voice: string }): Marker {
  const text = input.text.trim();
  if (text.length > MAX_NARRATION_CHARS) throw new Error(`The voiceover line is too long (${text.length} characters, at most ${MAX_NARRATION_CHARS}).`);
  if (!isValidVoice(input.voice)) throw new Error(`Unknown voice "${input.voice}".`);
  const marker = updateNarration(id, markerId, (current) => (text ? { ...current, text, voice: input.voice } : undefined));
  if (!text) removeNarrationFiles(id, markerId);
  return marker;
}

class RetryableError extends Error {}

async function requestSpeech(text: string, voice: string, signal?: AbortSignal): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('No OpenAI API key is set. Add it in the Status panel to generate voiceovers.');
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let lastError: Error = new Error('unknown');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TTS_MODEL(),
          voice,
          input: text,
          response_format: 'mp3',
          ...(TTS_MODEL().startsWith('tts-1') ? {} : { instructions: 'Read this as a clear, natural voiceover for a video.' }),
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        const message = explainOpenAIError(response.status, await response.text(), 'speech generation');
        const transient = response.status >= 500 || (response.status === 429 && !/out of credit/.test(message));
        throw transient ? new RetryableError(message) : new Error(message);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) throw new RetryableError('OpenAI returned no audio.');
      return audio;
    } catch (err) {
      if (signal?.aborted) throw new Error('Stopped.');
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const network = err instanceof TypeError;
      if (!(err instanceof RetryableError || timedOut || network)) throw err;
      lastError = new Error(timedOut ? 'OpenAI did not answer in time.' : network ? 'Could not reach OpenAI. Check your internet connection.' : (err as Error).message);
      if (attempt < MAX_ATTEMPTS) {
        const delay = 1000 * 3 ** (attempt - 1);
        log('warn', 'narration.retry', { attempt, delayMs: delay, error: lastError.message });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// When each word of a take is spoken, read back from the audio with Whisper (about $0.006 a minute).
// Best effort: a take without timings still plays, and its captions and animation fall back to an
// even pace, so any failure is logged and returns undefined.
export async function spokenWords(file: string, line: string, signal?: AbortSignal): Promise<SpokenWord[] | undefined> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)]), 'voice.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    // The script steers Whisper to the right spellings.
    form.append('prompt', line.slice(0, 800));
    const timeout = AbortSignal.timeout(60_000);
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      log('warn', 'narration.words_failed', { error: explainOpenAIError(response.status, await response.text(), 'word timing') });
      return undefined;
    }
    const data = (await response.json()) as { words?: { word: string; start: number; end: number }[] };
    const words = (data.words ?? [])
      .filter((w) => typeof w.word === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map((w) => ({ text: w.word.trim(), start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 }));
    return words.length > 0 ? words : undefined;
  } catch (err) {
    if (!signal?.aborted) log('warn', 'narration.words_failed', { error: err });
    return undefined;
  }
}

async function audioDuration(file: string): Promise<number> {
  const result = await runCommand(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
  const seconds = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

const shortHash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

// Lengthens a marker so its voice ends inside it, and moves every later marker back by the same
// amount, so the rest of the timeline keeps its spacing. On an uploaded video, throws, changing
// nothing, if that would push a marker past the end of the video; a blank canvas grows instead (see
// timeline.ts).
function makeRoom(id: string, markers: Marker[], marker: Marker, voiceSec: number): void {
  const needed = Math.round((marker.start + voiceSec + VOICE_TAIL_SEC) * 100) / 100;
  const growth = needed - marker.end;
  if (growth <= 0.001) return;
  const { fps, durationInFrames } = readCompositionConfig(id);
  const videoSec = durationInFrames / fps;
  const later = markers.filter((m) => m !== marker && m.start >= marker.end - 0.001);
  const lastEnd = Math.max(needed, ...later.map((m) => m.end + growth));
  if (lengthIsFixed(id) && lastEnd > videoSec + 0.001) {
    throw new Error(
      `The voice is ${voiceSec.toFixed(1)}s long. Making room for it moves the markers after this one ${growth.toFixed(1)}s later, which runs ${(lastEnd - videoSec).toFixed(1)}s past the end of the video. Shorten this line or make room at the end, then generate again; this take is kept, so that costs nothing.`
    );
  }
  marker.end = needed;
  for (const m of later) {
    m.start = Math.round((m.start + growth) * 100) / 100;
    m.end = Math.round((m.end + growth) * 100) / 100;
  }
}

// Generates speech for the marker's saved line at its natural pace and lengthens the marker to hold
// it (see makeRoom). A take that already matches the line and voice is reused instead of paying for
// the same audio again. `retimed` tells whether any marker's timing changed.
export async function generateNarration(id: string, markerId: string, signal?: AbortSignal): Promise<{ marker: Marker; retimed: boolean }> {
  const marker = readMarkers(id).find((m) => m.marker_id === markerId);
  if (!marker) throw new Error(`Marker ${markerId} not found in project ${id}`);
  const n = marker.narration;
  if (!n?.text) throw new Error('This marker has no voiceover line.');

  let name: string;
  let durationSec: number;
  const current = playableNarration(id, marker);
  if (current) {
    name = n.audio!.file;
    durationSec = current.durationSec;
  } else {
    name = `${markerId}-${shortHash(`${TTS_MODEL()}\n${n.voice}\n${n.text}`)}.mp3`;
    const dir = narrationDir(id);
    const file = path.join(dir, name);
    fs.mkdirSync(dir, { recursive: true });
    const started = Date.now();
    if (!fs.existsSync(file)) {
      const audio = await requestSpeech(n.text, n.voice, signal);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, audio);
      fs.renameSync(tmp, file);
    }
    durationSec = Math.round((await audioDuration(file)) * 100) / 100;
    log('info', 'narration.done', { project: id, marker: markerId, voice: n.voice, chars: n.text.length, seconds: durationSec, ms: Date.now() - started });
  }
  // Read once per take; a take made before word timing existed gets it on its next generate.
  const words = (current && n.audio?.words) || (await spokenWords(path.join(narrationDir(id), name), n.text, signal));

  // Re-read: the line or the timeline may have changed while the request ran. The take is only
  // recorded if it still matches the line, and only together with the room it needs.
  const markers = readMarkers(id);
  const target = markers.find((m) => m.marker_id === markerId);
  if (!target) throw new Error(`Marker ${markerId} not found in project ${id}`);
  const cur = target.narration;
  if (!cur || cur.text !== n.text || cur.voice !== n.voice) return { marker: target, retimed: false };
  const timing = () => markers.map((m) => `${m.start}-${m.end}`).join();
  const before = timing();
  makeRoom(id, markers, target, durationSec);
  const retimed = timing() !== before;
  if (retimed || cur.audio?.file !== name || (words && !cur.audio?.words)) {
    target.narration = { ...cur, audio: { file: name, text: n.text, voice: n.voice, durationSec, ...(words && { words }) } };
    writeMarkers(id, markers);
    removeNarrationFiles(id, markerId, [name]);
  }
  return { marker: target, retimed };
}

// A short sample of each voice, so it can be heard before it is picked. Made once per voice and
// model and kept beside the projects (the folder name is not a valid project id, so it is never
// listed as one); every later listen is free.
const samplesDir = () => path.join(PROJECTS_ROOT, '.voice-samples');
const sampleText = (voice: string) => `Hi, I'm ${voice[0].toUpperCase() + voice.slice(1)}. This is how I sound reading a voiceover for your video.`;
const pendingSamples = new Map<string, Promise<string>>();

// The path of the voice's sample, generating it first if needed.
export function voiceSample(voice: string): Promise<string> {
  if (!isValidVoice(voice)) return Promise.reject(new Error(`Unknown voice "${voice}".`));
  const file = path.join(samplesDir(), `${voice}-${shortHash(TTS_MODEL())}.mp3`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  // Two quick clicks share one request.
  let pending = pendingSamples.get(file);
  if (!pending) {
    pending = (async () => {
      const audio = await requestSpeech(sampleText(voice), voice);
      fs.mkdirSync(samplesDir(), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, audio);
      fs.renameSync(tmp, file);
      log('info', 'narration.sample', { voice });
      return file;
    })().finally(() => pendingSamples.delete(file));
    pendingSamples.set(file, pending);
  }
  return pending;
}

// The shortest a marker may be while it has current speech.
export function minMarkerSeconds(id: string, marker: Marker): number {
  const playable = playableNarration(id, marker);
  return playable ? playable.durationSec + VOICE_TAIL_SEC : 0;
}

// The markers' playable narration, for the export.
export function narrationClips(id: string): { markerId: string; file: string; start: number; end: number; durationSec: number }[] {
  return readMarkers(id)
    .map((m) => {
      const playable = playableNarration(id, m);
      return playable ? { markerId: m.marker_id, file: playable.file, start: m.start, end: m.end, durationSec: playable.durationSec } : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.start - b.start);
}
