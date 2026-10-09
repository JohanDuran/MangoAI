import React, { useEffect, useRef, useState } from 'react';
import {
  createProject,
  deleteProject,
  listProjects,
  getProject,
  saveOverlayVolume,
  saveVoiceVolume,
  getVoices,
  saveMarkerNarration,
  generateMarkerNarration,
  playableNarration,
  narrationUrl,
  type VoiceOptions,
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
  updateTranscript,
  listAssets,
  uploadAsset,
  setMarkerAssets,
  describeAsset,
  saveAutoDescribe,
  planMarkers,
  planMarkersFromIdea,
  applyMarkerPlan,
  getPlan,
  savePlan,
  discardPlan,
  stopWork,
  StoppedError,
  type StoredPlan,
  type PlanSource,
  videoUrl as videoUrlFor,
  type Asset,
  type Project,
  type Marker,
  type MarkerRegion,
  type CompositionConfig,
  type TranscriptSegment,
  type BaseLayer,
  type CreateProjectOptions,
} from './api/client';
import { DualLayerPreview, type DualLayerPreviewHandle, type StagePoint } from './components/DualLayerPreview';
import { Timeline } from './components/Timeline';
import { AddMarkerPanel } from './components/AddMarkerPanel';
import { IdeaPlanPanel } from './components/IdeaPlanPanel';
import { MarkerInspector } from './components/MarkerInspector';
import { AssetLibrary } from './components/AssetLibrary';
import { MarkerPlanReview, ALL_AREAS_KEY, isItemDone, type ReviewItem } from './components/MarkerPlanReview';
import { PlanMarkersPanel } from './components/PlanMarkersPanel';
import { TranscriptPanel } from './components/TranscriptPanel';
import { CreateProjectModal } from './components/CreateProjectModal';
import { StatusButton, StatusDashboard, useStatus } from './components/StatusDashboard';
import { ConnectionBanner } from './components/ConnectionBanner';
import { NoticeStack, notify, describeError } from './notify';
import { desktop } from './desktop';
import { cancelExport, getExportStatus, type ExportStatus } from './api/client';

const DEFAULT_COMPOSITION: CompositionConfig = { fps: 30, width: 1920, height: 1080, durationInFrames: 1800 };
const DEFAULT_BASE_LAYER: BaseLayer = { type: 'video' };
const FULL_SCREEN_REGION: MarkerRegion = { x: 0, y: 0, width: 1, height: 1 };

export interface MarkerRunState {
  phase: 'generating' | 'done';
  log: string[];
  success?: boolean;
  error?: string;
}

// Owns only what outlives a project: the list of projects and which one is open. Everything else
// lives in Workspace, which is keyed by project id: switching projects unmounts the old workspace
// completely (state, player, video, listeners, open streams) and mounts a fresh one, so nothing
// from the previous project can leak into the next.
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  // ?project=<id> opens that project directly.
  const [projectId, setProjectId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('project'));

  useEffect(() => {
    listProjects().then(setProjects);
  }, []);

  return (
    <Workspace
      key={projectId ?? 'no-project'}
      projectId={projectId}
      projects={projects}
      setProjects={setProjects}
      onProjectChange={setProjectId}
    />
  );
}

interface WorkspaceProps {
  projectId: string | null;
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  onProjectChange: (id: string | null) => void;
}

