import { Router } from 'express';
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
} from '../lib/scaffold.js';
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
import { planMarkers, planMarkersFromIdea } from '../lib/planner.js';
import { findRawVideo } from '../lib/video.js';
import { readCompositionConfig } from '../lib/composition.js';
import { transcribeProject, readTranscript, writeTranscript, transcriptForRange, type TranscriptSegment } from '../lib/transcript.js';

export const projectsRouter = Router();

// Aborts when the browser goes away before the response finished (tab closed, app quit, request
// cancelled), so a Claude run nobody is waiting for does not keep running and spending.
function abortOnClose(res: import('express').Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

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

projectsRouter.post('/projects/:id/markers', (req, res) => {
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
  const { start, end } = req.body as { start?: number; end?: number };
  if (start === undefined || end === undefined || end <= start) {
    return res.status(400).json({ error: 'start and end are required, and end must be after start' });
  }
  const marker = updateMarkerTiming(req.params.id, req.params.markerId, { start, end });
  regenerateRegistry(req.params.id);
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
  res.json({ segments });
});

projectsRouter.post('/projects/:id/markers/plan', async (req, res) => {
  const { context } = req.body as { context?: unknown };
  try {
    res.json(await planMarkers(req.params.id, typeof context === 'string' ? context : undefined, abortOnClose(res)));
  } catch (err) {
    writeLog('error', 'route.error', { route: 'plan-markers', project: req.params.id, error: err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

projectsRouter.post('/projects/:id/markers/plan-from-idea', async (req, res) => {
  const { idea } = req.body as { idea?: unknown };
  if (typeof idea !== 'string' || !idea.trim()) {
    return res.status(400).json({ error: 'idea must be a non-empty string' });
  }
  try {
    res.json(await planMarkersFromIdea(req.params.id, idea, abortOnClose(res)));
  } catch (err) {
    writeLog('error', 'route.error', { route: 'plan-markers-from-idea', project: req.params.id, error: err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface ApplyMarkerInput {
  start?: number;
  end?: number;
  prompt?: string;
  region?: MarkerRegion | null;
  allowSkills?: string[];
  assets?: string[];
}

projectsRouter.post('/projects/:id/markers/apply', async (req, res) => {
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
  const signal = abortOnClose(res);

  try {
    const { fps, durationInFrames } = readCompositionConfig(id);
    const durationSeconds = durationInFrames / fps;

    for (let index = 0; index < inputs.length; index++) {
      if (signal.aborted) break;
      const input = inputs[index];
      send('item-start', { index, total: inputs.length });

      const { start, end, prompt } = input;
      const region = input.region ?? null;
      const validTiming =
        typeof start === 'number' && typeof end === 'number' && start >= 0 && end > start && end <= durationSeconds + 0.001;
      const validRegion = region === null || isValidRegion(region);
      const validPrompt = typeof prompt === 'string' && prompt.trim().length > 0;
      const overlapsExisting =
        validTiming && readMarkers(id).some((m) => start! < m.end && end! > m.start);

      if (!validTiming || !validRegion || !validPrompt || overlapsExisting) {
        send('item-done', { index, success: false, error: 'Invalid or overlapping marker — skipped.' });
        results.push({ success: false });
        continue;
      }

      const marker = addMarker(id, { start: start!, end: end!, prompt: prompt!, region: region ?? undefined, assets: validAssetIds(id, input.assets) });
      send('item-created', { index, markerId: marker.marker_id });

      const { width: compositionWidth, height: compositionHeight } = readCompositionConfig(id);
      const isFullScreen = !region;
      const effectiveRegion = region ?? { x: 0, y: 0, width: 1, height: 1 };
      const regionWidth = Math.round(effectiveRegion.width * compositionWidth);
      const regionHeight = Math.round(effectiveRegion.height * compositionHeight);
      const transcript = transcriptForRange(id, start!, end!)
        .map((s) => s.text)
        .join(' ');

      const result = await generateMarkerWithRetry({
        projectId: id,
        markerId: marker.marker_id,
        cwd: projectDir(id),
        file: markerFile(id, marker.marker_id),
        prompt: prompt!,
        feedback: '',
        transcript: transcript || undefined,
        allowSkills: toNameList(input.allowSkills),
        compositionWidth,
        compositionHeight,
        regionWidth,
        regionHeight,
        isFullScreen,
        signal,
        onEvent: (e) => {
          // Raw claude stream events aren't forwarded here (the frontend doesn't consume
          // them for the single-marker flow either) — just the progress phases, tagged by
          // which item they belong to since multiple markers stream over one connection.
          if (e.type === 'progress') {
            send('progress', { index, markerId: marker.marker_id, attempt: e.attempt, phase: e.phase, error: e.error });
          }
        },
      });

      send('item-done', { index, markerId: marker.marker_id, success: result.success, error: result.error });
      results.push({ markerId: marker.marker_id, success: result.success });
    }

    send('done', { completed: results.length, total: inputs.length, results });
  } catch (err) {
    writeLog('error', 'route.error', { route: 'apply-markers', project: id, error: err });
    send('done', { completed: results.length, total: inputs.length, results, error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

projectsRouter.get('/projects/:id/markers/:markerId/code', (req, res) => {
  const file = markerFile(req.params.id, req.params.markerId);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf-8'));
});

projectsRouter.post('/projects/:id/markers/:markerId/regenerate', async (req, res) => {
  const { id, markerId } = req.params;
  const { feedback, allowSkills } = req.body as { feedback?: string; allowSkills?: unknown };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

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
      allowSkills: toNameList(allowSkills),
      compositionWidth,
      compositionHeight,
      regionWidth,
      regionHeight,
      isFullScreen,
      signal: abortOnClose(res),
      onEvent: (e) => {
        if (e.type === 'claude') send('claude', e.raw);
        else send('progress', { attempt: e.attempt, phase: e.phase, error: e.error });
      },
    });

    send('done', { success: result.success, code: result.code, error: result.error });
  } catch (err) {
    writeLog('error', 'route.error', { route: 'regenerate', project: id, marker: markerId, error: err });
    send('done', { success: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});
