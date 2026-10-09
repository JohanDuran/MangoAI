import { Router, type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { isExporting } from './exportJob.js';
import { projectDir, markerFile, PROJECTS_ROOT } from '../lib/paths.js';
import {
  createProject,
  listProjects,
  readProject,
  addMarker,
  setProjectSkills,
  enabledSkillNames,
  overlayVolume,
  setOverlayVolume,
  baseLayerOf,
  updateProjectSettings,
} from '../lib/scaffold.js';
import {
  TTS_VOICES,
  DEFAULT_VOICE,
  MAX_NARRATION_CHARS,
  isValidVoice,
  setMarkerNarration,
  generateNarration,
  minMarkerSeconds,
  VOICE_TAIL_SEC,
  removeNarrationFiles,
  narrationFilePath,
  voiceSample,
} from '../lib/narration.js';
import { isValidBaseLayer } from '../lib/baseLayer.js';
import { discoverSkills } from '../lib/skills.js';
import { log as writeLog, clip } from '../lib/log.js';
import {
  readMarkers,
  findMarker,
  updateMarkerTiming,
  updateMarkerRegion,
  deleteMarker,
  isValidRegion,
  setMarkerAssets,
  type MarkerRegion,
} from '../lib/markers.js';
import { validAssetIds } from '../lib/assets.js';
import { syncAssetModule } from '../lib/assetModule.js';
import { regenerateRegistry } from '../lib/registry.js';
import { generateMarkerWithRetry } from '../lib/generateMarker.js';
import { maxParallelRuns } from '../lib/claude.js';
import { planMarkers, planMarkersFromIdea, type PlanMarkersResult } from '../lib/planner.js';
import { startJob, stopJobs, runningJobs, type JobTag } from '../lib/jobs.js';
import {
  readPlan,
  clearPlan,
  startPlanning,
  savePlanProposals,
  savePlanItems,
  setPlanState,
  updatePlanItem,
  type PlanSource,
} from '../lib/planStore.js';
import { findRawVideo } from '../lib/video.js';
import { readCompositionConfig } from '../lib/composition.js';
import { captionCues, captionSettings, isValidCaptionSettings, toSrt } from '../lib/captions.js';
import { transcribeProject, readTranscript, writeTranscript, transcriptForRange, type TranscriptSegment } from '../lib/transcript.js';

export const projectsRouter = Router();

// A project built on a video takes its length and canvas size from that video, so nothing is
// designed or generated for it before the video exists: markers would be timed and laid out
// against placeholder values.
export const videoMissing = (id: string) => !!readProject(id) && baseLayerOf(id).type === 'video' && !findRawVideo(id);

const requireVideo: RequestHandler = (req, res, next) => {
  if (videoMissing(req.params.id)) {
    res.status(409).json({ error: 'Upload the video first: markers are timed and sized to it.', code: 'video-missing' });
    return;
  }
  next();
};

const toNameList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

projectsRouter.post('/projects', (req, res) => {
  const { name, baseLayer, fps, width, height, durationInFrames } = req.body as {
    name?: string;
    baseLayer?: unknown;
    fps?: number;
    width?: number;
    height?: number;
    durationInFrames?: number;
  };
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (baseLayer !== undefined && !isValidBaseLayer(baseLayer)) {
    return res.status(400).json({ error: 'invalid baseLayer' });
  }
  res.status(201).json(createProject(name, { baseLayer, fps, width, height, durationInFrames }));
});

projectsRouter.get('/projects', (_req, res) => {
  res.json(listProjects());
});

projectsRouter.get('/projects/:id', (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  syncAssetModule(req.params.id);
  res.json({
    project,
    markers: readMarkers(req.params.id),
    hasVideo: findRawVideo(req.params.id) !== null,
    composition: readCompositionConfig(req.params.id),
    baseLayer: baseLayerOf(req.params.id),
  });
});

// Everything a project owns (source video, transcript, assets, generated code, debug
// history, exports) lives under its own directory, so removing that directory is a
// complete cleanup.
projectsRouter.delete('/projects/:id', (req, res) => {
  const { id } = req.params;
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  if (isExporting(id)) {
    return res.status(409).json({ error: 'An export is running for this project; wait for it to finish' });
  }
  const dir = path.resolve(projectDir(id));
  if (path.dirname(dir) !== path.resolve(PROJECTS_ROOT)) {
    return res.status(400).json({ error: 'invalid project id' });
  }
  stopJobs(id);
  try {
    // Retries cover Windows briefly holding handles on just-used media files.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
  res.status(204).end();
});

// Volume of the sounds played by overlay animations: 0 (muted) to 1. Used by the export.
projectsRouter.put('/projects/:id/overlay-volume', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  const volume = (req.body as { volume?: unknown }).volume;
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
    return res.status(400).json({ error: 'volume must be a number from 0 to 1' });
  }
  setOverlayVolume(req.params.id, volume);
  res.json({ volume });
});

