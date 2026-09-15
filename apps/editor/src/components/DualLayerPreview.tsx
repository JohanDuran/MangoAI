import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';

interface Props {
  projectId: string;
  videoUrl: string | null;
  reloadToken: number;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  initialDurationInFrames: number;
  onDurationChange?: (durationInFrames: number) => void;
  onTimeUpdate?: (seconds: number) => void;
}

export interface DualLayerPreviewHandle {
  seekTo: (seconds: number) => void;
}

export const DualLayerPreview = forwardRef<DualLayerPreviewHandle, Props>(function DualLayerPreview(
  {
    projectId,
    videoUrl,
    reloadToken,
    fps,
    compositionWidth,
    compositionHeight,
    initialDurationInFrames,
    onDurationChange,
    onTimeUpdate,
  },
  ref
) {
  const [Overlay, setOverlay] = useState<React.ComponentType | null>(null);
  const [durationInFrames, setDurationInFrames] = useState(initialDurationInFrames);
  const [widthPct, setWidthPct] = useState(100);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<PlayerRef>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    seekTo: (seconds: number) => {
      if (videoRef.current) videoRef.current.currentTime = seconds;
    },
  }));

  useEffect(() => {
    // Resolved fresh on every call (no pre-scanned glob) so it works for projects and
    // marker edits created after this component first loaded — a static import.meta.glob
    // here would only ever see files that existed at that first-load moment.
    let cancelled = false;
    const url = `/@fs/${__PROJECTS_ABS_PATH__}/${projectId}/03_remotion_code/CustomOverlay.tsx?t=${reloadToken}`;
    import(/* @vite-ignore */ url)
      .then((mod: { default: React.ComponentType }) => {
        if (!cancelled) setOverlay(() => mod.default);
      })
      .catch(() => {
        if (!cancelled) setOverlay(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadToken]);

  useEffect(() => {
    setDurationInFrames(initialDurationInFrames);
  }, [projectId, initialDurationInFrames]);

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const frames = Math.max(1, Math.round(videoRef.current.duration * fps));
      setDurationInFrames(frames);
      onDurationChange?.(frames);
    }
  };

  const sync = () => {
    if (videoRef.current && playerRef.current) {
      playerRef.current.seekTo(Math.round(videoRef.current.currentTime * fps));
    }
    if (videoRef.current) onTimeUpdate?.(videoRef.current.currentTime);
  };

  // Resizes by percentage of the column's width (not raw px) so it stays sane if the
  // window is resized later. Purely a preview convenience — never touches the actual
  // export resolution, which stays governed by CompositionConfig.json.
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidthPct = widthPct;
    const parentWidth = wrapperRef.current?.parentElement?.clientWidth ?? 800;

    const handleMove = (ev: MouseEvent) => {
      const deltaPct = ((ev.clientX - startX) / parentWidth) * 100;
      setWidthPct(Math.min(100, Math.max(25, startWidthPct + deltaPct)));
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <div ref={wrapperRef} style={{ width: `${widthPct}%` }}>
      <div className="stage" style={{ aspectRatio: `${compositionWidth} / ${compositionHeight}` }}>
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            onLoadedMetadata={handleLoadedMetadata}
            onPlay={sync}
            onSeeked={sync}
            onTimeUpdate={sync}
          />
        ) : (
          <div className="stage-empty">Upload a video above to start previewing overlays here.</div>
        )}
        {Overlay && (
          <div className="stage-overlay-layer">
            <Player
              ref={playerRef}
              component={Overlay}
              durationInFrames={durationInFrames}
              fps={fps}
              compositionWidth={compositionWidth}
              compositionHeight={compositionHeight}
              style={{ width: '100%', height: '100%' }}
              controls={false}
            />
          </div>
        )}
        <div className="stage-resize-handle" onMouseDown={handleResizeStart} title="Drag to resize preview" />
      </div>
    </div>
  );
});
