import React, { useMemo, useRef, useState } from 'react';
import type { Marker } from '../api/client';
import type { MarkerRunState } from '../App';
import { displayStatus } from '../status';

interface Props {
  markers: Marker[];
  durationSeconds: number;
  currentTime: number;
  selectedId: string | null;
  runState: Record<string, MarkerRunState>;
  pendingStart: number;
  pendingEnd: number;
  pendingVisible: boolean;
  isPlaying: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onSelect: (id: string) => void;
  onDeselectAll: () => void;
  onRangeSelect: (start: number, end: number) => void;
  onMarkerTimingChange: (markerId: string, start: number, end: number) => void;
  onEditRegion: (markerId: string) => void;
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

const DRAG_THRESHOLD_PX = 4;
const MIN_MARKER_DURATION = 0.2;
type DragMode = 'move' | 'trim-start' | 'trim-end';

// Markers' time ranges are allowed to overlap (Remotion just stacks them), but a single
// row can't show two overlapping chips without one covering the other's click target.
// Lanes solve that by stacking overlapping markers into separate rows, greedy
// interval-partitioning style: earliest-starting marker claims the first lane whose
// previous occupant has already ended, else it gets a brand new lane.
const CHIP_HEIGHT = 32;
const LANE_GAP = 8;
const TRACK_PAD = 8;

const assignLanes = (markers: Marker[]): { laneOf: Map<string, number>; laneCount: number } => {
  const sorted = [...markers].sort((a, b) => a.start - b.start);
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();
  for (const m of sorted) {
    let lane = laneEnds.findIndex((end) => end <= m.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(m.end);
    } else {
      laneEnds[lane] = m.end;
    }
    laneOf.set(m.marker_id, lane);
  }
  // Always leave one lane's worth of empty row beyond what's occupied, so there's always
  // blank track to drag out a new marker on — even one whose time range fully overlaps an
  // existing marker — without that marker's chip capturing the click first.
  return { laneOf, laneCount: laneEnds.length + 1 };
};

export const Timeline: React.FC<Props> = ({
  markers,
  durationSeconds,
  currentTime,
  selectedId,
  runState,
  pendingStart,
  pendingEnd,
  pendingVisible,
  isPlaying,
  onPlayPause,
  onStop,
  onSeek,
  onSelect,
  onDeselectAll,
  onRangeSelect,
  onMarkerTimingChange,
  onEditRegion,
}) => {
  const duration = Math.max(durationSeconds, 1);
  const trackRef = useRef<HTMLDivElement>(null);
  // Only tracks the rectangle while the mouse button is actually down, for smooth
  // real-time follow without pushing every mousemove up to the parent. Once released,
  // this goes back to null and the pending-range rect below (driven by pendingStart/
  // pendingEnd props) takes over and stays visible until the marker is actually added.
  const [liveDrag, setLiveDrag] = useState<{ left: number; width: number } | null>(null);
  // Live start/end for whichever existing marker is currently being moved or trimmed, so
  // the chip follows the cursor before the PATCH round-trip confirms the new values.
  const [movingMarker, setMovingMarker] = useState<{ id: string; start: number; end: number } | null>(null);

  // Lanes are computed from each marker's saved start/end, not the live-dragged position —
  // recomputing mid-drag would make chips hop rows while the user is still moving one.
  // Whatever lane a marker settles into after a move/trim is picked up on the next render.
  const { laneOf, laneCount } = useMemo(() => assignLanes(markers), [markers]);
  const trackHeight = TRACK_PAD * 2 + laneCount * CHIP_HEIGHT + (laneCount - 1) * LANE_GAP;

  const beginMarkerDrag = (e: React.MouseEvent, marker: Marker, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const origStart = marker.start;
    const origEnd = marker.end;
    let latestStart = origStart;
    let latestEnd = origEnd;
    // A plain click on the chip (select + seek, handled by the chip's own onClick) also
    // fires this mousedown. Only treat it as an actual drag — and only then persist a
    // timing change — once the pointer has moved past the threshold; otherwise the
    // unconditional PATCH below triggers a project refresh that reloads the video and
    // wipes out the seek the click just performed.
    let moved = false;

    const handleMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) >= DRAG_THRESHOLD_PX) moved = true;
      const rect = trackRef.current!.getBoundingClientRect();
      const deltaSeconds = ((ev.clientX - startX) / rect.width) * duration;