// Volume of the markers' voiceover: 0 (muted) to 1. Used by the preview and the export.
projectsRouter.put('/projects/:id/voice-volume', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  const volume = (req.body as { volume?: unknown }).volume;
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
    return res.status(400).json({ error: 'volume must be a number from 0 to 1' });
  }
  updateProjectSettings(req.params.id, { voiceVolume: volume });
  res.json({ volume });
});

projectsRouter.get('/projects/:id/captions', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  const settings = captionSettings(req.params.id);
  // Shown even while captions are off, so the dialog can preview what turning them on gives.
  res.json({ settings, cues: captionCues(req.params.id, { ...settings, mode: 'srt' }) });
});

projectsRouter.put('/projects/:id/captions', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  const settings = (req.body as { settings?: unknown }).settings;
  if (!isValidCaptionSettings(settings)) return res.status(400).json({ error: 'invalid caption settings' });
  const clean = { mode: settings.mode, source: settings.source, position: settings.position, size: settings.size };
  updateProjectSettings(req.params.id, { captions: clean });
  regenerateRegistry(req.params.id);
  res.json({ settings: clean, cues: captionCues(req.params.id, { ...clean, mode: 'srt' }) });
});

projectsRouter.get('/projects/:id/captions.srt', (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const cues = captionCues(req.params.id, { ...captionSettings(req.params.id), mode: 'srt' });
  const name = `${project.name.replace(/[^\w .-]+/g, '').trim() || 'captions'}.srt`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.type('application/x-subrip').send(toSrt(cues));
});

projectsRouter.get('/voices', (_req, res) => {
  res.json({ voices: TTS_VOICES, defaultVoice: DEFAULT_VOICE, maxChars: MAX_NARRATION_CHARS });
});

