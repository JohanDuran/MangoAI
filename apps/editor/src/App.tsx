import React, { useEffect, useRef, useState } from 'react';
import {
  createProject,
  listProjects,
  getProject,
  addMarker,
  exportProject,
  uploadVideo,
  updateComposition,
  updateMarkerTiming,
  regenerateMarker,
  transcribeProject,
  getTranscript,
  videoUrl as videoUrlFor,
  type Project,
  type Marker,
  type CompositionConfig,
  type TranscriptSegment,
} from './api/client';
import { DualLayerPreview, type DualLayerPreviewHandle } from './components/DualLayerPreview';
import { Timeline } from './components/Timeline';
import { AddMarkerPanel } from './components/AddMarkerPanel';
import { MarkerInspector } from './components/MarkerInspector';

const DEFAULT_COMPOSITION: CompositionConfig = { fps: 30, width: 1920, height: 1080, durationInFrames: 1800 };

export interface MarkerRunState {
  phase: 'generating' | 'done';
  log: string[];
  success?: boolean;
  error?: string;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [composition, setComposition] = useState<CompositionConfig>(DEFAULT_COMPOSITION);
  const [uploading, setUploading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportSucceeded, setExportSucceeded] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [runState, setRunState] = useState<Record<string, MarkerRunState>>({});
  const [pendingStart, setPendingStart] = useState(0);
  const [pendingEnd, setPendingEnd] = useState(3);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const previewRef = useRef<DualLayerPreviewHandle>(null);

  useEffect(() => {
    listProjects().then(setProjects);
  }, []);

  const refreshProject = (id: string) => {
    getProject(id).then(({ markers, hasVideo, composition }) => {
      setMarkers(markers);
      setComposition(composition);
      setVideoUrl(hasVideo ? videoUrlFor(id) : null);
    });
  };

  useEffect(() => {
    if (projectId) {
      refreshProject(projectId);
      getTranscript(projectId).then(({ segments }) => setTranscript(segments));
    } else {
      setMarkers([]);
      setVideoUrl(null);
      setComposition(DEFAULT_COMPOSITION);
      setRunState({});
      setTranscript([]);
    }
  }, [projectId]);

  const handleTranscribe = async () => {
    if (!projectId) return;
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const { segments } = await transcribeProject(projectId);
      setTranscript(segments);
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  };

  const markEdited = () => {
    setExportSucceeded(false);
  };

  const triggerRegenerate = async (markerId: string, feedback: string, allowImage: boolean) => {
    if (!projectId) return;
    markEdited();
    setRunState((prev) => ({ ...prev, [markerId]: { phase: 'generating', log: [] } }));
    try {
      await regenerateMarker(projectId, markerId, feedback, allowImage, (e) => {
        if (e.event === 'progress') {
          const d = e.data as { attempt: number; phase: string; error?: string };
          setRunState((prev) => ({
            ...prev,
            [markerId]: {
              phase: 'generating',
              log: [...(prev[markerId]?.log ?? []), `attempt ${d.attempt}: ${d.phase}${d.error ? ` — ${d.error}` : ''}`],
            },
          }));
        } else if (e.event === 'done') {
          const d = e.data as { success: boolean; error?: string };
          setRunState((prev) => ({
            ...prev,
            [markerId]: { phase: 'done', log: prev[markerId]?.log ?? [], success: d.success, error: d.error },
          }));
        }
      });
    } finally {
      refreshProject(projectId);
      setReloadToken((t) => t + 1);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName) return;
    const project = await createProject(newName);
    setProjects((prev) => [...prev, project]);
    setProjectId(project.id);
    setNewName('');
  };

  const handleAddMarker = async (input: { start: number; end: number; prompt: string; allowImage: boolean }) => {
    if (!projectId) return;
    markEdited();
    const marker = await addMarker(projectId, input);
    refreshProject(projectId);
    setSelectedMarkerId(marker.marker_id);
    triggerRegenerate(marker.marker_id, input.prompt, input.allowImage);
    setPendingStart(input.end);
    setPendingEnd(input.end + 3);
  };

  const handleMarkerTimingChange = async (markerId: string, start: number, end: number) => {
    if (!projectId) return;
    markEdited();
    await updateMarkerTiming(projectId, markerId, { start, end });
    refreshProject(projectId);
    setReloadToken((t) => t + 1);
  };

  const handleUploadVideo = async (file: File) => {
    if (!projectId) return;
    markEdited();
    setUploading(true);
    try {
      await uploadVideo(projectId, file);
      setVideoUrl(videoUrlFor(projectId));
    } finally {
      setUploading(false);
    }
  };

  const handleDurationChange = async (durationInFrames: number) => {
    if (!projectId) return;
    markEdited();
    const next = await updateComposition(projectId, { durationInFrames });
    setComposition(next);
  };

