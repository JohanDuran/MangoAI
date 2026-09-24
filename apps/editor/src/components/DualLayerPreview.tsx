import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { RegionOverlay } from './RegionOverlay';
import { BASE, type BaseLayer, type MarkerRegion } from '../api/client';

interface Props {
  projectId: string;
  videoUrl: string | null;
  baseLayer: BaseLayer;
  reloadToken: number;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  initialDurationInFrames: number;
  onDurationChange?: (durationInFrames: number) => void;
  onVideoSize?: (width: number, height: number) => void;
  onTimeUpdate?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  regionDraft?: MarkerRegion | null;
  onRegionDraftChange?: (region: MarkerRegion) => void;
  onRegionCommit?: () => void;
  overlayVolume?: number;
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
    baseLayer,
    reloadToken,
    fps,
    compositionWidth,
    compositionHeight,
    initialDurationInFrames,
    onDurationChange,
    onVideoSize,
    onTimeUpdate,
    onPlayingChange,
    regionDraft,
    onRegionDraftChange,
    onRegionCommit,
    overlayVolume = 1,
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
  const [playbackRate, setPlaybackRate] = useState(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The last <video> element that existed. By the time an unmount cleanup runs, React has already
  // detached videoRef, so the cleanup below needs its own reference.
  const lastVideoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<PlayerRef>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // With no video, there's nothing to be a master clock — the Remotion Player drives itself.
  const hasVideo = videoUrl !== null && baseLayer.type === 'video';

  useImperativeHandle(ref, () => ({
    seekTo: (seconds: number) => {
      if (hasVideo) {
        if (videoRef.current) videoRef.current.currentTime = seconds;
      } else {
        playerRef.current?.seekTo(Math.round(seconds * fps));
      }
    },
    play: () => {
      if (hasVideo) videoRef.current?.play();
      else playerRef.current?.play();
    },
    pause: () => {
      if (hasVideo) videoRef.current?.pause();
      else playerRef.current?.pause();
    },
    stop: () => {
      if (hasVideo) {
        if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.currentTime = 0;
        }
      } else {
        playerRef.current?.pause();
        playerRef.current?.seekTo(0);
      }
    },
  }));

