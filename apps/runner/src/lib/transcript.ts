import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';
import { findRawVideo } from './video.js';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const transcriptFile = (id: string) => path.join(projectDir(id), '01_transcript', 'transcript.json');

export function readTranscript(id: string): TranscriptSegment[] {
  const file = transcriptFile(id);
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return data.segments ?? [];
}

// Whisper's file size cap is 25MB — long or high-bitrate videos will fail here with
// OpenAI's own error message surfaced as-is rather than silently truncating audio.
export async function transcribeProject(id: string): Promise<TranscriptSegment[]> {
  const videoPath = findRawVideo(id);
  if (!videoPath) throw new Error('No video uploaded for this project');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set on the server');

  const form = new FormData();
  const fileBuffer = fs.readFileSync(videoPath);
  form.append('file', new Blob([fileBuffer]), path.basename(videoPath));
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

  fs.writeFileSync(transcriptFile(id), JSON.stringify({ segments }, null, 2));
  return segments;
}

export function transcriptForRange(id: string, start: number, end: number): TranscriptSegment[] {
  return readTranscript(id).filter((s) => s.start < end && s.end > start);
}
