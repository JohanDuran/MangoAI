import React, { useRef, useState } from 'react';
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
  isPlaying: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onSelect: (id: string) => void;
  onRangeSelect: (start: number, end: number) => void;
  onMarkerTimingChange: (markerId: string, start: number, end: number) => void;
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

const DRAG_THRESHOLD_PX = 4;
const MIN_MARKER_DURATION = 0.2;
type DragMode = 'move' | 'trim-start' | 'trim-end';

export const Timeline: React.FC<Props> = ({
  markers,
  durationSeconds,
  currentTime,
  selectedId,
  runState,
  pendingStart,
  pendingEnd,
  isPlaying,
  onPlayPause,
  onStop,
  onSeek,
  onSelect,
  onRangeSelect,
  onMarkerTimingChange,
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

  const beginMarkerDrag = (e: React.MouseEvent, marker: Marker, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const origStart = marker.start;
    const origEnd = marker.end;
    let latestStart = origStart;
    let latestEnd = origEnd;

    const handleMove = (ev: MouseEvent) => {
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
      onMarkerTimingChange(marker.marker_id, Number(latestStart.toFixed(1)), Number(latestEnd.toFixed(1)));
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const ratioAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
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

  const pendingRect =
    liveDrag ??
    (pendingEnd > pendingStart
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
      <div className="timeline-track" ref={trackRef} onMouseDown={handleMouseDown}>
        <div className="timeline-rail" />
        {markers.map((m) => {
          const isMoving = movingMarker?.id === m.marker_id;
          const effStart = isMoving ? movingMarker.start : m.start;
          const effEnd = isMoving ? movingMarker.end : m.end;
          const left = (effStart / duration) * 100;
          const width = Math.max(((effEnd - effStart) / duration) * 100, 1.2);
          const status = displayStatus(m, runState[m.marker_id]);
          return (
            <div
              key={m.marker_id}
              className={`timeline-chip status-${status}${m.marker_id === selectedId ? ' selected' : ''}${isMoving ? ' dragging' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(m.marker_id);
                onSeek(effStart);
              }}
              title={`${m.marker_id} · ${effStart.toFixed(1)}s–${effEnd.toFixed(1)}s — ${m.prompt}`}
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
      </div>
      <div className="panel-hint" style={{ marginTop: 6 }}>
        Click to seek, drag empty track to create a marker, or drag an existing marker's
        body to move it and its edges to trim it.
      </div>
    </div>
  );
};
