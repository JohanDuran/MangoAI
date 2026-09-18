import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectDir, markerFile } from '../lib/paths.js';
import { createProject, listProjects, readProject, addMarker } from '../lib/scaffold.js';
import {
  readMarkers,
  findMarker,
  updateMarkerTiming,
  updateMarkerRegion,
  deleteMarker,
  isValidRegion,
  type MarkerRegion,
} from '../lib/markers.js';
import { regenerateRegistry } from '../lib/registry.js';
import { generateMarkerWithRetry } from '../lib/generateMarker.js';
import { planMarkers } from '../lib/planner.js';
import { findRawVideo } from '../lib/video.js';
import { readCompositionConfig } from '../lib/composition.js';
import { transcribeProject, readTranscript, transcriptForRange } from '../lib/transcript.js';
import { generateImage } from '../lib/images.js';

export const projectsRouter = Router();

// A render writes to a single output file; a second concurrent export for the same
// project would race on that file (reproduced during testing — one render silently
// clobbers the other's output). Reject instead of queuing, since export is user-triggered
// and rare.
const exportsInFlight = new Set<string>();

projectsRouter.post('/projects', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.status(201).json(createProject(name));
});

projectsRouter.get('/projects', (_req, res) => {
  res.json(listProjects());
});

projectsRouter.get('/projects/:id', (req, res) => {
  const project = readProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  res.json({
    project,
    markers: readMarkers(req.params.id),
    hasVideo: findRawVideo(req.params.id) !== null,
    composition: readCompositionConfig(req.params.id),
  });
});

