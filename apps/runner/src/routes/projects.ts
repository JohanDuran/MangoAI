import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectDir, markerFile } from '../lib/paths.js';
import { createProject, listProjects, readProject, addMarker } from '../lib/scaffold.js';
import { readMarkers, findMarker, updateMarkerStatus, updateMarkerTiming } from '../lib/markers.js';
import { regenerateRegistry } from '../lib/registry.js';
import { runClaudeHeadless, buildRegeneratePrompt } from '../lib/claude.js';
import { validateMarkerFile } from '../lib/validate.js';
import { logAttempt } from '../lib/debug.js';
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
  const { start, end, prompt } = req.body as { start?: number; end?: number; prompt?: string };
  if (start === undefined || end === undefined || !prompt) {
    return res.status(400).json({ error: 'start, end, and prompt are required' });
  }
  res.status(201).json(addMarker(req.params.id, { start, end, prompt }));
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

    let priorError: string | undefined;
    let success = false;
    let lastCode = fs.readFileSync(file, 'utf-8');

    for (let attempt = 1; attempt <= 3; attempt++) {
      send('progress', { attempt, phase: 'invoking-claude' });

      const prompt = buildRegeneratePrompt({
        markerId,
        currentCode: lastCode,
        prompt: marker.prompt,
        feedback: resolvedFeedback,
        priorError,
        transcript: transcript || undefined,
        imageUrl,
        compositionWidth,
        compositionHeight,
      });

      const result = await runClaudeHeadless({
        projectId: id,
        cwd,
        prompt,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
        onEvent: (event) => send('claude', event),
      });

      if (!result.success) {
        priorError = `Claude process exited with code ${result.exitCode}`;
        send('progress', { attempt, phase: 'claude-failed', error: priorError });
        continue;
      }

      lastCode = fs.readFileSync(file, 'utf-8');
      send('progress', { attempt, phase: 'validating' });
      const validation = await validateMarkerFile(file);
      logAttempt(id, markerId, attempt, lastCode, validation);

      if (validation.ok) {
        success = true;
        break;
      }
      priorError = validation.error;
      send('progress', { attempt, phase: 'validation-failed', error: priorError });
    }

    updateMarkerStatus(id, markerId, resolvedFeedback, success ? 'ready' : 'error');
    send('done', { success, code: lastCode, error: success ? undefined : priorError });
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
    if (result.code === 0) {
      res.json({ success: true, output: outFile });
    } else {
      res.status(500).json({ success: false, log: result.log });
    }
  } finally {
    exportsInFlight.delete(id);
  }
});