      if (mode === 'move') {
        let newStart = origStart + deltaSeconds;
        let newEnd = origEnd + deltaSeconds;
        if (newStart < 0) {
          newEnd -= newStart;
          newStart = 0;
        }
        latestStart = newStart;
        latestEnd = newEnd;
      } else if (mode === 'trim-start') {
        latestStart = Math.max(0, Math.min(origStart + deltaSeconds, origEnd - MIN_MARKER_DURATION));
        latestEnd = origEnd;
      } else {
        latestEnd = Math.min(duration, Math.max(origEnd + deltaSeconds, origStart + MIN_MARKER_DURATION));
        latestStart = origStart;
      }
      setMovingMarker({ id: marker.marker_id, start: latestStart, end: latestEnd });
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      setMovingMarker(null);
      if (moved) {
        onMarkerTimingChange(marker.marker_id, Number(latestStart.toFixed(1)), Number(latestEnd.toFixed(1)));
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const ratioAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const beginPlayheadDrag = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const handleMove = (ev: MouseEvent) => {
      onSeek(ratioAt(ev.clientX) * duration);
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.timeline-chip')) return;
    const startX = e.clientX;
    const startRatio = ratioAt(e.clientX);

    const handleMove = (ev: MouseEvent) => {
      const currentRatio = ratioAt(ev.clientX);
      setLiveDrag({
        left: Math.min(startRatio, currentRatio) * 100,
        width: Math.abs(currentRatio - startRatio) * 100,
      });
    };

    const handleUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      setLiveDrag(null);

      if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) {
        onSeek(startRatio * duration);
        onDeselectAll();
        return;
      }
      const endRatio = ratioAt(ev.clientX);
      const start = Math.min(startRatio, endRatio) * duration;
      const end = Math.max(startRatio, endRatio) * duration;
      onRangeSelect(Number(start.toFixed(1)), Number(end.toFixed(1)));
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  // The persisted (non-live) pending rect represents an in-progress "new marker" draft —
  // once an existing marker is selected, that draft is no longer what's being worked on,
  // so it shouldn't linger on the timeline. A rect actively being dragged is exempt: it
  // still needs to render up until the mouseup that actually clears the selection.
  const pendingRect =
    liveDrag ??
    (pendingVisible && !selectedId && pendingEnd > pendingStart
      ? { left: (pendingStart / duration) * 100, width: ((pendingEnd - pendingStart) / duration) * 100 }
      : null);

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button
          type="button"
          className="btn btn-sm timeline-transport-btn"
          onClick={onPlayPause}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          className="btn btn-sm timeline-transport-btn"
          onClick={onStop}
          title="Stop"
          aria-label="Stop"
        >
          ⏹
        </button>
        <span className="timeline-current-time">{fmtTime(currentTime)}</span>
      </div>
      <div className="timeline-times">
        <span>0:00</span>
        <span>{fmtTime(duration)}</span>
      </div>
      <div className="timeline-track" ref={trackRef} onMouseDown={handleMouseDown} style={{ height: trackHeight }}>
        <div className="timeline-rail" />
        {markers.map((m) => {
          const isMoving = movingMarker?.id === m.marker_id;
          const effStart = isMoving ? movingMarker.start : m.start;
          const effEnd = isMoving ? movingMarker.end : m.end;
          const left = (effStart / duration) * 100;
          const width = Math.max(((effEnd - effStart) / duration) * 100, 1.2);
          const status = displayStatus(m, runState[m.marker_id]);
          const lane = laneOf.get(m.marker_id) ?? 0;
          const top = TRACK_PAD + lane * (CHIP_HEIGHT + LANE_GAP);
          return (
            <div
              key={m.marker_id}
              className={`timeline-chip status-${status}${m.marker_id === selectedId ? ' selected' : ''}${isMoving ? ' dragging' : ''}`}
              style={{ left: `${left}%`, width: `${width}%`, top, height: CHIP_HEIGHT }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(m.marker_id);
                onSeek(effStart);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onEditRegion(m.marker_id);
              }}
              title={`${m.marker_id} · ${effStart.toFixed(1)}s–${effEnd.toFixed(1)}s — ${m.prompt} (double-click to move its animation area)`}
            >
              <div className="timeline-chip-edge" onMouseDown={(e) => beginMarkerDrag(e, m, 'trim-start')} />
              <span className="timeline-chip-label" onMouseDown={(e) => beginMarkerDrag(e, m, 'move')}>
                {m.marker_id}
              </span>
              <div className="timeline-chip-edge" onMouseDown={(e) => beginMarkerDrag(e, m, 'trim-end')} />
            </div>
          );
        })}
        {pendingRect && (
          <div className="timeline-pending" style={{ left: `${pendingRect.left}%`, width: `${pendingRect.width}%` }}>
            {!liveDrag && <span className="timeline-pending-label">new</span>}
          </div>
        )}
        <div
          className="timeline-playhead"
          style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }}
        />
        <div
          className="timeline-playhead-hit"
          style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }}
          onMouseDown={beginPlayheadDrag}
        />
      </div>
      <div className="panel-hint" style={{ marginTop: 6 }}>
        Click to seek, drag empty track to create a marker, drag an existing marker's body
        to move it and its edges to trim it, or double-click a marker to move its animation
        area. Markers can overlap in time — an empty row is always left below existing
        markers so you can drag out a new one even where another already covers that time.
      </div>
    </div>
  );
};
