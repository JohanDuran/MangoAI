import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';

export interface Marker {
  marker_id: string;
  start: number;
  end: number;
  prompt: string;
  feedback: string;
  status: 'draft' | 'ready' | 'error';
}

const markersFile = (id: string) => path.join(projectDir(id), '00_input', 'markers.json');

export function readMarkers(id: string): Marker[] {
  const file = markersFile(id);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function writeMarkers(id: string, markers: Marker[]): void {
  fs.writeFileSync(markersFile(id), JSON.stringify(markers, null, 2));
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
