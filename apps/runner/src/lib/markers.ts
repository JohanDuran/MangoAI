import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

// Normalized 0-1 fractions of the composition canvas — resolution-independent, so a
// region drawn on a 1080p preview still lands correctly if the video is later swapped
// for a different resolution. Absent on a Marker means full screen.
export interface MarkerRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Marker {
  marker_id: string;
  start: number;
  end: number;
  prompt: string;
  feedback: string;
  status: 'draft' | 'ready' | 'error';
  region?: MarkerRegion;
  // Ids of library images (see assets.ts) the user attached to this marker.
  assets?: string[];
}

// Normalized 0-1 fractions of the canvas — null resets a marker to full screen.
export const isValidRegion = (r: unknown): r is MarkerRegion => {
  if (!r || typeof r !== 'object') return false;
  const { x, y, width, height } = r as Record<string, unknown>;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  const { x: nx, y: ny, width: nw, height: nh } = r as MarkerRegion;
  return nw > 0 && nh > 0 && nx >= 0 && ny >= 0 && nx + nw <= 1.0001 && ny + nh <= 1.0001;
};

const markersFile = (id: string) => path.join(projectDir(id), '00_input', 'markers.json');

export function readMarkers(id: string): Marker[] {
  const file = markersFile(id);
  if (!fs.existsSync(file)) return [];
  return readJson<Marker[]>(file);
}

export function writeMarkers(id: string, markers: Marker[]): void {
  writeJsonAtomic(markersFile(id), markers);
}

export function findMarker(id: string, markerId: string): Marker {
  const marker = readMarkers(id).find((m) => m.marker_id === markerId);
  if (!marker) throw new Error(`Marker ${markerId} not found in project ${id}`);
  return marker;
}

export function updateMarkerStatus(
  id: string,
  markerId: string,
  feedback: string,
  status: Marker['status']
): void {
  const markers = readMarkers(id);
  const marker = markers.find((m) => m.marker_id === markerId);
  if (!marker) throw new Error(`Marker ${markerId} not found in project ${id}`);
  marker.feedback = feedback;
  marker.status = status;
  writeMarkers(id, markers);
}

// Repositioning/trimming a marker only ever changes where its Sequence sits in
// CustomOverlay.tsx (rewritten by regenerateRegistry) — the marker's own animation code
// is frame-relative to its Sequence, so it never needs to change or be regenerated.
// Overlapping markers are allowed on purpose (Remotion just stacks them).
export function updateMarkerTiming(id: string, markerId: string, timing: { start: number; end: number }): Marker {
  const markers = readMarkers(id);
  const marker = markers.find((m) => m.marker_id === markerId);
  if (!marker) throw new Error(`Marker ${markerId} not found in project ${id}`);
  marker.start = timing.start;
  marker.end = timing.end;
  writeMarkers(id, markers);
  return marker;
}

export function deleteMarker(id: string, markerId: string): void {
  const markers = readMarkers(id);
  const next = markers.filter((m) => m.marker_id !== markerId);
  if (next.length === markers.length) throw new Error(`Marker ${markerId} not found in project ${id}`);
  writeMarkers(id, next);
}

// A null region resets the marker to full screen. Like timing, this only ever changes
// the positioned wrapper div that regenerateRegistry writes around the marker's Sequence
// — the marker's own component is frame- and region-relative, so it never needs to change.
export function updateMarkerRegion(id: string, markerId: string, region: MarkerRegion | null): Marker {
  const markers = readMarkers(id);
  const marker = markers.find((m) => m.marker_id === markerId);
  if (!marker) throw new Error(`Marker ${markerId} not found in project ${id}`);
  if (region) marker.region = region;
  else delete marker.region;
  writeMarkers(id, markers);
  return marker;
}

export function setMarkerAssets(id: string, markerId: string, assets: string[]): Marker {
  const markers = readMarkers(id);
  const marker = markers.find((m) => m.marker_id === markerId);
  if (!marker) throw new Error(`Marker ${markerId} not found in project ${id}`);
  if (assets.length > 0) marker.assets = assets;
  else delete marker.assets;
  writeMarkers(id, markers);
  return marker;
}
