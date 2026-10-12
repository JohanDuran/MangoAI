import { readMarkers, type Marker } from './markers.js';
import { readCompositionConfig, updateCompositionConfig, type CompositionConfig } from './composition.js';
import { baseLayerOf } from './scaffold.js';
import { log } from './log.js';

// Whether the project's length is fixed by an uploaded video. Markers are then fitted inside it; on
// a blank canvas (color, gradient, transparent) the length is only a starting point and grows to
// hold the markers instead.
export const lengthIsFixed = (id: string): boolean => baseLayerOf(id).type === 'video';

// Grows a blank canvas to hold every marker; never shrinks it, since the length it was given still
// stands. A video project keeps the video's length.
export function fitTimeline(id: string, markers: Marker[] = readMarkers(id)): CompositionConfig {
  const config = readCompositionConfig(id);
  if (lengthIsFixed(id)) return config;
  const markersEnd = Math.ceil(Math.max(0, ...markers.map((m) => m.end)) * config.fps - 0.001);
  if (markersEnd <= config.durationInFrames) return config;
  log('info', 'timeline.grow', { project: id, from: config.durationInFrames, to: markersEnd });
  return updateCompositionConfig(id, { durationInFrames: markersEnd });
}
