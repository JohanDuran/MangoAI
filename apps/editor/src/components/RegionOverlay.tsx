import React, { useEffect, useRef } from 'react';
import type { MarkerRegion } from '../api/client';

interface Props {
  region: MarkerRegion;
  onChange: (region: MarkerRegion) => void;
  // Fired when a mousedown/drag gesture starts and ends outside the box (i.e. directly on
  // the stage background) — the signal to auto-save, since that's the box's "I'm done
  // moving/drawing it" gesture.
  onCommit?: () => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const MIN_SIZE = 0.03;

type Corner = 'nw' | 'ne' | 'sw' | 'se';

// A draggable/resizable rectangle drawn on top of the video stage, used to pick the
// on-screen area a marker's animation is confined to. Coordinates are normalized 0-1
// fractions of the stage, which — because the stage element is locked to the
// composition's aspect ratio — map directly to fractions of the video canvas.
export const RegionOverlay: React.FC<Props> = ({ region, onChange, onCommit }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Clicks that start and end on the stage itself are already committed via startDraw's
  // own mouseup below. This covers everywhere else on the page — the inspector, the
  // timeline, the topbar — since the stage is only a small part of the screen and the user
  // shouldn't have to click specifically back inside the video to confirm a move. The
  // region-editing control buttons (Save/Cancel/Full screen) are excluded so Cancel isn't
  // silently turned into a save.
  useEffect(() => {
    if (!onCommit) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-region-controls]')) return;
      onCommit();
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [onCommit]);

  const startMove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const start = { ...region };
    const startX = e.clientX;
    const startY = e.clientY;

    const handleMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      const x = Math.min(Math.max(0, start.x + dx), 1 - start.width);
      const y = Math.min(Math.max(0, start.y + dy), 1 - start.height);
      onChange({ ...start, x, y });
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const startResize = (corner: Corner) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const start = { ...region };
    const startX = e.clientX;
    const startY = e.clientY;

    const handleMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      let { x, y, width, height } = start;

      if (corner.includes('e')) width = clamp01(start.width + dx);
      if (corner.includes('s')) height = clamp01(start.height + dy);
      if (corner.includes('w')) {
        const newX = clamp01(start.x + dx);
        width = start.x + start.width - newX;
        x = newX;
      }
      if (corner.includes('n')) {
        const newY = clamp01(start.y + dy);
        height = start.y + start.height - newY;
        y = newY;
      }

      if (width < MIN_SIZE) width = MIN_SIZE;
      if (height < MIN_SIZE) height = MIN_SIZE;
      onChange({ x, y, width, height });
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  // Dragging on empty space draws a brand new rectangle from scratch.
  const startDraw = (e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const originX = clamp01((e.clientX - rect.left) / rect.width);
    const originY = clamp01((e.clientY - rect.top) / rect.height);

    const handleMove = (ev: MouseEvent) => {
      const curX = clamp01((ev.clientX - rect.left) / rect.width);
      const curY = clamp01((ev.clientY - rect.top) / rect.height);
      const x = Math.min(originX, curX);
      const y = Math.min(originY, curY);
      const width = Math.max(MIN_SIZE, Math.abs(curX - originX));
      const height = Math.max(MIN_SIZE, Math.abs(curY - originY));
      onChange({ x, y, width, height });
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      onCommit?.();
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <div className="region-overlay" ref={containerRef} onMouseDown={startDraw}>
      <div
        className="region-box"
        style={{
          left: `${region.x * 100}%`,
          top: `${region.y * 100}%`,
          width: `${region.width * 100}%`,
          height: `${region.height * 100}%`,
        }}
        onMouseDown={startMove}
      >
        {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((corner) => (
          <div key={corner} className={`region-handle region-handle-${corner}`} onMouseDown={startResize(corner)} />
        ))}
      </div>
    </div>
  );
};
