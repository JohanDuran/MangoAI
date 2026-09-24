import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectDir } from './paths.js';
import { findRawVideo } from './video.js';
import { log } from './log.js';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const transcriptFile = (id: string) => path.join(projectDir(id), '01_transcript', 'transcript.json');
const MAX_WHISPER_BYTES = 25 * 1024 * 1024;

export function readTranscript(id: string): TranscriptSegment[] {
  const file = transcriptFile(id);
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return data.segments ?? [];
}

// Lets the editor persist manual corrections to a transcript (e.g. fixing a misheard word)
// without re-running Whisper.
export function writeTranscript(id: string, segments: TranscriptSegment[]): void {
  const file = transcriptFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ segments }, null, 2));
}

// Strips the (often large) video stream and re-encodes just the audio as a low-bitrate
// mono mp3 — typically 10-20x smaller than the source video, and Whisper transcribes it
// just as well since it resamples internally regardless of input quality.
function extractAudio(videoPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', outPath],
      { shell: process.platform === 'win32' }
    );
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg audio extraction failed (exit code ${code}): ${stderr.slice(-500)}`));
    });
    child.on('error', (err) => {
      reject(new Error(`Could not run ffmpeg (is it installed and on PATH?): ${err.message}`));
    });
  });
}

// Whisper's file size cap is 25MB — the raw video routinely blows past that, so the audio
// track is extracted and compressed first (see extractAudio). If even the compressed audio
// is still too large, that's surfaced as a clear error rather than OpenAI's own response
// (which for an oversized upload has been observed to be an empty-bodied 500, not a
// helpful 413).
export async function transcribeProject(id: string): Promise<TranscriptSegment[]> {
  const videoPath = findRawVideo(id);
  if (!videoPath) throw new Error('No video uploaded for this project');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set on the server');

  const audioPath = path.join(projectDir(id), '01_transcript', 'audio.mp3');
  const started = Date.now();
  log('info', 'transcribe.start', { project: id });
  await extractAudio(videoPath, audioPath);

  try {
    const audioSize = fs.statSync(audioPath).size;
    log('info', 'transcribe.audio', { project: id, audioMB: Math.round((audioSize / 1024 / 1024) * 10) / 10 });
    if (audioSize > MAX_WHISPER_BYTES) {
      throw new Error(
        `Audio track is ${(audioSize / 1024 / 1024).toFixed(1)}MB even after compression — Whisper's limit is 25MB. Trim the video to a shorter clip and try again.`
      );
    }

    const form = new FormData();
    const fileBuffer = fs.readFileSync(audioPath);
    form.append('file', new Blob([fileBuffer]), 'audio.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { segments?: Array<{ start: number; end: number; text: string }> };
    const segments: TranscriptSegment[] = (data.segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));

    writeTranscript(id, segments);
    log('info', 'transcribe.done', { project: id, segments: segments.length, ms: Date.now() - started });
    return segments;
  } finally {
    fs.unlinkSync(audioPath);
  }
}

export function transcriptForRange(id: string, start: number, end: number): TranscriptSegment[] {
  return readTranscript(id).filter((s) => s.start < end && s.end > start);
}
