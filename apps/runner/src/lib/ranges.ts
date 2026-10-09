import { readMarkers } from './markers.js';
import { readCompositionConfig } from './composition.js';
import { captionCues, captionSettings } from './captions.js';

export interface FrameRange {
  from: number;
  to: number;
}

interface TaggedRange extends FrameRange {
  markerId: string;
}

// One frame range per marker (inclusive), unmerged. Frame math mirrors the <Sequence> bounds
// generated in registry.ts.
function markerRanges(id: string): TaggedRange[] {
  const { fps, durationInFrames } = readCompositionConfig(id);
  return readMarkers(id)
    .map((m) => {
      const from = Math.max(0, Math.round(m.start * fps));
      const length = Math.max(1, Math.round((m.end - m.start) * fps));
      return { markerId: m.marker_id, from, to: Math.min(durationInFrames - 1, from + length - 1) };
    })
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from - b.from);
}

// Frames where burned-in captions show; they need rendering even where no marker is.
function captionRanges(id: string): FrameRange[] {
  const settings = captionSettings(id);
  if (settings.mode !== 'burn') return [];
  const { fps, durationInFrames } = readCompositionConfig(id);
  return captionCues(id, settings)
    .map((c) => ({ from: Math.max(0, Math.floor(c.start * fps)), to: Math.min(durationInFrames - 1, Math.ceil(c.end * fps)) }))
    .filter((r) => r.from <= r.to);
}

// Frame ranges (inclusive) that contain any marker or burned-in caption, merged when overlapping or
// separated by no more than mergeGapSeconds (rendering a short blank gap is cheaper than another segment).
export function markerFrameRanges(id: string, mergeGapSeconds = 2): FrameRange[] {
  const { fps } = readCompositionConfig(id);
  const merged: FrameRange[] = [];
  const ranges = [...markerRanges(id), ...captionRanges(id)].sort((a, b) => a.from - b.from);
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1 + Math.round(mergeGapSeconds * fps)) last.to = Math.max(last.to, r.to);
    else merged.push({ from: r.from, to: r.to });
  }
  return merged;
}

// One frame range per marker, never merged — each marker's animation is rendered as its own
// standalone clip instead of a single file spanning the whole timeline.
export function perMarkerFrameRanges(id: string): TaggedRange[] {
  return markerRanges(id);
}
