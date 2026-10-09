import { readMarkers } from './markers.js';
import { readTranscript } from './transcript.js';
import { readCompositionConfig } from './composition.js';
import { readProject } from './scaffold.js';
import { playableNarration } from './narration.js';

// Captions are made from text the project already has: the voiceover lines (timed by their generated
// speech) or the transcript of the video. They can be burned into the overlay (a runner-generated
// Captions.tsx, so the preview and the export look the same) and are written as an .srt file with
// every export.

export type CaptionMode = 'off' | 'burn' | 'srt';
// 'auto' uses the voiceover when any marker has speech, otherwise the transcript.
export type CaptionSource = 'auto' | 'voiceover' | 'transcript';

export interface CaptionSettings {
  mode: CaptionMode;
  source: CaptionSource;
  position: 'bottom' | 'top';
  size: 'small' | 'medium' | 'large';
}

export const DEFAULT_CAPTIONS: CaptionSettings = { mode: 'off', source: 'auto', position: 'bottom', size: 'medium' };

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

const MODES: CaptionMode[] = ['off', 'burn', 'srt'];
const SOURCES: CaptionSource[] = ['auto', 'voiceover', 'transcript'];

export function isValidCaptionSettings(v: unknown): v is CaptionSettings {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    MODES.includes(s.mode as CaptionMode) &&
    SOURCES.includes(s.source as CaptionSource) &&
    (s.position === 'bottom' || s.position === 'top') &&
    (s.size === 'small' || s.size === 'medium' || s.size === 'large')
  );
}

export function captionSettings(id: string): CaptionSettings {
  return { ...DEFAULT_CAPTIONS, ...(readProject(id)?.captions ?? {}) };
}

// Longest caption line on screen, in characters. Longer text is split into several cues.
const MAX_CHARS = 42;

// Splits text into pieces of at most MAX_CHARS on word boundaries, preferring to end a piece at a
// sentence or clause break, and shares [start, end] between them by length.
export function splitIntoCues(text: string, start: number, end: number): CaptionCue[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || end <= start) return [];
  const pieces: string[] = [];
  let current: string[] = [];
  const length = (ws: string[]) => ws.join(' ').length;
  for (const word of words) {
    if (current.length > 0 && length([...current, word]) > MAX_CHARS) {
      pieces.push(current.join(' '));
      current = [];
    }
    current.push(word);
    // A break after punctuation once the piece has some substance reads better than a full line.
    if (/[.!?;:]$/.test(word) && length(current) >= MAX_CHARS * 0.5) {
      pieces.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) pieces.push(current.join(' '));

  const total = pieces.reduce((sum, p) => sum + p.length, 0);
  const cues: CaptionCue[] = [];
  let t = start;
  for (const [i, piece] of pieces.entries()) {
    const next = i === pieces.length - 1 ? end : t + ((end - start) * piece.length) / total;
    cues.push({ start: round(t), end: round(next), text: piece });
    t = next;
  }
  return cues;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

function voiceoverCues(id: string, durationSeconds: number): CaptionCue[] {
  return readMarkers(id).flatMap((m) => {
    const audio = playableNarration(id, m);
    if (!audio || !m.narration) return [];
    return splitIntoCues(m.narration.text, m.start, Math.min(durationSeconds, m.start + audio.durationSec));
  });
}

function transcriptCues(id: string, durationSeconds: number): CaptionCue[] {
  return readTranscript(id).flatMap((s) => splitIntoCues(s.text, s.start, Math.min(durationSeconds, s.end)));
}

// The captions for the project's current text, in time order. Empty when captions are off.
export function captionCues(id: string, settings = captionSettings(id)): CaptionCue[] {
  if (settings.mode === 'off') return [];
  const { fps, durationInFrames } = readCompositionConfig(id);
  const durationSeconds = durationInFrames / fps;
  let cues: CaptionCue[];
  if (settings.source === 'voiceover') cues = voiceoverCues(id, durationSeconds);
  else if (settings.source === 'transcript') cues = transcriptCues(id, durationSeconds);
  else {
    const voice = voiceoverCues(id, durationSeconds);
    cues = voice.length > 0 ? voice : transcriptCues(id, durationSeconds);
  }
  return cues.filter((c) => c.end > c.start && c.start < durationSeconds).sort((a, b) => a.start - b.start);
}

const srtTime = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

export function toSrt(cues: CaptionCue[]): string {
  return cues.map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${c.text}\r\n`).join('\r\n');
}

// The Captions component regenerateRegistry writes next to CustomOverlay.tsx when captions are burned
// in. Deterministic, like the rest of the generated wiring: Claude never edits it.
export function captionsComponentSource(cues: CaptionCue[], settings: CaptionSettings): string {
  const fontScale = { small: 0.034, medium: 0.045, large: 0.06 }[settings.size];
  const edge = settings.position === 'top' ? 'top' : 'bottom';
  return `// GENERATED BY THE RUNNER — captions; do not hand-edit, do not let Claude edit this file.
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

const CUES: { start: number; end: number; text: string }[] = ${JSON.stringify(cues)};

export default function Captions() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  let cue: (typeof CUES)[number] | undefined;
  for (const c of CUES) if (c.start <= t && t < c.end) cue = c;
  if (!cue) return null;
  const opacity = interpolate(t, [cue.start, cue.start + 0.12, cue.end - 0.12, cue.end], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fontSize = Math.round(Math.min(width, height) * ${fontScale});
  return (
    <AbsoluteFill style={{ justifyContent: '${edge === 'top' ? 'flex-start' : 'flex-end'}', alignItems: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          ${edge}: 0,
          margin: \`\${Math.round(height * 0.07)}px \${Math.round(width * 0.08)}px\`,
          maxWidth: '84%',
          padding: \`\${Math.round(fontSize * 0.25)}px \${Math.round(fontSize * 0.55)}px\`,
          borderRadius: Math.round(fontSize * 0.3),
          background: 'rgba(0, 0, 0, 0.62)',
          color: '#ffffff',
          fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
          fontWeight: 600,
          fontSize,
          lineHeight: 1.25,
          textAlign: 'center',
          opacity,
        }}
      >
        {cue.text}
      </div>
    </AbsoluteFill>
  );
}
`;
}
