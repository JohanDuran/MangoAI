import { readMarkers } from './markers.js';
import { readCompositionConfig } from './composition.js';

export interface FrameRange {
  from: number;
  to: number;
}

// Frame ranges (inclusive) that contain any marker, merged when overlapping or separated by
// no more than mergeGapSeconds (rendering a short blank gap is cheaper than another segment).
// Frame math mirrors the <Sequence> bounds generated in registry.ts.
export function markerFrameRanges(id: string, mergeGapSeconds = 2): FrameRange[] {
  const { fps, durationInFrames } = readCompositionConfig(id);
  const ranges = readMarkers(id)
    .map((m) => {
      const from = Math.max(0, Math.round(m.start * fps));
      const length = Math.max(1, Math.round((m.end - m.start) * fps));
      return { from, to: Math.min(durationInFrames - 1, from + length - 1) };
    })
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from - b.from);

  const merged: FrameRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1 + Math.round(mergeGapSeconds * fps)) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}