projectsRouter.post('/projects/:id/markers', (req, res) => {
  const { start, end, prompt, region } = req.body as { start?: number; end?: number; prompt?: string; region?: unknown };
  if (start === undefined || end === undefined || !prompt) {
    return res.status(400).json({ error: 'start, end, and prompt are required' });
  }
  if (region !== undefined && region !== null && !isValidRegion(region)) {
    return res.status(400).json({ error: 'region must be null or {x,y,width,height} normalized within 0-1 of the canvas' });
  }
  res.status(201).json(addMarker(req.params.id, { start, end, prompt, region: (region ?? undefined) as MarkerRegion | undefined }));
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
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

projectsRouter.get('/projects/:id/transcript', (req, res) => {
  res.json({ segments: readTranscript(req.params.id) });
});

projectsRouter.post('/projects/:id/markers/plan', async (req, res) => {
  try {
    res.json(await planMarkers(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface ApplyMarkerInput {
  start?: number;
  end?: number;
  prompt?: string;
  region?: MarkerRegion | null;
  allowImage?: boolean;
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

  try {
    const { fps, durationInFrames } = readCompositionConfig(id);
    const durationSeconds = durationInFrames / fps;

    for (let index = 0; index < inputs.length; index++) {
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

      const marker = addMarker(id, { start: start!, end: end!, prompt: prompt!, region: region ?? undefined });
      send('item-created', { index, markerId: marker.marker_id });

      // Same reasoning as the /regenerate route: no Bash grant, images are pre-generated
      // and handed to Claude as a URL instead.
      let imageUrl: string | undefined;
      if (input.allowImage) {
        send('progress', { index, markerId: marker.marker_id, attempt: 1, phase: 'generating-image' });
        try {
          const { file: imageFile } = await generateImage(id, prompt!);
          imageUrl = `http://localhost:${process.env.PORT || 5175}/projects/${id}/assets/${imageFile}`;
        } catch (err) {
          send('progress', {
            index,
            markerId: marker.marker_id,
            attempt: 1,
            phase: 'image-generation-failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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
        imageUrl,
        compositionWidth,
        compositionHeight,
        regionWidth,
        regionHeight,
        isFullScreen,
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
  const { feedback, allowImage } = req.body as { feedback?: string; allowImage?: boolean };

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

    // Bash was tried and dropped: --allowedTools "Bash(...)" doesn't actually restrict to
    // the given pattern (verified empirically — a scoped grant still permits arbitrary
    // commands), so any Bash grant here would mean full shell access on every image
    // request. Generating the image ourselves and handing Claude a ready URL means it
    // never needs Bash at all — same allowedTools as every other call.
    let imageUrl: string | undefined;
    if (allowImage) {
      send('progress', { attempt: 1, phase: 'generating-image' });
      try {
        const { file: imageFile } = await generateImage(id, resolvedFeedback || marker.prompt);
        imageUrl = `http://localhost:${process.env.PORT || 5175}/projects/${id}/assets/${imageFile}`;
      } catch (err) {
        send('progress', {
          attempt: 1,
          phase: 'image-generation-failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const result = await generateMarkerWithRetry({
      projectId: id,
      markerId,
      cwd,
      file,
      prompt: marker.prompt,
      feedback: resolvedFeedback,
      transcript: transcript || undefined,
      imageUrl,
      compositionWidth,
      compositionHeight,
      regionWidth,
      regionHeight,
      isFullScreen,
      onEvent: (e) => {
        if (e.type === 'claude') send('claude', e.raw);
        else send('progress', { attempt: e.attempt, phase: e.phase, error: e.error });
      },
    });

    send('done', { success: result.success, code: result.code, error: result.error });
  } catch (err) {
    send('done', { success: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

projectsRouter.post('/projects/:id/export', async (req, res) => {
  const { id } = req.params;
  if (exportsInFlight.has(id)) {
    return res.status(409).json({ error: 'An export is already running for this project' });
  }
  exportsInFlight.add(id);

  try {
    const dir = projectDir(id);
    const entry = path.join(dir, '03_remotion_code', 'Root.tsx');
    const outFile = path.join(dir, '04_output', 'overlay.webm');

    const result = await new Promise<{ code: number | null; log: string }>((resolve) => {
      let log = '';
      const child = spawn(
        'npx',
        [
          'remotion',
          'render',
          entry,
          'Overlay',
          outFile,
          '--codec=vp8',
          '--pixel-format=yuva420p',
          '--image-format=png',
        ],
        { cwd: dir, shell: process.platform === 'win32' }
      );
      child.stdout.on('data', (c) => (log += c.toString()));
      child.stderr.on('data', (c) => (log += c.toString()));
      child.on('close', (code) => resolve({ code, log }));
    });

    fs.writeFileSync(path.join(dir, '04_output', 'render_log.txt'), result.log);
    if (result.code !== 0) {
      return res.status(500).json({ success: false, log: result.log });
    }
    if (!req.body?.includeVideo) {
      return res.json({ success: true, output: outFile });
    }

    const raw = findRawVideo(id);
    if (!raw) {
      return res.status(400).json({ success: false, log: 'No source video uploaded; cannot build the combined mp4' });
    }
    const finalFile = path.join(dir, '04_output', 'final.mp4');
    // -c:v libvpx before the overlay input forces the decoder that preserves VP8 alpha
    // (ffmpeg's native vp8 decoder drops it). The overlay is scaled to the base video size.
    const mix = await new Promise<{ code: number | null; log: string }>((resolve) => {
      let log = '';
      const child = spawn(
        'ffmpeg',
        [
          '-y',
          '-i', raw,
          '-c:v', 'libvpx',
          '-i', outFile,
          '-filter_complex',
          '[1:v][0:v]scale2ref=w=iw:h=ih[ov][base];[base][ov]overlay=eof_action=pass:format=auto,format=yuv420p[v]',
          '-map', '[v]',
          '-map', '0:a?',
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          finalFile,
        ],
        { cwd: dir }
      );
      child.stdout.on('data', (c) => (log += c.toString()));
      child.stderr.on('data', (c) => (log += c.toString()));
      child.on('error', (err) => resolve({ code: -1, log: `Could not run ffmpeg: ${err.message}` }));
      child.on('close', (code) => resolve({ code, log }));
    });
    fs.writeFileSync(path.join(dir, '04_output', 'mix_log.txt'), mix.log);
    if (mix.code === 0) {
      res.json({ success: true, output: finalFile });
    } else {
      res.status(500).json({ success: false, log: mix.log });
    }
  } finally {
    exportsInFlight.delete(id);
  }
});
