import React, { useEffect, useRef, useState } from 'react';
import {
  createProject,
  listProjects,
  getProject,
  addMarker,
  deleteMarker,
  exportProject,
  uploadVideo,
  updateComposition,
  updateMarkerTiming,
  updateMarkerRegion,
  regenerateMarker,
  transcribeProject,
  getTranscript,
  planMarkers,
  applyMarkerPlan,
  videoUrl as videoUrlFor,
  type Project,
  type Marker,
  type MarkerRegion,
  type CompositionConfig,
  type TranscriptSegment,
} from './api/client';
import { DualLayerPreview, type DualLayerPreviewHandle } from './components/DualLayerPreview';
import { Timeline } from './components/Timeline';
import { AddMarkerPanel } from './components/AddMarkerPanel';
import { MarkerInspector } from './components/MarkerInspector';
import { MarkerPlanReview, type ReviewItem } from './components/MarkerPlanReview';

const DEFAULT_COMPOSITION: CompositionConfig = { fps: 30, width: 1920, height: 1080, durationInFrames: 1800 };
const FULL_SCREEN_REGION: MarkerRegion = { x: 0, y: 0, width: 1, height: 1 };

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
  const [editingRegionMarkerId, setEditingRegionMarkerId] = useState<string | null>(null);
  const [regionDraft, setRegionDraft] = useState<MarkerRegion | null>(null);
  // The area for the marker currently being composed in AddMarkerPanel, before it exists
  // server-side. null means "full screen" (not yet customized).
  const [newMarkerRegion, setNewMarkerRegion] = useState<MarkerRegion | null>(null);
  const [editingNewMarkerRegion, setEditingNewMarkerRegion] = useState(false);
  // Whether the "add marker" panel should show when nothing is selected. A plain seek
  // click on the timeline (moving the playhead without selecting or drafting anything)
  // clears this so the right panel goes fully blank instead of showing a stale draft.
  const [newMarkerPanelVisible, setNewMarkerPanelVisible] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const [planReviewOpen, setPlanReviewOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [droppedCount, setDroppedCount] = useState(0);
  const [applyingPlan, setApplyingPlan] = useState(false);
  const previewRef = useRef<DualLayerPreviewHandle>(null);
  const resizingRef = useRef(false);
  // Read by the arrow-key seek handler below without needing currentTime in that effect's
  // deps — currentTime changes on every video timeupdate, which would otherwise tear down
  // and re-add the window keydown listener continuously during playback.
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  // Keep the panel within [280px, 40% of viewport width] as the window itself resizes,
  // not just while dragging.
  useEffect(() => {
    const clamp = (w: number) => Math.min(Math.max(w, 280), window.innerWidth * 0.4);
    setInspectorWidth((w) => clamp(w));
    const onWindowResize = () => setInspectorWidth((w) => clamp(w));
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current) return;
      const maxWidth = window.innerWidth * 0.4;
      const nextWidth = Math.min(maxWidth, Math.max(280, window.innerWidth - moveEvent.clientX));
      setInspectorWidth(nextWidth);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const isFullScreenRegion = (r: MarkerRegion) =>
    Math.abs(r.x) < 0.001 && Math.abs(r.y) < 0.001 && Math.abs(r.width - 1) < 0.001 && Math.abs(r.height - 1) < 0.001;

  useEffect(() => {
    listProjects().then(setProjects);
  }, []);

  const refreshProject = (id: string) => {
    getProject(id).then(({ markers, hasVideo, composition }) => {
      setMarkers(markers);
      setComposition(composition);
      // Keep the existing (already-loaded) video URL rather than minting a fresh
      // cache-busted one on every refresh — changing `src` forces the <video> element to
      // reload from scratch, resetting playback to 0 and undoing any in-progress seek.
      // Only mint a new URL on the actual transition from no-video to has-video.
      setVideoUrl((prev) => (hasVideo ? prev ?? videoUrlFor(id) : null));
    });
  };

  useEffect(() => {
    if (projectId) {
      refreshProject(projectId);
      getTranscript(projectId).then(({ segments }) => setTranscript(segments));
      setNewMarkerPanelVisible(true);
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

  const handlePlanMarkers = async () => {
    if (!projectId) return;
    if (editingRegionMarkerId || editingNewMarkerRegion) {
      setPlanError('Finish or cancel the current area edit first.');
      return;
    }
    setPlanning(true);
    setPlanError(null);
    try {
      const { proposals, droppedCount } = await planMarkers(projectId);
      setReviewItems(
        proposals.map((p) => ({
          key: crypto.randomUUID(),
          included: true,
          start: p.start,
          end: p.end,
          prompt: p.prompt,
          region: p.region,
          allowImage: false,
        }))
      );
      setDroppedCount(droppedCount);
      selectMarker(null);
      setNewMarkerPanelVisible(false);
      setPlanReviewOpen(true);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  };

  const handleReviewItemChange = (key: string, patch: Partial<ReviewItem>) => {
    setReviewItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const handleReviewItemRemove = (key: string) => {
    setReviewItems((prev) => prev.filter((it) => it.key !== key));
  };

  const handleCancelPlanReview = () => {
    setPlanReviewOpen(false);
    setReviewItems([]);
    setPlanError(null);
  };

  // Mirrors triggerRegenerate's SSE-consumption pattern, but multiplexed across the
  // approved items by index — each item gets a real markerId partway through the stream
  // (item-created), after which its progress flows into the same runState map a normal
  // regenerate uses, so Timeline/MarkerInspector and this review panel read one source of
  // truth instead of two.
  const handleApplyPlan = async () => {
    if (!projectId) return;
    const approved = reviewItems.filter((i) => i.included);
    if (approved.length === 0) return;
    markEdited();
    setApplyingPlan(true);
    try {
      await applyMarkerPlan(
        projectId,
        approved.map((i) => ({ start: i.start, end: i.end, prompt: i.prompt, region: i.region, allowImage: i.allowImage })),
        (e) => {
          const d = e.data as {
            index: number;
            markerId?: string;
            attempt?: number;
            phase?: string;
            error?: string;
            success?: boolean;
          };
          const target = approved[d.index];
          if (!target) return;

          if (e.event === 'item-created' && d.markerId) {
            const markerId = d.markerId;
            setReviewItems((prev) => prev.map((it) => (it.key === target.key ? { ...it, markerId } : it)));
            setRunState((prev) => ({ ...prev, [markerId]: { phase: 'generating', log: [] } }));
            refreshProject(projectId);
          } else if (e.event === 'progress' && d.markerId) {
            const markerId = d.markerId;
            setRunState((prev) => ({
              ...prev,
              [markerId]: {
                phase: 'generating',
                log: [...(prev[markerId]?.log ?? []), `attempt ${d.attempt}: ${d.phase}${d.error ? ` — ${d.error}` : ''}`],
              },
            }));
          } else if (e.event === 'item-done') {
            if (d.markerId) {
              const markerId = d.markerId;
              setRunState((prev) => ({
                ...prev,
                [markerId]: { phase: 'done', log: prev[markerId]?.log ?? [], success: !!d.success, error: d.error },
              }));
            } else {
              setReviewItems((prev) => prev.map((it) => (it.key === target.key ? { ...it, error: d.error } : it)));
            }
          }
        }
      );
    } finally {
      refreshProject(projectId);
      setReloadToken((t) => t + 1);
      setApplyingPlan(false);
      setPlanReviewOpen(false);
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
    const region = newMarkerRegion && !isFullScreenRegion(newMarkerRegion) ? newMarkerRegion : undefined;
    const marker = await addMarker(projectId, { ...input, region });
    refreshProject(projectId);
    selectMarker(marker.marker_id);
    triggerRegenerate(marker.marker_id, input.prompt, input.allowImage);
    setPendingStart(input.end);
    setPendingEnd(input.end + 3);
    setNewMarkerRegion(null);
    setEditingNewMarkerRegion(false);
  };

  const handleMarkerTimingChange = async (markerId: string, start: number, end: number) => {
    if (!projectId) return;
    markEdited();
    await updateMarkerTiming(projectId, markerId, { start, end });
    refreshProject(projectId);
    setReloadToken((t) => t + 1);
  };

  const handleDeleteMarker = async (markerId: string) => {
    if (!projectId) return;
    markEdited();
    await deleteMarker(projectId, markerId);
    if (selectedMarkerId === markerId) selectMarker(null);
    setRunState((prev) => {
      const { [markerId]: _removed, ...rest } = prev;
      return rest;
    });
    refreshProject(projectId);
    setReloadToken((t) => t + 1);
  };

  // Switching the selected marker (or losing it) implicitly abandons any in-progress,
  // unsaved region edit for a different marker.
  const selectMarker = (markerId: string | null) => {
    setSelectedMarkerId(markerId);
    if (editingRegionMarkerId && markerId !== editingRegionMarkerId) {
      setEditingRegionMarkerId(null);
      setRegionDraft(null);
    }
  };

  // A plain click on the timeline (moving the playhead, not selecting a marker or
  // dragging out a new range) means the user is just scrubbing — the right panel should
  // go fully blank rather than keep showing whatever was selected or drafted before.
  const handleTimelineDeselect = () => {
    selectMarker(null);
    setNewMarkerPanelVisible(false);
  };

  const handleStartEditRegion = (markerId: string) => {
    setEditingNewMarkerRegion(false);
    const marker = markers.find((m) => m.marker_id === markerId);
    setEditingRegionMarkerId(markerId);
    setRegionDraft(marker?.region ?? FULL_SCREEN_REGION);
  };

  const handleCancelEditRegion = () => {
    setEditingRegionMarkerId(null);
    setRegionDraft(null);
  };

  const handleResetRegionDraft = () => {
    setRegionDraft(FULL_SCREEN_REGION);
  };

  const handleSaveRegion = async () => {
    if (!projectId || !editingRegionMarkerId || !regionDraft) return;
    markEdited();
    await updateMarkerRegion(projectId, editingRegionMarkerId, isFullScreenRegion(regionDraft) ? null : regionDraft);
    setEditingRegionMarkerId(null);
    setRegionDraft(null);
    refreshProject(projectId);
    setReloadToken((t) => t + 1);
  };

  // The new-marker region editor is the same overlay, aimed at local draft state instead
  // of a server round-trip (the marker doesn't exist yet).
  const handleStartEditNewMarkerRegion = () => {
    setEditingRegionMarkerId(null);
    setRegionDraft(null);
    setEditingNewMarkerRegion(true);
    setNewMarkerRegion((prev) => prev ?? FULL_SCREEN_REGION);
  };

  const handleDoneEditNewMarkerRegion = () => {
    setEditingNewMarkerRegion(false);
  };

  const handleResetNewMarkerRegion = () => {
    setNewMarkerRegion(FULL_SCREEN_REGION);
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

  // Spacebar toggles play/pause and the arrow keys nudge the playhead back and forth,
  // anywhere in the editor except while the user is typing in a field (or has a button
  // focused, where Space should activate that button as usual rather than double-firing
  // playback).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!projectId) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        handlePlayPause();
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        const step = 1 / composition.fps;
        const delta = e.code === 'ArrowLeft' ? -step : step;
        const duration = composition.durationInFrames / composition.fps;
        const next = Math.min(duration, Math.max(0, currentTimeRef.current + delta));
        previewRef.current?.seekTo(next);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectId, isPlaying, composition.fps, composition.durationInFrames]);

  const handleExport = async (includeVideo: boolean) => {
    if (!projectId) return;
    setExporting(true);
    setExportSucceeded(false);
    setExportStatus(includeVideo ? 'Exporting MP4 with video…' : 'Exporting overlay…');
    try {
      const result = await exportProject(projectId, includeVideo);
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

  // Only one region overlay is ever active: the new-marker draft takes priority (it has
  // no server-backed marker to fall back to), otherwise whichever existing marker is
  // being edited.
  const activeRegionDraft = editingNewMarkerRegion
    ? newMarkerRegion ?? FULL_SCREEN_REGION
    : editingRegionMarkerId
    ? regionDraft
    : null;
  const handleRegionDraftChange = (region: MarkerRegion) => {
    if (editingNewMarkerRegion) setNewMarkerRegion(region);
    else setRegionDraft(region);
  };

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
              onClick={handlePlanMarkers}
              disabled={transcript.length === 0 || planning}
              className="btn btn-sm"
              title={transcript.length === 0 ? 'Transcribe the video first' : 'Have Claude propose markers from the transcript'}
            >
              {planning ? 'Planning…' : 'Plan markers'}
            </button>
            <button
              onClick={() => handleExport(false)}
              disabled={exporting}
              className="btn btn-sm"
              title="Transparent overlay only (.webm)"
            >
              Export overlay
            </button>
            <button
              onClick={() => handleExport(true)}
              disabled={exporting}
              className="btn btn-primary"
              title="Base video + overlay mixed (.mp4)"
            >
              {exporting ? 'Exporting…' : 'Export MP4 (video + overlay)'}
            </button>
          </>
        )}
      </div>
      {transcribeError && (
        <div style={{ padding: '0 24px', fontSize: 13, color: 'var(--error)' }}>{transcribeError}</div>
      )}
      {planError && <div style={{ padding: '0 24px', fontSize: 13, color: 'var(--error)' }}>{planError}</div>}

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
                regionDraft={activeRegionDraft}
                onRegionDraftChange={handleRegionDraftChange}
                onRegionCommit={editingRegionMarkerId ? handleSaveRegion : undefined}
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
                onSelect={selectMarker}
                onDeselectAll={handleTimelineDeselect}
                onRangeSelect={(start, end) => {
                  // Starting a new pending range is the user saying "I'm making a new
                  // marker" — keeping the old one selected would leave the inspector's
                  // (and its Animation area) showing a different marker than the one
                  // about to be created, which reads as if it applies to the new one.
                  selectMarker(null);
                  setNewMarkerPanelVisible(true);
                  setPendingStart(start);
                  setPendingEnd(end);
                }}
                onMarkerTimingChange={handleMarkerTimingChange}
                onEditRegion={(markerId) => {
                  selectMarker(markerId);
                  handleStartEditRegion(markerId);
                }}
              />
            </>
          ) : (
            <div className="inspector-empty">Create or select a project to begin.</div>
          )}
        </div>

        <div className="resize-handle" onMouseDown={handleResizeStart} />

        <div className="inspector-column" style={{ width: inspectorWidth }}>
          {/* At most one of these shows at a time: the plan review takes priority over
              everything else while open, then with no marker selected the user is
              composing a new one, then selecting an existing marker replaces that draft
              view with its inspector (the draft itself is preserved for when it's
              deselected). A plain timeline seek clears newMarkerPanelVisible, leaving the
              panel blank. */}
          {projectId && planReviewOpen && (
            <MarkerPlanReview
              items={reviewItems}
              droppedCount={droppedCount}
              applying={applyingPlan}
              runState={runState}
              onChange={handleReviewItemChange}
              onRemove={handleReviewItemRemove}
              onCancel={handleCancelPlanReview}
              onApply={handleApplyPlan}
            />
          )}
          {projectId && !planReviewOpen && !selectedMarker && newMarkerPanelVisible && (
            <AddMarkerPanel
              currentTime={currentTime}
              start={pendingStart}
              end={pendingEnd}
              onStartChange={setPendingStart}
              onEndChange={setPendingEnd}
              onAdd={handleAddMarker}
              region={newMarkerRegion}
              editingRegion={editingNewMarkerRegion}
              onStartEditRegion={handleStartEditNewMarkerRegion}
              onDoneEditRegion={handleDoneEditNewMarkerRegion}
              onResetRegion={handleResetNewMarkerRegion}
            />
          )}
          {projectId && !planReviewOpen && selectedMarker && (
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
              onDelete={handleDeleteMarker}
              regionEditing={editingRegionMarkerId === selectedMarker?.marker_id}
              regionDraft={editingRegionMarkerId === selectedMarker?.marker_id ? regionDraft : null}
              onStartEditRegion={handleStartEditRegion}
              onCancelEditRegion={handleCancelEditRegion}
              onResetRegionDraft={handleResetRegionDraft}
              onSaveRegion={handleSaveRegion}
            />
          )}
        </div>
      </div>
    </div>
  );
}