// A short sample of a voice. The first listen to each voice is one small OpenAI request; it is
// kept, so later listens cost nothing.
projectsRouter.get('/voices/:voice/sample', async (req, res) => {
  if (!isValidVoice(req.params.voice)) return res.status(404).json({ error: 'not found' });
  try {
    const file = await voiceSample(req.params.voice);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type('audio/mpeg').sendFile(file);
  } catch (err) {
    writeLog('error', 'route.error', { route: 'voice-sample', voice: req.params.voice, error: err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Saves a marker's voiceover line and voice (an empty line removes it). The voice becomes the
// project's choice for new lines. Generating the speech is a separate call, since it costs money.
projectsRouter.put('/projects/:id/markers/:markerId/narration', (req, res) => {
  const { id, markerId } = req.params;
  if (!readMarkers(id).some((m) => m.marker_id === markerId)) return res.status(404).json({ error: 'not found' });
  const { text, voice } = req.body as { text?: unknown; voice?: unknown };
  if (typeof text !== 'string') return res.status(400).json({ error: 'text must be a string' });
  if (!isValidVoice(voice)) return res.status(400).json({ error: `voice must be one of: ${TTS_VOICES.join(', ')}` });
  if (text.trim().length > MAX_NARRATION_CHARS) return res.status(400).json({ error: `text must be at most ${MAX_NARRATION_CHARS} characters` });
  updateProjectSettings(id, { voice });
  res.json(setMarkerNarration(id, markerId, { text, voice }));
});

projectsRouter.post('/projects/:id/markers/:markerId/narration/generate', async (req, res) => {
  const { id, markerId } = req.params;
  if (!readMarkers(id).some((m) => m.marker_id === markerId)) return res.status(404).json({ error: 'not found' });
  try {
    const { marker } = await generateNarration(id, markerId);
    // A new take can retime markers and changes the voiceover captions.
    regenerateRegistry(id);
    res.json(marker);
  } catch (err) {
    // The marker may have been deleted while the speech was being made.
    if (!readMarkers(id).some((m) => m.marker_id === markerId)) removeNarrationFiles(id, markerId);
    writeLog('error', 'route.error', { route: 'narration', project: id, marker: markerId, error: err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

projectsRouter.get('/projects/:id/voice/:file', (req, res) => {
  const file = narrationFilePath(req.params.id, req.params.file);
  if (!file) return res.status(404).json({ error: 'not found' });
  // A take's name includes a hash of its words and voice, so its content never changes.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('audio/mpeg').sendFile(file);
});

projectsRouter.get('/skills', (_req, res) => {
  const { skills, problems } = discoverSkills();
  res.json({
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      origin: s.origin,
      optIn: s.manifest.optIn ?? false,
      hasTools: !!s.manifest.mcp,
      env: s.manifest.env ?? [],
      missingEnv: s.missingEnv,
    })),
    problems,
  });
});

projectsRouter.get('/projects/:id/skills', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ enabled: enabledSkillNames(req.params.id) });
});

// Enabling a skill is the trust decision: external skills run local code and are never on by default.
projectsRouter.put('/projects/:id/skills', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  const enabled = (req.body as { enabled?: unknown }).enabled;
  if (!Array.isArray(enabled) || enabled.some((n) => typeof n !== 'string')) {
    return res.status(400).json({ error: 'enabled must be a list of skill names' });
  }
  const known = new Set(discoverSkills().skills.map((s) => s.name));
  const unknown = (enabled as string[]).filter((n) => !known.has(n));
  if (unknown.length > 0) return res.status(400).json({ error: `unknown skills: ${unknown.join(', ')}` });
  res.json({ enabled: setProjectSkills(req.params.id, [...new Set(enabled as string[])]).skills });
});

projectsRouter.post('/projects/:id/markers', requireVideo, (req, res) => {
  const { start, end, prompt, region, assets } = req.body as { start?: number; end?: number; prompt?: string; region?: unknown; assets?: unknown };
  if (start === undefined || end === undefined || !prompt) {
    return res.status(400).json({ error: 'start, end, and prompt are required' });
  }
  if (region !== undefined && region !== null && !isValidRegion(region)) {
    return res.status(400).json({ error: 'region must be null or {x,y,width,height} normalized within 0-1 of the canvas' });
  }
  res.status(201).json(
    addMarker(req.params.id, { start, end, prompt, region: (region ?? undefined) as MarkerRegion | undefined, assets: validAssetIds(req.params.id, assets) })
  );
});

projectsRouter.patch('/projects/:id/markers/:markerId', (req, res) => {
  const { id, markerId } = req.params;
  const { start, end } = req.body as { start?: number; end?: number };
  if (start === undefined || end === undefined || end <= start) {
    return res.status(400).json({ error: 'start and end are required, and end must be after start' });
  }
  // A voice is never cut, so a marker cannot be made shorter than its speech.
  const existing = readMarkers(id).find((m) => m.marker_id === markerId);
  const min = existing ? minMarkerSeconds(id, existing) : 0;
  if (end - start < min - 0.001) {
    return res.status(400).json({ error: `This marker's voiceover is ${(min - VOICE_TAIL_SEC).toFixed(1)}s long, so the marker cannot be shorter than ${min.toFixed(1)}s. Shorten the line first.` });
  }
  const marker = updateMarkerTiming(id, markerId, { start, end });
  regenerateRegistry(id);
  res.json(marker);
});

projectsRouter.delete('/projects/:id/markers/:markerId', (req, res) => {
  const { id, markerId } = req.params;
  try {
    deleteMarker(id, markerId);
  } catch (err) {
    return res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
  const file = markerFile(id, markerId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  removeNarrationFiles(id, markerId);
  regenerateRegistry(id);
  res.status(204).end();
});

// Replaces the set of library images attached to a marker. Takes effect the next time the
// marker is generated; the marker's existing code is left as is.
projectsRouter.put('/projects/:id/markers/:markerId/assets', (req, res) => {
  const { id, markerId } = req.params;
  if (!readMarkers(id).some((m) => m.marker_id === markerId)) return res.status(404).json({ error: 'not found' });
  const assets = (req.body as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return res.status(400).json({ error: 'assets must be a list of asset ids' });
  res.json(setMarkerAssets(id, markerId, validAssetIds(id, assets)));
});

projectsRouter.patch('/projects/:id/markers/:markerId/region', (req, res) => {
  const { region } = req.body as { region?: unknown };
  if (region !== null && region !== undefined && !isValidRegion(region)) {
    return res.status(400).json({ error: 'region must be null or {x,y,width,height} normalized within 0-1 of the canvas' });
  }
  const marker = updateMarkerRegion(req.params.id, req.params.markerId, region ?? null);
  regenerateRegistry(req.params.id);
  res.json(marker);
});

projectsRouter.post('/projects/:id/transcript', async (req, res) => {
  try {
    const segments = await transcribeProject(req.params.id);
    regenerateRegistry(req.params.id); // transcript captions
    res.json({ segments });
  } catch (err) {
    writeLog('error', 'route.error', { route: 'transcribe', project: req.params.id, error: err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

projectsRouter.get('/projects/:id/transcript', (req, res) => {
  res.json({ segments: readTranscript(req.params.id) });
});

const isValidSegment = (s: unknown): s is TranscriptSegment =>
  !!s &&
  typeof s === 'object' &&
  typeof (s as TranscriptSegment).start === 'number' &&
  typeof (s as TranscriptSegment).end === 'number' &&
  typeof (s as TranscriptSegment).text === 'string';

// Lets the editor save manual corrections to the transcript text (e.g. a misheard word) —
// the planner and per-marker "said in the video" context both read from this file.
projectsRouter.put('/projects/:id/transcript', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  const segments = (req.body as { segments?: unknown }).segments;
  if (!Array.isArray(segments) || !segments.every(isValidSegment)) {
    return res.status(400).json({ error: 'segments must be a list of {start, end, text}' });
  }
  writeTranscript(req.params.id, segments);
  regenerateRegistry(req.params.id); // transcript captions
  res.json({ segments });
});

// Plans are written to the project's plan file as they go (see planStore.ts). Stopping throws the
// plan away; the editor going away mid-plan leaves it marked as planning so it can be retried.
async function runPlan(
  id: string,
  source: PlanSource,
  res: import('express').Response,
  plan: (signal: AbortSignal) => Promise<PlanMarkersResult>
): Promise<void> {
  if (!readProject(id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const job = startJob(id, 'plan', res);
  startPlanning(id, source);
  try {
    const result = await plan(job.signal);
    res.json({ ...result, plan: savePlanProposals(id, source, result.proposals, result.droppedCount) });
  } catch (err) {
    if (job.stoppedByUser()) {
      clearPlan(id);
      if (!res.headersSent) res.status(499).json({ error: 'Stopped.', cancelled: true });
      return;
    }
    if (!job.signal.aborted) clearPlan(id);
    writeLog('error', 'route.error', { route: `plan-${source.kind}`, project: id, error: err });
    if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    job.finish();
  }
}

projectsRouter.post('/projects/:id/markers/plan', requireVideo, async (req, res) => {
  const { context } = req.body as { context?: unknown };
  const trimmed = typeof context === 'string' && context.trim() ? context.trim() : undefined;
  await runPlan(req.params.id, { kind: 'transcript', context: trimmed }, res, (signal) => planMarkers(req.params.id, trimmed, signal));
});

projectsRouter.post('/projects/:id/markers/plan-from-idea', requireVideo, async (req, res) => {
  const { idea, region, narration } = req.body as { idea?: unknown; region?: unknown; narration?: unknown };
  if (typeof idea !== 'string' || !idea.trim()) {
    return res.status(400).json({ error: 'idea must be a non-empty string' });
  }
  if (region !== undefined && region !== null && !isValidRegion(region)) {
    return res.status(400).json({ error: 'region must be { x, y, width, height } as fractions of the canvas' });
  }
  const area = region ?? undefined;
  const withNarration = narration === true;
  await runPlan(req.params.id, { kind: 'idea', idea: idea.trim(), ...(area && { region: area }), ...(withNarration && { narration: true }) }, res, (signal) =>
    planMarkersFromIdea(req.params.id, idea, { region: area, narration: withNarration }, signal)
  );
});

// The saved plan, if any, and which Claude work is running for the project right now. A plan still
// in "planning" or "applying" with nothing of that kind running was interrupted.
projectsRouter.get('/projects/:id/plan', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ plan: readPlan(req.params.id), running: runningJobs(req.params.id) });
});

// Saves the edits made while reviewing the plan.
projectsRouter.put('/projects/:id/plan', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const plan = savePlanItems(req.params.id, (req.body as { items?: unknown }).items);
    if (!plan) return res.status(404).json({ error: 'no plan' });
    res.json({ plan });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

projectsRouter.delete('/projects/:id/plan', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  stopJobs(req.params.id, 'plan');
  clearPlan(req.params.id);
  res.status(204).end();
});

// Stops Claude work for the project: one kind (plan, apply, regenerate:<markerId>) or all of it.
projectsRouter.post('/projects/:id/stop', (req, res) => {
  const tag = (req.body as { tag?: unknown } | undefined)?.tag;
  if (tag !== undefined && (typeof tag !== 'string' || !/^(plan|apply|regenerate:[\w-]+)$/.test(tag))) {
    return res.status(400).json({ error: 'invalid tag' });
  }
  res.json({ stopped: stopJobs(req.params.id, tag as JobTag | undefined) });
});

interface ApplyMarkerInput {
  start?: number;
  end?: number;
  prompt?: string;
  region?: MarkerRegion | null;
  allowSkills?: string[];
  assets?: string[];
  // A voiceover line to speak from the marker's start.
  narration?: string;
  // The saved plan item this came from, so progress is recorded in the plan file.
  key?: string;
  // A marker an interrupted earlier apply created for this item but never finished.
  markerId?: string;
}

// Removes a marker and its code; used for markers an apply created but did not finish.
function discardMarker(id: string, markerId: string): void {
  try {
    deleteMarker(id, markerId);
  } catch {
    // already gone
  }
  fs.rmSync(markerFile(id, markerId), { force: true });
  removeNarrationFiles(id, markerId);
}

// Whether the saved plan still has items to generate. A plan with none left is done and removed.
function settlePlan(id: string): boolean {
  const plan = readPlan(id);
  if (!plan) return false;
  const markers = readMarkers(id);
  const remaining = plan.items.some((i) => {
    if (!i.included) return false;
    const marker = i.markerId ? markers.find((m) => m.marker_id === i.markerId) : undefined;
    return !marker || marker.status === 'draft';
  });
  if (remaining) setPlanState(id, 'review');
  else clearPlan(id);
  return remaining;
}

projectsRouter.post('/projects/:id/markers/apply', requireVideo, async (req, res) => {
  const { id } = req.params;
  const inputs = (req.body.markers ?? []) as ApplyMarkerInput[];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const results: { markerId?: string; success: boolean }[] = [];
  const job = startJob(id, 'apply', res);
  const signal = job.signal;
  if (readPlan(id)) setPlanState(id, 'applying');

  try {
    const { fps, durationInFrames } = readCompositionConfig(id);
    const durationSeconds = durationInFrames / fps;

    // Two passes. First, in order, every item is checked, created and voiced: that is quick, and the
    // timing has to settle in order, since a voice longer than its planned marker lengthens it and
    // moves every later marker back by as much (see narration.ts) — the plan items still to be made
    // move back by the same total. Then the slow part, Claude writing the animations, runs for
    // several markers at once (see withProjectLock).
    const created: { index: number; input: ApplyMarkerInput; markerId: string; narration: string }[] = [];
    let shift = 0;
    for (let index = 0; index < inputs.length; index++) {
      if (signal.aborted) break;
      const input = inputs[index];
      send('item-start', { index, total: inputs.length });
      if (shift > 0 && typeof input.start === 'number' && typeof input.end === 'number') {
        input.start = Math.round((input.start + shift) * 100) / 100;
        input.end = Math.round((input.end + shift) * 100) / 100;
      }

      // Left behind by an apply that was interrupted: start the item over from a clean marker.
      if (input.markerId) {
        const leftover = readMarkers(id).find((m) => m.marker_id === input.markerId);
        if (leftover && leftover.status === 'draft') discardMarker(id, leftover.marker_id);
        updatePlanItem(id, input.key, { markerId: undefined });
      }

      const { start, end, prompt } = input;
      const region = input.region ?? null;
      const validTiming =
        typeof start === 'number' && typeof end === 'number' && start >= 0 && end > start && end <= durationSeconds + 0.001;
      const validRegion = region === null || isValidRegion(region);
      const validPrompt = typeof prompt === 'string' && prompt.trim().length > 0;
      const overlapsExisting =
        validTiming && readMarkers(id).some((m) => start! < m.end && end! > m.start);

      if (!validTiming || !validRegion || !validPrompt || overlapsExisting) {
        const error = 'Invalid or overlapping marker — skipped.';
        updatePlanItem(id, input.key, { error });
        send('item-done', { index, success: false, error });
        results.push({ success: false });
        continue;
      }

      const marker = addMarker(id, { start: start!, end: end!, prompt: prompt!, region: region ?? undefined, assets: validAssetIds(id, input.assets) });
      updatePlanItem(id, input.key, { markerId: marker.marker_id, error: undefined });
      send('item-created', { index, markerId: marker.marker_id });

      // The voice is made first: it is quick, and the overlay is then generated knowing the line.
      const narration = typeof input.narration === 'string' ? input.narration.trim().slice(0, MAX_NARRATION_CHARS) : '';
      if (narration) {
        const voice = readProject(id)?.voice;
        setMarkerNarration(id, marker.marker_id, { text: narration, voice: isValidVoice(voice) ? voice : DEFAULT_VOICE });
        send('progress', { index, markerId: marker.marker_id, attempt: 0, phase: 'voice' });
        try {
          const voiced = await generateNarration(id, marker.marker_id, signal);
          if (voiced.retimed) regenerateRegistry(id);
          shift += Math.max(0, voiced.marker.end - marker.end);
        } catch (err) {
          if (!signal.aborted) send('item-voice', { index, markerId: marker.marker_id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      created.push({ index, input, markerId: marker.marker_id, narration });
    }

    // Stopping throws away the half-made markers and puts their plan items back to pending. When the
    // editor just went away, they are left for the saved plan to pick up again.
    const cancelItem = (item: (typeof created)[number]) => {
      const removed = job.stoppedByUser();
      if (removed) {
        discardMarker(id, item.markerId);
        updatePlanItem(id, item.input.key, { markerId: undefined });
      }
      send('item-done', { index: item.index, markerId: item.markerId, success: false, cancelled: true, removed });
    };

    const generate = async (item: (typeof created)[number]) => {
      const { index, input, markerId, narration } = item;
      // Read back: the voice may have lengthened the marker.
      const marker = findMarker(id, markerId);
      const region = marker.region ?? null;
      const { width: compositionWidth, height: compositionHeight } = readCompositionConfig(id);
      const effectiveRegion = region ?? { x: 0, y: 0, width: 1, height: 1 };
      const transcript = transcriptForRange(id, marker.start, marker.end)
        .map((s) => s.text)
        .join(' ');

      const result = await generateMarkerWithRetry({
        projectId: id,
        markerId,
        cwd: projectDir(id),
        file: markerFile(id, markerId),
        prompt: marker.prompt,
        feedback: '',
        transcript: transcript || undefined,
        narration: narration || undefined,
        allowSkills: toNameList(input.allowSkills),
        compositionWidth,
        compositionHeight,
        regionWidth: Math.round(effectiveRegion.width * compositionWidth),
        regionHeight: Math.round(effectiveRegion.height * compositionHeight),
        isFullScreen: !region,
        signal,
        onEvent: (e) => {
          // Raw claude stream events aren't forwarded here (the frontend doesn't consume
          // them for the single-marker flow either) — just the progress phases, tagged by
          // which item they belong to since multiple markers stream over one connection.
          if (e.type === 'progress') {
            send('progress', { index, markerId, attempt: e.attempt, phase: e.phase, error: e.error });
          }
        },
      });

      if (result.cancelled) return cancelItem(item);
      send('item-done', { index, markerId, success: result.success, error: result.error });
      results.push({ markerId, success: result.success });
    };

    // A few workers take the created markers in order. Items no worker reached before a stop are
    // cancelled the same way as the ones that were running.
    let next = 0;
    const worker = async () => {
      while (next < created.length) {
        const item = created[next++];
        if (signal.aborted) cancelItem(item);
        else await generate(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxParallelRuns(), created.length) }, worker));
    regenerateRegistry(id);

    // An editor that went away leaves the plan marked as applying, which is how it shows up as interrupted.
    const planRemaining = signal.aborted && !job.stoppedByUser() ? !!readPlan(id) : settlePlan(id);
    send('done', { completed: results.length, total: inputs.length, results, cancelled: signal.aborted, planRemaining });
  } catch (err) {
    writeLog('error', 'route.error', { route: 'apply-markers', project: id, error: err });
    send('done', { completed: results.length, total: inputs.length, results, planRemaining: settlePlan(id), error: err instanceof Error ? err.message : String(err) });
  } finally {
    job.finish();
    res.end();
  }
});

projectsRouter.get('/projects/:id/markers/:markerId/code', (req, res) => {
  const file = markerFile(req.params.id, req.params.markerId);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf-8'));
});

projectsRouter.post('/projects/:id/markers/:markerId/regenerate', requireVideo, async (req, res) => {
  const { id, markerId } = req.params;
  const { feedback, allowSkills } = req.body as { feedback?: string; allowSkills?: unknown };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const job = startJob(id, `regenerate:${markerId}`, res);
  try {
    const marker = findMarker(id, markerId);
    const file = markerFile(id, markerId);
    const cwd = projectDir(id);
    const resolvedFeedback = feedback ?? marker.feedback;
    const { width: compositionWidth, height: compositionHeight } = readCompositionConfig(id);
    const isFullScreen = !marker.region;
    const region = marker.region ?? { x: 0, y: 0, width: 1, height: 1 };
    const regionWidth = Math.round(region.width * compositionWidth);
    const regionHeight = Math.round(region.height * compositionHeight);
    const transcript = transcriptForRange(id, marker.start, marker.end)
      .map((s) => s.text)
      .join(' ');

    const result = await generateMarkerWithRetry({
      projectId: id,
      markerId,
      cwd,
      file,
      prompt: marker.prompt,
      feedback: resolvedFeedback,
      transcript: transcript || undefined,
      narration: marker.narration?.text,
      allowSkills: toNameList(allowSkills),
      compositionWidth,
      compositionHeight,
      regionWidth,
      regionHeight,
      isFullScreen,
      signal: job.signal,
      onEvent: (e) => {
        if (e.type === 'claude') send('claude', e.raw);
        else send('progress', { attempt: e.attempt, phase: e.phase, error: e.error });
      },
    });

    send('done', { success: result.success, code: result.code, error: result.error, cancelled: result.cancelled });
  } catch (err) {
    writeLog('error', 'route.error', { route: 'regenerate', project: id, marker: markerId, error: err });
    send('done', { success: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    job.finish();
    res.end();
  }
});