  useEffect(() => {
    // The runner bundles the project's generated overlay on request, so it picks up projects and
    // marker edits created after this component first loaded.
    let cancelled = false;
    const url = `${BASE}/projects/${encodeURIComponent(projectId)}/overlay.js?t=${reloadToken}`;
    import(/* @vite-ignore */ url)
      .then((mod: { default: React.ComponentType }) => {
        if (!cancelled) setOverlay(() => mod.default);
      })
      .catch((err) => {
        console.error('Could not load the overlay for this project', err);
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

  const videoFrame = () => Math.round((videoRef.current?.currentTime ?? 0) * fps);

  // The <video> is the master clock. The overlay Player also plays (not just seeks) so that
  // <Audio> in a marker is heard while editing; it is kept within DRIFT_FRAMES of the video.
  const DRIFT_FRAMES = Math.ceil(fps * 0.2);

  const startPlayer = (e?: React.SyntheticEvent) => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video || video.paused) return;
    // Playing at the very last frame would make the Player restart from 0.
    if (videoFrame() >= durationInFrames - 1) return;
    player.seekTo(videoFrame());
    player.play(e);
  };

  const stopPlayer = () => {
    const player = playerRef.current;
    if (!player) return;
    player.pause();
    player.seekTo(videoFrame());
  };

  const sync = () => {
    const video = videoRef.current;
    const player = playerRef.current;
    if (video && player) {
      const target = videoFrame();
      if (video.paused) {
        player.seekTo(target);
      } else if (!player.isPlaying()) {
        // The overlay finished loading mid-playback, or a seek paused it.
        startPlayer();
      } else if (Math.abs(player.getCurrentFrame() - target) > DRIFT_FRAMES) {
        player.seekTo(target);
      }
    }
    if (video) onTimeUpdate?.(video.currentTime);
  };

  // With no video, the Remotion Player is its own master clock — wire its events straight to the
  // same callbacks the <video> element drives in the normal path.
  useEffect(() => {
    if (hasVideo || !Overlay) return;
    const player = playerRef.current;
    if (!player) return;
    const handleFrameUpdate = (e: { detail: { frame: number } }) => onTimeUpdate?.(e.detail.frame / fps);
    const handlePlay = () => onPlayingChange?.(true);
    const handlePause = () => onPlayingChange?.(false);
    const handleEnded = () => onPlayingChange?.(false);
    player.addEventListener('frameupdate', handleFrameUpdate);
    player.addEventListener('play', handlePlay);
    player.addEventListener('pause', handlePause);
    player.addEventListener('ended', handleEnded);
    return () => {
      player.removeEventListener('frameupdate', handleFrameUpdate);
      player.removeEventListener('play', handlePlay);
      player.removeEventListener('pause', handlePause);
      player.removeEventListener('ended', handleEnded);
    };
  }, [hasVideo, Overlay, fps, onTimeUpdate, onPlayingChange]);

  // On unmount (the user switched project) stop the video and drop its source, so the browser stops
  // buffering and decoding media nobody is watching. Deliberately unmount-only: running this when
  // videoUrl changes would blank the new video right after React sets it.
  useEffect(
    () => () => {
      const video = lastVideoRef.current;
      if (!video) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
    []
  );

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setVolume(overlayVolume);
  }, [overlayVolume, Overlay]);

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

  // Dragging switches to a manual pixel width. Capped to fitWidthPx (not just
  // frameSize.width) so the stage can never grow taller than the frame either — `.stage`
  // is position:relative, so an oversized stage doesn't just get clipped by the column's
  // scroll, it paints on top of the Timeline/AddMarkerPanel below it. Double-click the
  // handle to snap back to the auto-fit default.
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidthPx = displayWidthPx;
    const maxWidth = fitWidthPx || frameSize.width || startWidthPx;
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

  // Solid/gradient stand in for the <video> element; transparent needs nothing extra — the
  // stage's own checkerboard background already shows through.
  const backgroundStyle: React.CSSProperties | null =
    baseLayer.type === 'color'
      ? { background: baseLayer.color }
      : baseLayer.type === 'gradient'
      ? { background: `linear-gradient(${baseLayer.angle}deg, ${baseLayer.from}, ${baseLayer.to})` }
      : null;

  return (
    <div className="stage-frame" ref={frameRef}>
      <div ref={wrapperRef} style={{ width: displayWidthPx ? `${displayWidthPx}px` : '100%' }}>
        <div className="stage" style={{ aspectRatio: `${compositionWidth} / ${compositionHeight}` }}>
          {!hasVideo && backgroundStyle && <div className="stage-background" style={backgroundStyle} />}
          {hasVideo ? (
            <video
              ref={(el) => {
                videoRef.current = el;
                if (el) lastVideoRef.current = el;
              }}
              src={videoUrl ?? ''}
              controls
              controlsList="nofullscreen"
              disablePictureInPicture
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={(e) => {
                startPlayer(e);
                onTimeUpdate?.(e.currentTarget.currentTime);
                onPlayingChange?.(true);
              }}
              onPlaying={startPlayer}
              onWaiting={stopPlayer}
              onPause={() => {
                stopPlayer();
                onTimeUpdate?.(videoRef.current?.currentTime ?? 0);
                onPlayingChange?.(false);
              }}
              onEnded={() => {
                stopPlayer();
                onPlayingChange?.(false);
              }}
              onRateChange={(e) => setPlaybackRate(e.currentTarget.playbackRate)}
              onSeeked={sync}
              onTimeUpdate={sync}
            />
          ) : baseLayer.type === 'video' ? (
            <div className="stage-empty">Upload a video above to start previewing overlays here.</div>
          ) : null}
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
                playbackRate={playbackRate}
              />
            </div>
          )}
          {regionDraft && onRegionDraftChange && (
            <RegionOverlay region={regionDraft} onChange={onRegionDraftChange} onCommit={onRegionCommit} />
          )}
          {!regionDraft && (
            <div
              className="stage-resize-handle"
              onMouseDown={handleResizeStart}
              onDoubleClick={resetToFit}
              title={fitToScreen ? 'Drag to resize preview' : 'Drag to resize, double-click to fit screen'}
            />
          )}
        </div>
      </div>
    </div>
  );
});