  const handleVideoSize = async (width: number, height: number) => {
    if (!projectId) return;
    if (width === composition.width && height === composition.height) return;
    markEdited();
    const next = await updateComposition(projectId, { width, height });
    setComposition(next);
  };

  const handlePlayPause = () => {
    if (isPlaying) previewRef.current?.pause();
    else previewRef.current?.play();
  };

  const handleStop = () => {
    previewRef.current?.stop();
    setIsPlaying(false);
  };

  // Spacebar toggles play/pause anywhere in the editor, except while the user is
  // typing in a field (or has a button focused, where Space should activate that
  // button as usual rather than double-firing playback).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !projectId) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      handlePlayPause();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectId, isPlaying]);

  const handleExport = async () => {
    if (!projectId) return;
    setExporting(true);
    setExportSucceeded(false);
    setExportStatus('Exporting video…');
    try {
      const result = await exportProject(projectId);
      if (result.success) {
        setExportStatus(`Export complete — saved to ${result.output}`);
        setExportSucceeded(true);
      } else {
        setExportStatus('Export failed — see server logs');
      }
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const selectedMarker = markers.find((m) => m.marker_id === selectedMarkerId) ?? null;
  const durationSeconds = composition.durationInFrames / composition.fps;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">🥭</span>
          MangoAI
        </div>
        <select className="field-select" style={{ width: 200 }} value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
          <option value="">Select a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <form onSubmit={handleCreate} style={{ display: 'flex', gap: 8 }}>
          <input
            className="field-input"
            style={{ width: 160 }}
            placeholder="New project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="btn">
            Create
          </button>
        </form>
        <div className="topbar-spacer" />
        {projectId && (
          <>
            <label className="btn btn-sm" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
              {uploading ? 'Uploading…' : 'Upload video'}
              <input
                type="file"
                accept="video/*"
                disabled={uploading}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUploadVideo(file);
                }}
              />
            </label>
            <button onClick={handleTranscribe} disabled={transcribing} className="btn btn-sm">
              {transcribing ? 'Transcribing…' : transcript.length > 0 ? 'Re-transcribe' : 'Transcribe video'}
            </button>
            <button
              onClick={handleExport}
              disabled={exporting || exportSucceeded}
              className="btn btn-primary"
              style={{ cursor: exporting || exportSucceeded ? 'not-allowed' : 'pointer' }}
            >
              {exporting ? 'Exporting video…' : exportSucceeded ? 'Exported' : 'Export final video'}
            </button>
          </>
        )}
      </div>
      {transcribeError && (
        <div style={{ padding: '0 24px', fontSize: 13, color: 'var(--error)' }}>{transcribeError}</div>
      )}

      <div className="workspace">
        <div className="stage-column">
          {exportStatus && (
            <div style={{ fontSize: 13, color: exportSucceeded ? 'var(--ready)' : 'var(--text-muted)' }}>
              {exportStatus}
            </div>
          )}

          {projectId ? (
            <>
              <DualLayerPreview
                ref={previewRef}
                projectId={projectId}
                videoUrl={videoUrl}
                reloadToken={reloadToken}
                fps={composition.fps}
                compositionWidth={composition.width}
                compositionHeight={composition.height}
                initialDurationInFrames={composition.durationInFrames}
                onDurationChange={handleDurationChange}
                onVideoSize={handleVideoSize}
                onTimeUpdate={setCurrentTime}
                onPlayingChange={setIsPlaying}
              />
              <Timeline
                markers={markers}
                durationSeconds={durationSeconds}
                currentTime={currentTime}
                selectedId={selectedMarkerId}
                runState={runState}
                pendingStart={pendingStart}
                pendingEnd={pendingEnd}
                isPlaying={isPlaying}
                onPlayPause={handlePlayPause}
                onStop={handleStop}
                onSeek={(seconds) => previewRef.current?.seekTo(seconds)}
                onSelect={setSelectedMarkerId}
                onRangeSelect={(start, end) => {
                  setPendingStart(start);
                  setPendingEnd(end);
                }}
                onMarkerTimingChange={handleMarkerTimingChange}
              />
              <AddMarkerPanel
                currentTime={currentTime}
                start={pendingStart}
                end={pendingEnd}
                onStartChange={setPendingStart}
                onEndChange={setPendingEnd}
                onAdd={handleAddMarker}
              />
            </>
          ) : (
            <div className="inspector-empty">Create or select a project to begin.</div>
          )}
        </div>

        <div className="inspector-column">
          {projectId && (
            <MarkerInspector
              projectId={projectId}
              marker={selectedMarker}
              run={selectedMarker ? runState[selectedMarker.marker_id] : undefined}
              transcript={
                selectedMarker
                  ? transcript.filter((s) => s.start < selectedMarker.end && s.end > selectedMarker.start)
                  : []
              }
              onRegenerate={triggerRegenerate}
            />
          )}
        </div>
      </div>
    </div>
  );
}
