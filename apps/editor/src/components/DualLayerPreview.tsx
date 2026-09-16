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
  onVideoSize?: (width: number, height: number) => void;
  onTimeUpdate?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

export interface DualLayerPreviewHandle {
  seekTo: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
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
    onVideoSize,
    onTimeUpdate,
    onPlayingChange,
  },
  ref
) {
  const [Overlay, setOverlay] = useState<React.ComponentType | null>(null);
  const [durationInFrames, setDurationInFrames] = useState(initialDurationInFrames);
  // By default the preview auto-fits the space available in the stage column, so the
  // whole editor (video + timeline + add-marker panel) is visible without scrolling.
  // Dragging the resize handle switches to a manual pixel width, which is allowed to
  // overflow the column vertically (the column itself scrolls) — the user opted in.
  const [fitToScreen, setFitToScreen] = useState(true);
  const [manualWidthPx, setManualWidthPx] = useState<number | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<PlayerRef>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    seekTo: (seconds: number) => {
      if (videoRef.current) videoRef.current.currentTime = seconds;
    },
    play: () => {
      videoRef.current?.play();
    },
    pause: () => {
      videoRef.current?.pause();
    },
    stop: () => {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
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

  // Reset to the auto-fit default whenever a different project loads.
  useEffect(() => {
    setFitToScreen(true);
    setManualWidthPx(null);
  }, [projectId]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setFrameSize({ width, height });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const frames = Math.max(1, Math.round(videoRef.current.duration * fps));
      setDurationInFrames(frames);
      onDurationChange?.(frames);
      // Keep the overlay's canvas locked to the video's real pixel size — otherwise
      // Claude generates positions against the (possibly mismatched) default 1920x1080
      // canvas and elements land outside the actual video frame.
      const { videoWidth, videoHeight } = videoRef.current;
      if (videoWidth && videoHeight) onVideoSize?.(videoWidth, videoHeight);
    }
  };

  const sync = () => {
    if (videoRef.current && playerRef.current) {
      playerRef.current.seekTo(Math.round(videoRef.current.currentTime * fps));
    }
    if (videoRef.current) onTimeUpdate?.(videoRef.current.currentTime);
  };

  const ratio = compositionWidth / compositionHeight;

  // The width that makes the stage fill as much of the frame as possible while
  // staying within BOTH its width and height (so it never needs scrolling).
  const fitWidthPx = (() => {
    if (!frameSize.width || !frameSize.height) return manualWidthPx ?? 0;
    let w = frameSize.width;
    let h = w / ratio;
    if (h > frameSize.height) {
      h = frameSize.height;
      w = h * ratio;
    }
    return Math.max(80, Math.floor(w));
  })();

  const displayWidthPx = fitToScreen ? fitWidthPx : manualWidthPx ?? fitWidthPx;

  // Dragging switches to a manual pixel width (extending the video), which may make the
  // stage taller than the frame — the stage column scrolls to accommodate that instead
  // of clipping. Double-click the handle to snap back to the auto-fit default.
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidthPx = displayWidthPx;
    const maxWidth = frameSize.width || startWidthPx;
    setFitToScreen(false);

    const handleMove = (ev: MouseEvent) => {
      const deltaPx = ev.clientX - startX;
      setManualWidthPx(Math.min(maxWidth, Math.max(200, startWidthPx + deltaPx)));
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const resetToFit = () => {
    setFitToScreen(true);
    setManualWidthPx(null);
  };

  return (
    <div className="stage-frame" ref={frameRef}>
      <div ref={wrapperRef} style={{ width: displayWidthPx ? `${displayWidthPx}px` : '100%' }}>
        <div className="stage" style={{ aspectRatio: `${compositionWidth} / ${compositionHeight}` }}>
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={() => {
                sync();
                onPlayingChange?.(true);
              }}
              onPause={() => {
                sync();
                onPlayingChange?.(false);
              }}
              onEnded={() => onPlayingChange?.(false)}
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
          <div
            className="stage-resize-handle"
            onMouseDown={handleResizeStart}
            onDoubleClick={resetToFit}
            title={fitToScreen ? 'Drag to resize preview' : 'Drag to resize, double-click to fit screen'}
          />
        </div>
      </div>
    </div>
  );
});
