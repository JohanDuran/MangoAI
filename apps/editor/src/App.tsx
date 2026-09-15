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
  videoUrl as videoUrlFor,
  type Project,
  type Marker,
  type CompositionConfig,
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
  const [currentTime, setCurrentTime] = useState(0);
  const [runState, setRunState] = useState<Record<string, MarkerRunState>>({});
  const [pendingStart, setPendingStart] = useState(0);
  const [pendingEnd, setPendingEnd] = useState(3);
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
    if (projectId) refreshProject(projectId);
    else {
      setMarkers([]);
      setVideoUrl(null);
      setComposition(DEFAULT_COMPOSITION);
      setRunState({});
    }
  }, [projectId]);

  const triggerRegenerate = async (markerId: string, feedback: string) => {
    if (!projectId) return;
    setRunState((prev) => ({ ...prev, [markerId]: { phase: 'generating', log: [] } }));
    try {
      await regenerateMarker(projectId, markerId, feedback, (e) => {
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

  const handleAddMarker = async (input: { start: number; end: number; prompt: string }) => {
    if (!projectId) return;
    const marker = await addMarker(projectId, input);
    refreshProject(projectId);
    setSelectedMarkerId(marker.marker_id);
    triggerRegenerate(marker.marker_id, input.prompt);
    setPendingStart(input.end);
    setPendingEnd(input.end + 3);
  };

  const handleMarkerTimingChange = async (markerId: string, start: number, end: number) => {
    if (!projectId) return;
    await updateMarkerTiming(projectId, markerId, { start, end });
    refreshProject(projectId);
    setReloadToken((t) => t + 1);
  };

  const handleUploadVideo = async (file: File) => {
    if (!projectId) return;
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
    const next = await updateComposition(projectId, { durationInFrames });
    setComposition(next);
  };

  const handleExport = async () => {
    if (!projectId) return;
    setExportStatus('Rendering…');
    try {
      const result = await exportProject(projectId);
      setExportStatus(result.success ? `Exported to ${result.output}` : 'Export failed — see server logs');
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : String(err));
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
            <button onClick={handleExport} className="btn btn-primary">
              Export final video
            </button>
          </>
        )}
      </div>

      <div className="workspace">
        <div className="stage-column">
          {exportStatus && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{exportStatus}</div>}

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
                onTimeUpdate={setCurrentTime}
              />
              <Timeline
                markers={markers}
                durationSeconds={durationSeconds}
                currentTime={currentTime}
                selectedId={selectedMarkerId}
                runState={runState}
                pendingStart={pendingStart}
                pendingEnd={pendingEnd}
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
              onRegenerate={triggerRegenerate}
            />
          )}
        </div>
      </div>
    </div>
  );
}
