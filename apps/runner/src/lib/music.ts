import fs from 'node:fs';
import path from 'node:path';
import { inputDir } from './paths.js';
import { readMarkers } from './markers.js';
import { readTranscript } from './transcript.js';
import { readProject, baseLayerOf } from './scaffold.js';
import { playableNarration } from './narration.js';

// Background music: one audio file per project, played from the start of the timeline (looped by
// default) under everything else. While someone speaks (a voiceover line, or speech in the video
// from its transcript) it is turned down ("ducked") so the words stay clear. The editor applies the
// same curve in the preview, and the export turns it into an ffmpeg volume expression.

export interface MusicSettings {
  file: string;
  // The uploaded file's name, for showing.
  name: string;
  durationSec: number;
  // 0 to 1.
  volume: number;
  loop: boolean;
  duck: boolean;
}

// Under speech the music plays at this share of its volume, reached over RAMP_SEC before the
// speech starts and released over RAMP_SEC after it ends.
export const DUCK_LEVEL = 0.25;
export const RAMP_SEC = 0.3;
// Speech closer together than this is treated as one stretch, so the music does not bob up between words.
const MERGE_GAP_SEC = 0.8;
// Keeps the ffmpeg expression a sane length on very talky timelines.
const MAX_INTERVALS = 150;

const MUSIC_FILE = /^music-[0-9a-f]{8}\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/;

export const isMusicFileName = (name: string) => MUSIC_FILE.test(name);

export function musicSettings(id: string): MusicSettings | null {
  return readProject(id)?.music ?? null;
}

export function musicFilePath(id: string): string | null {
  const music = musicSettings(id);
  if (!music || !MUSIC_FILE.test(music.file)) return null;
  const file = path.join(inputDir(id), music.file);
  return fs.existsSync(file) ? file : null;
}

// Removes music files other than `keep` (a replaced upload, or all of them when music is removed).
export function removeMusicFiles(id: string, keep?: string): void {
  const dir = inputDir(id);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (MUSIC_FILE.test(f) && f !== keep) fs.rmSync(path.join(dir, f), { force: true });
}

// When someone speaks, as merged [start, end] stretches in seconds: the voiceover takes, and the
// transcript when the project is built on a video (its own speech).
export function speechIntervals(id: string): [number, number][] {
  const raw: [number, number][] = [];
  for (const m of readMarkers(id)) {
    const audio = playableNarration(id, m);
    if (audio) raw.push([m.start, m.start + audio.durationSec]);
  }
  if (baseLayerOf(id).type === 'video') for (const s of readTranscript(id)) raw.push([s.start, s.end]);
  return mergeIntervals(raw);
}

export function mergeIntervals(raw: [number, number][]): [number, number][] {
  const sorted = raw.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let gap = MERGE_GAP_SEC;
  for (;;) {
    const merged: [number, number][] = [];
    for (const [a, b] of sorted) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    if (merged.length <= MAX_INTERVALS) return merged.map(([a, b]) => [round(a), round(b)]);
    gap *= 2;
  }
}

const round = (s: number) => Math.round(s * 1000) / 1000;

// How much of the music's volume plays at time t: 1, down to DUCK_LEVEL under speech, with ramps.
// Mirrored in the editor (audioMix.ts) and by duckExpression below; keep the three in step.
export function duckFactor(intervals: [number, number][], t: number): number {
  let presence = 0;
  for (const [a, b] of intervals) {
    const rise = Math.min(1, Math.max(0, (t - a + RAMP_SEC) / RAMP_SEC));
    const fall = Math.min(1, Math.max(0, (b + RAMP_SEC - t) / RAMP_SEC));
    presence = Math.max(presence, Math.min(rise, fall));
  }
  return 1 - (1 - DUCK_LEVEL) * presence;
}

// The same curve as an ffmpeg expression in t, for the volume filter (eval=frame).
export function duckExpression(intervals: [number, number][]): string {
  if (intervals.length === 0) return '1';
  const terms = intervals.map(
    ([a, b]) => `min(clip((t-${a}+${RAMP_SEC})/${RAMP_SEC},0,1),clip((${b}+${RAMP_SEC}-t)/${RAMP_SEC},0,1))`
  );
  const presence = terms.reduce((acc, term) => `max(${acc},${term})`);
  return `1-${1 - DUCK_LEVEL}*${presence}`;
}

// The music as an ffmpeg filter chain from input `input` to label `label`: looped input is expected
// (-stream_loop -1) when settings.loop, cut to the timeline, ducked, faded in and out.
export function musicFilter(input: number, label: string, settings: MusicSettings, intervals: [number, number][], totalSeconds: number): string {
  const length = settings.loop ? totalSeconds : Math.min(totalSeconds, settings.durationSec);
  const gain = settings.duck ? `${settings.volume}*(${duckExpression(intervals)})` : `${settings.volume}`;
  const fadeOut = Math.max(0, length - 1.5);
  return `[${input}:a]aresample=48000,atrim=end=${length.toFixed(3)},asetpts=PTS-STARTPTS,volume='${gain}':eval=frame,afade=t=in:d=0.5,afade=t=out:st=${fadeOut.toFixed(3)}:d=1.5[${label}]`;
}
