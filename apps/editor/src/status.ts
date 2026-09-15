import type { Marker } from './api/client';
import type { MarkerRunState } from './App';

export type DisplayStatus = 'draft' | 'generating' | 'ready' | 'error';

export function displayStatus(marker: Marker, run?: MarkerRunState): DisplayStatus {
  if (run?.phase === 'generating') return 'generating';
  if (run?.phase === 'done') return run.success ? 'ready' : 'error';
  return marker.status;
}