function Workspace({ projectId, projects, setProjects, onProjectChange }: WorkspaceProps) {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const status = useStatus();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [composition, setComposition] = useState<CompositionConfig>(DEFAULT_COMPOSITION);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>(DEFAULT_BASE_LAYER);
  const [uploading, setUploading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportSucceeded, setExportSucceeded] = useState(false);
  const [splitByMarker, setSplitByMarker] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [runState, setRunState] = useState<Record<string, MarkerRunState>>({});
  const [pendingStart, setPendingStart] = useState(0);
  const [pendingEnd, setPendingEnd] = useState(3);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [overlayVolume, setOverlayVolume] = useState(1);
  const [voiceVolume, setVoiceVolume] = useState(1);
  // The voices OpenAI offers, and the one this project last used.
  const [voices, setVoices] = useState<VoiceOptions | null>(null);
  const [projectVoice, setProjectVoice] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [autoDescribe, setAutoDescribe] = useState(false);
  const [describingIds, setDescribingIds] = useState<string[]>([]);
  // The volume last loaded from or saved to the server, so loading a project does not write it back.
  const savedVolumeRef = useRef<{ projectId: string; volume: number } | null>(null);
  const savedVoiceVolumeRef = useRef<{ projectId: string; volume: number } | null>(null);
  const [editingRegionMarkerId, setEditingRegionMarkerId] = useState<string | null>(null);
  const [regionDraft, setRegionDraft] = useState<MarkerRegion | null>(null);
  // Markers whose animation area was resized (not just moved) after it was already
  // generated — the existing code was designed for the old regionWidth/regionHeight and
  // may no longer fit, so the inspector nudges the user to regenerate. Cleared once a
  // regenerate attempt runs for that marker.
  const [staleRegionMarkers, setStaleRegionMarkers] = useState<Set<string>>(new Set());
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
  const [ideaPanelOpen, setIdeaPanelOpen] = useState(false);
  // The idea being written and the area every marker designed from it goes in (null = Claude
  // picks per marker). Kept here so hiding the panel to work on the timeline doesn't lose them.
  const [ideaDraft, setIdeaDraft] = useState('');
  const [ideaRegion, setIdeaRegion] = useState<MarkerRegion | null>(null);
  const [editingIdeaRegion, setEditingIdeaRegion] = useState(false);
  // Whether "Design from idea" also writes voiceover lines. Until the user picks, it is on for
  // projects without a video (they have no speech of their own) and off otherwise.
  const [ideaNarration, setIdeaNarration] = useState<boolean | null>(null);
  const [planPanelOpen, setPlanPanelOpen] = useState(false);
  const [transcriptPanelOpen, setTranscriptPanelOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [droppedCount, setDroppedCount] = useState(0);
  // Which proposed marker's area is being drawn on the preview, if any — mirrors
  // editingRegionMarkerId/editingNewMarkerRegion but targets a reviewItems entry directly
  // since it has no server-backed marker until the plan is applied.
  // ALL_AREAS_KEY while one area is drawn for every selected item still to generate.
  const [editingPlanItemKey, setEditingPlanItemKey] = useState<string | null>(null);
  const [applyingPlan, setApplyingPlan] = useState(false);
  // What the open plan was made from, and whether it was restored after an interrupted apply.
  const [planSource, setPlanSource] = useState<PlanSource | null>(null);
  const [planInterrupted, setPlanInterrupted] = useState(false);
  // Set when planning was interrupted (crash, reload): the planning panel reopens with the request
  // filled in so it can be run again.
  const [interruptedPlanning, setInterruptedPlanning] = useState<PlanSource | null>(null);
  // Tags of the runs a Stop was requested for ('plan', 'apply', 'regenerate:<markerId>').
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  // The review items last saved to (or loaded from) the runner, so unchanged items are not re-sent.
  const savedPlanItemsRef = useRef<string>('');
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

  // Aborted when this workspace unmounts (the user switched project), which closes any generation
  // streams it still has open. Created in an effect so StrictMode's simulated unmount cannot leave
  // an already-aborted controller behind.
  const abortRef = useRef(new AbortController());
  useEffect(() => {
    abortRef.current = new AbortController();
    return () => abortRef.current.abort();
  }, []);

  const refreshProject = (id: string) =>
    getProject(id).then(({ markers, hasVideo, composition }) => {
      setMarkers(markers);
      setComposition(composition);
      // Keep the existing (already-loaded) video URL rather than minting a fresh
      // cache-busted one on every refresh — changing `src` forces the <video> element to
      // reload from scratch, resetting playback to 0 and undoing any in-progress seek.
      // Only mint a new URL on the actual transition from no-video to has-video.
      setVideoUrl((prev) => (hasVideo ? prev ?? videoUrlFor(id) : null));
    });

  const refreshAssets = (id: string) => listAssets(id).then(setAssets).catch(() => {});

  // Has Claude describe an image. Rejects with the error so a card can show it.
  const handleDescribeAsset = async (assetId: string, overwrite = false) => {
    if (!projectId) return;
    setDescribingIds((prev) => [...prev, assetId]);
    try {
      await describeAsset(projectId, assetId, overwrite);
      await refreshAssets(projectId);
    } finally {
      setDescribingIds((prev) => prev.filter((id) => id !== assetId));
    }
  };

  // Uploads run one at a time; resolves with the assets that were added so a picker can select them.
  // With auto-describe on, each new image is described in the background afterwards.
  const handleUploadAssets = async (files: File[]): Promise<Asset[]> => {
    if (!projectId) return [];
    const added: Asset[] = [];
    try {
      for (const file of files) added.push(await uploadAsset(projectId, file));
    } finally {
      await refreshAssets(projectId);
    }
    if (autoDescribe) for (const asset of added) handleDescribeAsset(asset.id).catch(() => {});
    return added;
  };

  const handleToggleAutoDescribe = (value: boolean) => {
    if (!projectId) return;
    setAutoDescribe(value);
    saveAutoDescribe(projectId, value).catch(() => setAutoDescribe(!value));
  };

  const handleSetMarkerAssets = async (markerId: string, ids: string[]) => {
    if (!projectId) return;
    markEdited();
    await setMarkerAssets(projectId, markerId, ids);
    refreshProject(projectId);
  };

  useEffect(() => {
    if (projectId) {
      refreshProject(projectId);
      refreshAssets(projectId);
      getTranscript(projectId).then(({ segments }) => setTranscript(segments));
      getProject(projectId).then(({ project, baseLayer }) => {
        const volume = project.overlayVolume ?? 1;
        savedVolumeRef.current = { projectId, volume };
        setOverlayVolume(volume);
        const voiceVol = project.voiceVolume ?? 1;
        savedVoiceVolumeRef.current = { projectId, volume: voiceVol };
        setVoiceVolume(voiceVol);
        setProjectVoice(project.voice ?? null);
        setAutoDescribe(!!project.autoDescribeImages);
        setBaseLayer(baseLayer);
      });
      setNewMarkerPanelVisible(true);
      restorePlan(projectId).catch(() => {});
    } else {
      savedVolumeRef.current = null;
      savedVoiceVolumeRef.current = null;
      setProjectVoice(null);
      setMarkers([]);
      setVideoUrl(null);
      setComposition(DEFAULT_COMPOSITION);
      setBaseLayer(DEFAULT_BASE_LAYER);
      setRunState({});
      setTranscript([]);
      setAssets([]);
      setLibraryOpen(false);
      setAutoDescribe(false);
      setDescribingIds([]);
    }
  }, [projectId]);

  // Persist the overlay volume shortly after the slider stops moving, so the export uses it.
  useEffect(() => {
    const saved = savedVolumeRef.current;
    if (!projectId || !saved || saved.projectId !== projectId || saved.volume === overlayVolume) return;
    const timer = setTimeout(() => {
      markEdited();
      saveOverlayVolume(projectId, overlayVolume)
        .then(() => {
          savedVolumeRef.current = { projectId, volume: overlayVolume };
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [overlayVolume, projectId]);

  // Same for the voiceover volume.
  useEffect(() => {
    const saved = savedVoiceVolumeRef.current;
    if (!projectId || !saved || saved.projectId !== projectId || saved.volume === voiceVolume) return;
    const timer = setTimeout(() => {
      markEdited();
      saveVoiceVolume(projectId, voiceVolume)
        .then(() => {
          savedVoiceVolumeRef.current = { projectId, volume: voiceVolume };
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [voiceVolume, projectId]);

  useEffect(() => {
    getVoices()
      .then(setVoices)
      .catch(() => {});
  }, []);

  const defaultVoice = projectVoice ?? voices?.defaultVoice ?? 'marin';

  // Saves a marker's voiceover line and turns it into speech; an empty line removes the voiceover.
  // Rejects with the reason so the inspector can show it.
  const handleGenerateVoice = async (markerId: string, text: string, voice: string) => {
    if (!projectId) return;
    markEdited();
    try {
      await saveMarkerNarration(projectId, markerId, text, voice);
      if (text.trim()) {
        setProjectVoice(voice);
        const before = markers.find((m) => m.marker_id === markerId);
        const after = await generateMarkerNarration(projectId, markerId);
        // A voice longer than its marker lengthens it (and can push later markers back).
        if (after.end !== before?.end) setReloadToken((t) => t + 1);
      }
    } finally {
      await refreshProject(projectId).catch(() => {});
    }
  };

  const handleTranscribe = async () => {
    if (!projectId) return;
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const { segments } = await transcribeProject(projectId);
      setTranscript(segments);
      setTranscriptPanelOpen(true);
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  };

  const handleSaveTranscript = async (segments: TranscriptSegment[]) => {
    if (!projectId) return;
    const saved = await updateTranscript(projectId, segments);
    setTranscript(saved.segments);
  };

  const handleSeek = (seconds: number) => {
    previewRef.current?.pause();
    previewRef.current?.seekTo(seconds);
  };

  const markEdited = () => {
    setExportSucceeded(false);
  };

  const triggerRegenerate = async (markerId: string, feedback: string, allowImage: boolean) => {
    if (!projectId) return;
    markEdited();
    setStaleRegionMarkers((prev) => {
      if (!prev.has(markerId)) return prev;
      const next = new Set(prev);
      next.delete(markerId);
      return next;
    });
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
          const d = e.data as { success: boolean; error?: string; cancelled?: boolean };
          // A stopped run left the marker as it was, so it goes back to showing its saved status.
          setRunState((prev) => {
            const next = { ...prev };
            if (d.cancelled) delete next[markerId];
            else next[markerId] = { phase: 'done', log: prev[markerId]?.log ?? [], success: d.success, error: d.error };
            return next;
          });
        }
      }, abortRef.current.signal);
    } finally {
      markStopping(`regenerate:${markerId}`, false);
      if (!abortRef.current.signal.aborted) {
        refreshProject(projectId);
        setReloadToken((t) => t + 1);
      }
    }
  };

  const markStopping = (tag: string, on: boolean) =>
    setStopping((prev) => {
      if (prev.has(tag) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(tag);
      else next.delete(tag);
      return next;
    });

  // Asks the runner to stop a run. The flow that started the run clears the stopping state when its
  // request ends; if nothing was running any more, it is cleared here.
  const requestStop = async (tag: string) => {
    if (!projectId) return;
    markStopping(tag, true);
    try {
      const { stopped } = await stopWork(projectId, tag);
      if (stopped === 0) markStopping(tag, false);
    } catch (err) {
      markStopping(tag, false);
      notify('error', `Could not stop: ${describeError(err)}`);
    }
  };

  const openPlanReview = (plan: StoredPlan, interrupted: boolean) => {
    savedPlanItemsRef.current = JSON.stringify(plan.items);
    setReviewItems(plan.items);
    setDroppedCount(plan.droppedCount);
    setPlanSource(plan.source);
    setPlanInterrupted(interrupted);
    setEditingPlanItemKey(null);
    setPlanPanelOpen(false);
    closeIdeaPanel();
    setInterruptedPlanning(null);
    selectMarker(null);
    setNewMarkerPanelVisible(false);
    setPlanReviewOpen(true);
  };

  // Picks the saved plan back up when a project opens: a plan waiting for review reopens as it was
  // left, one whose planning or applying was cut off (crash, reload, quit) reopens so it can be resumed.
  const restorePlan = async (id: string) => {
    const { plan, running } = await getPlan(id);
    if (!plan || abortRef.current.signal.aborted) return;
    if (plan.state === 'planning') {
      if (running.includes('plan')) return;
      setInterruptedPlanning(plan.source);
      selectMarker(null);
      setNewMarkerPanelVisible(false);
      if (plan.source.kind === 'idea') {
        setIdeaDraft(plan.source.idea);
        setIdeaRegion(plan.source.region ?? null);
        setIdeaNarration(!!plan.source.narration);
        setIdeaPanelOpen(true);
      } else setPlanPanelOpen(true);
      return;
    }
    openPlanReview(plan, plan.state === 'applying' && !running.includes('apply'));
  };

  const interruptedPlanningNotice = interruptedPlanning
    ? 'Planning was interrupted before Claude finished. Your request is filled in below: run it again, or cancel to discard it.'
    : null;

  const handleClosePlanPanel = (close: () => void) => {
    close();
    setPlanError(null);
    if (interruptedPlanning && projectId) {
      setInterruptedPlanning(null);
      discardPlan(projectId).catch(() => {});
    }
  };

  const runPlanner = async (request: () => ReturnType<typeof planMarkers>) => {
    if (!projectId) return;
    if (editingRegionMarkerId || editingNewMarkerRegion) {
      setPlanError('Finish or cancel the current area edit first.');
      return;
    }
    setPlanning(true);
    setPlanError(null);
    try {
      const { plan } = await request();
      if (!abortRef.current.signal.aborted) openPlanReview(plan, false);
    } catch (err) {
      if (err instanceof StoppedError) setInterruptedPlanning(null);
      else setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
      markStopping('plan', false);
    }
  };

  const handlePlanMarkers = (context: string) => runPlanner(() => planMarkers(projectId!, context));

  const ideaNarrationOn = ideaNarration ?? baseLayer.type !== 'video';

  const handlePlanFromIdea = (idea: string) => {
    setEditingIdeaRegion(false);
    const region = ideaRegion && !isFullScreenRegion(ideaRegion) ? ideaRegion : undefined;
    return runPlanner(() => planMarkersFromIdea(projectId!, idea, { region, narration: ideaNarrationOn }));
  };

  // Hides the idea panel (the draft and area stay for when it is reopened). Planning carries on
  // regardless; the toolbar keeps its Stop button.
  const closeIdeaPanel = () => {
    setIdeaPanelOpen(false);
    setEditingIdeaRegion(false);
  };

  // Picking a marker or dragging out a new range on the timeline/preview means the user moved on
  // from the planning form, so it gives way to that marker's inspector or the new-marker panel.
  const hidePlanningPanels = () => {
    closeIdeaPanel();
    setPlanPanelOpen(false);
  };

  const handleStartEditIdeaRegion = () => {
    setEditingRegionMarkerId(null);
    setRegionDraft(null);
    setEditingNewMarkerRegion(false);
    setEditingPlanItemKey(null);
    setEditingIdeaRegion(true);
    setIdeaRegion((prev) => prev ?? FULL_SCREEN_REGION);
  };

  // Review edits are saved to the runner shortly after they stop, so a crash does not lose them.
  // While applying, the runner records progress in the plan itself.
  useEffect(() => {
    if (!projectId || !planReviewOpen || applyingPlan) return;
    const serialized = JSON.stringify(reviewItems);
    if (serialized === savedPlanItemsRef.current) return;
    const timer = setTimeout(() => {
      savePlan(projectId, reviewItems)
        .then(() => {
          savedPlanItemsRef.current = serialized;
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [reviewItems, planReviewOpen, applyingPlan, projectId]);

  // Items "Edit all areas" changes: the selected ones that have not been generated yet.
  const isBulkAreaTarget = (item: ReviewItem) => item.included && !isItemDone(item, markers);

  const handleReviewItemChange = (key: string, patch: Partial<ReviewItem>) => {
    setReviewItems((prev) =>
      prev.map((it) => (key === ALL_AREAS_KEY ? isBulkAreaTarget(it) : it.key === key) ? { ...it, ...patch } : it)
    );
  };

  const handleReviewItemRemove = (key: string) => {
    setReviewItems((prev) => prev.filter((it) => it.key !== key));
    setEditingPlanItemKey((k) => (k === key ? null : k));
  };

  const handleCancelPlanReview = () => {
    setPlanReviewOpen(false);
    setReviewItems([]);
    setPlanError(null);
    setEditingPlanItemKey(null);
    setPlanSource(null);
    setPlanInterrupted(false);
    savedPlanItemsRef.current = '';
    if (projectId) discardPlan(projectId).catch(() => {});
  };

  const handleStartEditPlanItemRegion = (key: string) => {
    setEditingRegionMarkerId(null);
    setEditingNewMarkerRegion(false);
    setEditingPlanItemKey(key);
  };

  const handleDoneEditPlanItemRegion = () => {
    setEditingPlanItemKey(null);
  };

  const handleResetPlanItemRegion = () => {
    if (editingPlanItemKey) handleReviewItemChange(editingPlanItemKey, { region: null });
  };

  // Mirrors triggerRegenerate's SSE-consumption pattern, but multiplexed across the
  // approved items by index — each item gets a real markerId partway through the stream
  // (item-created), after which its progress flows into the same runState map a normal
  // regenerate uses, so Timeline/MarkerInspector and this review panel read one source of
  // truth instead of two.
  const handleApplyPlan = async () => {
    if (!projectId) return;
    const approved = reviewItems.filter(isBulkAreaTarget);
    if (approved.length === 0) return;
    markEdited();
    setEditingPlanItemKey(null);
    setPlanInterrupted(false);
    setApplyingPlan(true);
    // Make sure the runner has the latest edits before it starts recording progress in the plan.
    await savePlan(projectId, reviewItems)
      .then(() => {
        savedPlanItemsRef.current = JSON.stringify(reviewItems);
      })
      .catch(() => {});
    let planRemaining = false;
    try {
      await applyMarkerPlan(
        projectId,
        approved.map((i) => ({
          start: i.start,
          end: i.end,
          prompt: i.prompt,
          region: i.region,
          allowImage: i.allowImage,
          assets: i.assets,
          narration: i.narration?.trim() || undefined,
          key: i.key,
          markerId: i.markerId,
        })),
        (e) => {
          if (e.event === 'done') {
            planRemaining = !!(e.data as { planRemaining?: boolean }).planRemaining;
            return;
          }
          const d = e.data as {
            index: number;
            markerId?: string;
            attempt?: number;
            phase?: string;
            error?: string;
            success?: boolean;
            cancelled?: boolean;
            removed?: boolean;
          };
          const target = approved[d.index];
          if (!target) return;

          if (e.event === 'item-voice') {
            notify('error', `The voiceover for one marker could not be generated (${d.error ?? 'unknown error'}). Select the marker to try again.`);
            return;
          }
          if (e.event === 'item-start') {
            // A fresh attempt replaces whatever an interrupted earlier one left for this item.
            setReviewItems((prev) => prev.map((it) => (it.key === target.key ? { ...it, markerId: undefined, error: undefined } : it)));
            return;
          }
          if (e.event === 'item-done' && d.cancelled) {
            const markerId = d.markerId;
            if (markerId) {
              setRunState((prev) => {
                const next = { ...prev };
                delete next[markerId];
                return next;
              });
            }
            if (d.removed) setReviewItems((prev) => prev.map((it) => (it.key === target.key ? { ...it, markerId: undefined } : it)));
            return;
          }

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
                log: [
                  ...(prev[markerId]?.log ?? []),
                  d.phase === 'voice' ? 'generating the voiceover' : `attempt ${d.attempt}: ${d.phase}${d.error ? ` — ${d.error}` : ''}`,
                ],
              },
            }));
          } else if (e.event === 'item-done') {
            if (d.markerId) {
              const markerId = d.markerId;
              setRunState((prev) => ({
                ...prev,
                [markerId]: { phase: 'done', log: prev[markerId]?.log ?? [], success: !!d.success, error: d.error },
              }));
              // Show each finished animation right away instead of after the whole batch.
              if (d.success) {
                refreshProject(projectId);
                setReloadToken((t) => t + 1);
              }
            } else {
              setReviewItems((prev) => prev.map((it) => (it.key === target.key ? { ...it, error: d.error } : it)));
            }
          }
        },
        abortRef.current.signal
      );
    } catch (err) {
      notify('error', `Generating the plan failed: ${describeError(err)}`);
      planRemaining = true;
    } finally {
      markStopping('apply', false);
      if (!abortRef.current.signal.aborted) {
        await refreshProject(projectId).catch(() => {});
        setReloadToken((t) => t + 1);
        setApplyingPlan(false);
        // Anything left to generate (stopped, skipped, failed) keeps the plan open, as the runner saved it.
        const { plan } = planRemaining ? await getPlan(projectId).catch(() => ({ plan: null })) : { plan: null };
        if (plan) openPlanReview(plan, false);
        else {
          setPlanReviewOpen(false);
          setPlanSource(null);
          savedPlanItemsRef.current = '';
        }
      }
    }
  };

  const handleCreateProject = async (name: string, opts: CreateProjectOptions) => {
    const project = await createProject(name, opts);
    setProjects((prev) => [...prev, project]);
    onProjectChange(project.id);
  };

  const handleDeleteProject = async () => {
    if (!projectId) return;
    const project = projects.find((p) => p.id === projectId);
    if (
      !window.confirm(
        `Delete "${project?.name ?? projectId}"? This permanently removes the video, markers, generated code and exported output.`
      )
    ) {
      return;
    }
    try {
      await deleteProject(projectId);
    } catch (err) {
      setExportStatus(`Delete failed — ${err instanceof Error ? err.message : String(err)}`);
      setExportSucceeded(false);
      return;
    }
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    onProjectChange(null);
    setSelectedMarkerId(null);
    setExportStatus(null);
    setExportSucceeded(false);
  };

  const handleAddMarker = async (input: {
    start: number;
    end: number;
    prompt: string;
    allowImage: boolean;
    assets: string[];
    narration?: { text: string; voice: string };
  }) => {
    if (!projectId) return;
    markEdited();
    const region = newMarkerRegion && !isFullScreenRegion(newMarkerRegion) ? newMarkerRegion : undefined;
    const { narration, ...markerInput } = input;
    const marker = await addMarker(projectId, { ...markerInput, region });
    // Saved before generating, so Claude designs the animation around the line.
    let withVoice = false;
    if (narration) {
      try {
        await saveMarkerNarration(projectId, marker.marker_id, narration.text, narration.voice);
        setProjectVoice(narration.voice);
        withVoice = true;
      } catch (err) {
        notify('error', `The voiceover line was not saved: ${describeError(err)}`);
      }
    }
    refreshProject(projectId);
    selectMarker(marker.marker_id);
    triggerRegenerate(marker.marker_id, input.prompt, input.allowImage);
    if (withVoice) {
      generateMarkerNarration(projectId, marker.marker_id)
        .then((after) => {
          if (after.end !== marker.end) setReloadToken((t) => t + 1);
        })
        .catch((err) => notify('error', `The voiceover could not be generated: ${describeError(err)}`))
        .finally(() => refreshProject(projectId).catch(() => {}));
    }
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
    setStaleRegionMarkers((prev) => {
      if (!prev.has(markerId)) return prev;
      const next = new Set(prev);
      next.delete(markerId);
      return next;
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

  // Markers visible at `seconds` whose region contains the point, smallest region first — so a
  // small callout on top of a full-screen marker is what a click lands on.
  const markersAt = (point: StagePoint, seconds: number) =>
    markers
      .filter((m) => {
        const r = m.region ?? FULL_SCREEN_REGION;
        return (
          seconds >= m.start &&
          seconds < m.end &&
          point.x >= r.x &&
          point.x <= r.x + r.width &&
          point.y >= r.y &&
          point.y <= r.y + r.height
        );
      })
      .sort((a, b) => {
        const ra = a.region ?? FULL_SCREEN_REGION;
        const rb = b.region ?? FULL_SCREEN_REGION;
        return ra.width * ra.height - rb.width * rb.height || a.start - b.start;
      });

  // Clicking a marker on the picture selects it and goes straight into area editing, since
  // pointing at it on the video is already the gesture of "this thing, here". Clicking again on
  // the same spot (after the edit auto-saves) cycles through overlapping markers.
  const handleStageMarkerClick = (point: StagePoint, seconds: number) => {
    const hits = markersAt(point, seconds);
    if (hits.length === 0) return false;
    const current = hits.findIndex((m) => m.marker_id === selectedMarkerId);
    const markerId = hits[(current + 1) % hits.length].marker_id;
    hidePlanningPanels();
    selectMarker(markerId);
    handleStartEditRegion(markerId);
    return true;
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
    setEditingIdeaRegion(false);
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
    const marker = markers.find((m) => m.marker_id === editingRegionMarkerId);
    const before = marker?.region ?? FULL_SCREEN_REGION;
    // Clicking a marker on the preview opens this editor, so clicking away untouched is common —
    // don't turn that into a save and an overlay reload.
    const unchanged = (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(before[k] - regionDraft[k]) <= 0.002);
    if (unchanged) {
      handleCancelEditRegion();
      return;
    }
    markEdited();
    // Only a size change (not a plain move) can break a layout designed for the old
    // regionWidth/regionHeight, so a reposition alone doesn't need to flag anything.
    const resized =
      Math.abs(before.width - regionDraft.width) > 0.002 || Math.abs(before.height - regionDraft.height) > 0.002;
    if (resized && marker?.status === 'ready') {
      setStaleRegionMarkers((prev) => new Set(prev).add(editingRegionMarkerId));
    }
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
    setEditingIdeaRegion(false);
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
      const uploaded = await uploadVideo(projectId, file);
      setVideoUrl(videoUrlFor(projectId));
      for (const warning of uploaded.warnings ?? []) notify('warn', warning);
    } catch (err) {
      notify('error', `The video could not be added. ${describeError(err)}`);
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

  const [exportProgress, setExportProgress] = useState<ExportStatus | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  const finishExport = (final: ExportStatus) => {
    if (final.state === 'done' && final.result) {
      const r = final.result;
      if (r.outputs) {
        const n = r.outputs.length;
        const v = r.voices?.length ?? 0;
        setExportStatus(
          `Export complete — ${n} marker clip${n === 1 ? '' : 's'}${v > 0 ? ` and ${v} voiceover file${v === 1 ? '' : 's'}` : ''} saved to ${r.outputDir}`
        );
        setExportedPath(r.outputs[0]?.file ?? r.outputDir ?? null);
      } else {
        setExportStatus(`Export complete — saved to ${r.output}${r.narration ? `, voiceover track to ${r.narration}` : ''}`);
        setExportedPath(r.output ?? null);
      }
      setExportSucceeded(true);
    } else if (final.state === 'cancelled') {
      setExportStatus('Export cancelled');
    } else {
      setExportStatus(`Export failed — ${final.message}`);
      if (final.error) console.error('Export failed:', final.error);
    }
  };

  const handleExport = async (includeVideo: boolean, resume = false) => {
    if (!projectId) return;
    const perMarker = !includeVideo && splitByMarker;
    setExporting(true);
    setExportSucceeded(false);
    setExportedPath(null);
    setExportStatus(includeVideo ? 'Exporting MP4 with video…' : perMarker ? 'Exporting one clip per marker…' : 'Exporting overlay…');
    try {
      const final = await exportProject(projectId, includeVideo, perMarker, setExportProgress, resume);
      finishExport(final);
    } catch (err) {
      setExportStatus(describeError(err));
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  const handleCancelExport = () => {
    if (projectId) void cancelExport(projectId);
  };

  // An export keeps running in the engine if the editor reloads; pick it back up.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getExportStatus(projectId)
      .then((s) => {
        if (!cancelled && s.state === 'running') void handleExport(false, true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // The desktop app's Help menu can open the requirements panel.
  useEffect(() => desktop()?.onOpenStatus(() => setStatusOpen(true)), []);

  // First launch of the desktop app: show what is missing (Claude CLI, OpenAI key) right away.
  useEffect(() => {
    if (!desktop() || !status.report) return;
    try {
      if (localStorage.getItem('mango.onboarded')) return;
      localStorage.setItem('mango.onboarded', '1');
    } catch {
      return;
    }
    if (status.report.overall !== 'ok') setStatusOpen(true);
  }, [status.report]);

  const selectedMarker = markers.find((m) => m.marker_id === selectedMarkerId) ?? null;

  // The voiceover the preview plays: each marker's current take, from the marker's start.
  const voiceClips = projectId
    ? markers.flatMap((m) => {
        const audio = playableNarration(m);
        return audio ? [{ id: `${m.marker_id}:${audio.file}`, url: narrationUrl(projectId, audio.file), start: m.start, duration: audio.durationSec }] : [];
      })
    : [];
  const durationSeconds = composition.durationInFrames / composition.fps;

  // Only one region overlay is ever active: the new-marker draft takes priority (it has
  // no server-backed marker to fall back to), then a proposed marker being reviewed
  // (also unsaved), otherwise whichever existing marker is being edited.
  const activeRegionDraft = editingNewMarkerRegion
    ? newMarkerRegion ?? FULL_SCREEN_REGION
    : editingIdeaRegion
    ? ideaRegion ?? FULL_SCREEN_REGION
    : editingPlanItemKey
    ? reviewItems.find((i) => (editingPlanItemKey === ALL_AREAS_KEY ? isBulkAreaTarget(i) : i.key === editingPlanItemKey))?.region ??
      FULL_SCREEN_REGION
    : editingRegionMarkerId
    ? regionDraft
    : null;
  const handleRegionDraftChange = (region: MarkerRegion) => {
    if (editingNewMarkerRegion) setNewMarkerRegion(region);
    else if (editingIdeaRegion) setIdeaRegion(region);
    else if (editingPlanItemKey) handleReviewItemChange(editingPlanItemKey, { region: isFullScreenRegion(region) ? null : region });
    else setRegionDraft(region);
  };

  return (
    <div className="app">
      <ConnectionBanner />
      <NoticeStack />
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">🥭</span>
          MangoAI
        </div>
        <select className="field-select" style={{ width: 200 }} value={projectId ?? ''} onChange={(e) => onProjectChange(e.target.value || null)}>
          <option value="">Select a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => setCreateModalOpen(true)}>
          New project
        </button>
        <div className="topbar-spacer" />
        <StatusButton state={status.state} onClick={() => setStatusOpen(true)} />
        {projectId && (
          <>
            {baseLayer.type === 'video' && (
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
            )}
            {baseLayer.type !== 'video' && (
              <label
                className="volume-control"
                title="Length of the composition. There's no source video to derive this from, so set it directly."
              >
                <span>Duration (s)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={Math.round(durationSeconds)}
                  onChange={(e) => {
                    const seconds = Number(e.target.value);
                    if (!Number.isFinite(seconds) || seconds <= 0) return;
                    handleDurationChange(Math.round(seconds * composition.fps));
                  }}
                  style={{ width: 56 }}
                />
              </label>
            )}
            <button
              onClick={() => setLibraryOpen(true)}
              className="btn btn-sm"
              title="Upload images and attach them to markers as context for the animations"
            >
              Images{assets.length > 0 ? ` (${assets.length})` : ''}
            </button>
            <button onClick={handleTranscribe} disabled={transcribing} className="btn btn-sm">
              {transcribing ? 'Transcribing…' : transcript.length > 0 ? 'Re-transcribe' : 'Transcribe video'}
            </button>
            {transcript.length > 0 && (
              <button onClick={() => setTranscriptPanelOpen(true)} className="btn btn-sm" title="View or edit the transcript text">
                View transcript
              </button>
            )}
            <button
              onClick={() => {
                selectMarker(null);
                setNewMarkerPanelVisible(false);
                setPlanError(null);
                setPlanPanelOpen(true);
              }}
              disabled={transcript.length === 0 || planning}
              className="btn btn-sm"
              title={transcript.length === 0 ? 'Transcribe the video first' : 'Have Claude propose markers from the transcript'}
            >
              {planning ? 'Planning…' : 'Plan markers'}
            </button>
            {planning && (
              <button
                onClick={() => requestStop('plan')}
                disabled={stopping.has('plan')}
                className="btn btn-sm btn-danger"
                title="Stop Claude and throw this plan away"
              >
                {stopping.has('plan') ? 'Stopping…' : 'Stop planning'}
              </button>
            )}
            <button
              onClick={() => {
                selectMarker(null);
                setNewMarkerPanelVisible(false);
                setPlanError(null);
                setPlanPanelOpen(false);
                setIdeaPanelOpen(true);
              }}
              disabled={planning}
              className="btn btn-sm"
              title="Describe an idea and have Claude design a full sequence of markers to cover the video"
            >
              Design from idea
            </button>
            <label
              className="volume-control"
              title="Volume of the sounds played by overlay animations. Drag to 0 to mute them. Applies to the preview and to the export."
            >
              <span>Animation sound</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(overlayVolume * 100)}
                onChange={(e) => setOverlayVolume(Number(e.target.value) / 100)}
              />
              <span className="volume-value">{overlayVolume === 0 ? 'Muted' : `${Math.round(overlayVolume * 100)}%`}</span>
            </label>
            {markers.some((m) => m.narration) && (
              <label
                className="volume-control"
                title="Volume of the markers' voiceover. Drag to 0 to mute it. Applies to the preview and to the export."
              >
                <span>Voice</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(voiceVolume * 100)}
                  onChange={(e) => setVoiceVolume(Number(e.target.value) / 100)}
                />
                <span className="volume-value">{voiceVolume === 0 ? 'Muted' : `${Math.round(voiceVolume * 100)}%`}</span>
              </label>
            )}
            <label
              className="volume-control"
              title="Export each marker's animation as its own file instead of one file spanning the whole timeline — lighter, and easier to drop individual clips into another editor."
            >
              <input type="checkbox" checked={splitByMarker} onChange={(e) => setSplitByMarker(e.target.checked)} />
              <span>Split by marker</span>
            </label>
            <button
              onClick={() => handleExport(false)}
              disabled={exporting}
              className="btn btn-sm"
              title={splitByMarker ? 'One transparent .webm per marker' : 'Transparent overlay only (.webm)'}
            >
              {splitByMarker ? 'Export overlay (by marker)' : 'Export overlay'}
            </button>
            {baseLayer.type !== 'transparent' && (
              <button
                onClick={() => handleExport(true)}
                disabled={exporting}
                className="btn btn-primary"
                title="Base + overlay mixed (.mp4)"
              >
                {exporting ? 'Exporting…' : 'Export MP4 (video + overlay)'}
              </button>
            )}
            <button
              onClick={handleDeleteProject}
              disabled={exporting}
              className="btn btn-sm"
              style={{ color: 'var(--error)' }}
              title="Delete this project and all its files, including exported output"
            >
              Delete project
            </button>
          </>
        )}
      </div>
      {createModalOpen && (
        <CreateProjectModal onClose={() => setCreateModalOpen(false)} onCreate={handleCreateProject} />
      )}
      {statusOpen && (
        <StatusDashboard
          report={status.report}
          error={status.error}
          loading={status.loading}
          onRefresh={status.refresh}
          onClose={() => setStatusOpen(false)}
        />
      )}
      {transcribeError && (
        <div style={{ padding: '0 24px', fontSize: 13, color: 'var(--error)' }}>{transcribeError}</div>
      )}
      {planError && <div style={{ padding: '0 24px', fontSize: 13, color: 'var(--error)' }}>{planError}</div>}

      <div className="workspace">
        <div className="stage-column">
          {exporting && exportProgress && (
            <div className="export-progress">
              <div className="export-progress-bar">
                <div className="export-progress-fill" style={{ width: `${exportProgress.percent}%` }} />
              </div>
              <span>
                {exportProgress.message || 'Exporting'} — {exportProgress.percent}%
              </span>
              <button type="button" className="btn btn-sm" onClick={handleCancelExport}>
                Cancel export
              </button>
            </div>
          )}
          {exportStatus && !(exporting && exportProgress) && (
            <div style={{ fontSize: 13, color: exportSucceeded ? 'var(--ready)' : 'var(--text-muted)', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span>{exportStatus}</span>
              {exportSucceeded && exportedPath && desktop() && (
                <button type="button" className="btn btn-sm" onClick={() => void desktop()?.showInFolder(exportedPath)}>
                  Show in folder
                </button>
              )}
            </div>
          )}

          {projectId ? (
            <>
              <DualLayerPreview
                ref={previewRef}
                projectId={projectId}
                videoUrl={videoUrl}
                baseLayer={baseLayer}
                reloadToken={reloadToken}
                fps={composition.fps}
                compositionWidth={composition.width}
                compositionHeight={composition.height}
                initialDurationInFrames={composition.durationInFrames}
                onDurationChange={handleDurationChange}
                onVideoSize={handleVideoSize}
                onTimeUpdate={setCurrentTime}
                onPlayingChange={setIsPlaying}
                overlayVolume={overlayVolume}
                voiceClips={voiceClips}
                voiceVolume={voiceVolume}
                regionDraft={activeRegionDraft}
                onRegionDraftChange={handleRegionDraftChange}
                onRegionCommit={editingRegionMarkerId ? handleSaveRegion : undefined}
                hasMarkerAt={(point, seconds) => markersAt(point, seconds).length > 0}
                onMarkerClick={handleStageMarkerClick}
              />
              <Timeline
                markers={markers}
                durationSeconds={durationSeconds}
                currentTime={currentTime}
                selectedId={selectedMarkerId}
                runState={runState}
                pendingStart={pendingStart}
                pendingEnd={pendingEnd}
                pendingVisible={newMarkerPanelVisible}
                isPlaying={isPlaying}
                onPlayPause={handlePlayPause}
                onStop={handleStop}
                onSeek={handleSeek}
                onSelect={(markerId) => {
                  hidePlanningPanels();
                  selectMarker(markerId);
                }}
                onDeselectAll={handleTimelineDeselect}
                onRangeSelect={(start, end) => {
                  // Starting a new pending range is the user saying "I'm making a new
                  // marker" — keeping the old one selected would leave the inspector's
                  // (and its Animation area) showing a different marker than the one
                  // about to be created, which reads as if it applies to the new one.
                  hidePlanningPanels();
                  selectMarker(null);
                  setNewMarkerPanelVisible(true);
                  setPendingStart(start);
                  setPendingEnd(end);
                }}
                onMarkerTimingChange={handleMarkerTimingChange}
                onEditRegion={(markerId) => {
                  hidePlanningPanels();
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
              projectId={projectId}
              assets={assets}
              markers={markers}
              onUploadAssets={handleUploadAssets}
              items={reviewItems}
              source={planSource}
              droppedCount={droppedCount}
              interrupted={planInterrupted}
              applying={applyingPlan}
              stopping={stopping.has('apply')}
              runState={runState}
              onChange={handleReviewItemChange}
              onRemove={handleReviewItemRemove}
              onDiscard={handleCancelPlanReview}
              onApply={handleApplyPlan}
              onStop={() => requestStop('apply')}
              editingRegionKey={editingPlanItemKey}
              onStartEditRegion={handleStartEditPlanItemRegion}
              onDoneEditRegion={handleDoneEditPlanItemRegion}
              onResetRegion={handleResetPlanItemRegion}
            />
          )}
          {projectId && !planReviewOpen && !selectedMarker && planPanelOpen && (
            <PlanMarkersPanel
              planning={planning}
              stopping={stopping.has('plan')}
              error={planError}
              initial={interruptedPlanning?.kind === 'transcript' ? interruptedPlanning.context : undefined}
              notice={interruptedPlanningNotice}
              onStop={() => requestStop('plan')}
              onSubmit={handlePlanMarkers}
              onCancel={() =>
                handleClosePlanPanel(() => {
                  setPlanPanelOpen(false);
                  setNewMarkerPanelVisible(true);
                })
              }
            />
          )}
          {projectId && !planReviewOpen && !selectedMarker && ideaPanelOpen && (
            <IdeaPlanPanel
              planning={planning}
              stopping={stopping.has('plan')}
              error={planError}
              idea={ideaDraft}
              onIdeaChange={setIdeaDraft}
              notice={interruptedPlanningNotice}
              region={ideaRegion}
              editingRegion={editingIdeaRegion}
              onStartEditRegion={handleStartEditIdeaRegion}
              onDoneEditRegion={() => setEditingIdeaRegion(false)}
              onResetRegion={() => setIdeaRegion(null)}
              narration={ideaNarrationOn}
              onNarrationChange={setIdeaNarration}
              onStop={() => requestStop('plan')}
              onSubmit={handlePlanFromIdea}
              onCancel={() =>
                handleClosePlanPanel(() => {
                  closeIdeaPanel();
                  setNewMarkerPanelVisible(true);
                })
              }
            />
          )}
          {projectId && !planReviewOpen && !selectedMarker && !ideaPanelOpen && !planPanelOpen && newMarkerPanelVisible && (
            <AddMarkerPanel
              projectId={projectId}
              assets={assets}
              onUploadAssets={handleUploadAssets}
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
              voices={voices}
              defaultVoice={defaultVoice}
            />
          )}
          {projectId && !planReviewOpen && selectedMarker && (
            <MarkerInspector
              projectId={projectId}
              assets={assets}
              onUploadAssets={handleUploadAssets}
              onSetAssets={handleSetMarkerAssets}
              marker={selectedMarker}
              run={selectedMarker ? runState[selectedMarker.marker_id] : undefined}
              transcript={
                selectedMarker
                  ? transcript.filter((s) => s.start < selectedMarker.end && s.end > selectedMarker.start)
                  : []
              }
              onRegenerate={triggerRegenerate}
              onStop={(markerId) => requestStop(`regenerate:${markerId}`)}
              stopping={stopping.has(`regenerate:${selectedMarker.marker_id}`)}
              onDelete={handleDeleteMarker}
              regionStale={staleRegionMarkers.has(selectedMarker.marker_id)}
              regionEditing={editingRegionMarkerId === selectedMarker?.marker_id}
              regionDraft={editingRegionMarkerId === selectedMarker?.marker_id ? regionDraft : null}
              onStartEditRegion={handleStartEditRegion}
              onCancelEditRegion={handleCancelEditRegion}
              onResetRegionDraft={handleResetRegionDraft}
              onSaveRegion={handleSaveRegion}
              voices={voices}
              defaultVoice={defaultVoice}
              onGenerateVoice={handleGenerateVoice}
            />
          )}
        </div>
      </div>
      {transcriptPanelOpen && projectId && (
        <TranscriptPanel
          segments={transcript}
          onSave={handleSaveTranscript}
          onClose={() => setTranscriptPanelOpen(false)}
          onSeek={handleSeek}
        />
      )}
      {libraryOpen && projectId && (
        <AssetLibrary
          projectId={projectId}
          assets={assets}
          onUpload={handleUploadAssets}
          autoDescribe={autoDescribe}
          onToggleAutoDescribe={handleToggleAutoDescribe}
          describingIds={describingIds}
          onDescribe={handleDescribeAsset}
          onChanged={() => {
            refreshAssets(projectId);
            refreshProject(projectId);
          }}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </div>
  );
}
