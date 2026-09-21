import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
} from '../lib/scaffold.js';
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
import { regenerateRegistry } from '../lib/registry.js';
import { generateMarkerWithRetry } from '../lib/generateMarker.js';
import { planMarkers } from '../lib/planner.js';
import { findRawVideo } from '../lib/video.js';
import { readCompositionConfig } from '../lib/composition.js';
import { markerFrameRanges, type FrameRange } from '../lib/ranges.js';
import { renderOverlayJobs } from '../lib/render.js';
import { transcribeProject, readTranscript, transcriptForRange } from '../lib/transcript.js';

export const projectsRouter = Router();

const toNameList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

// A render writes to a single output file; a second concurrent export for the same
// project would race on that file (reproduced during testing — one render silently
// clobbers the other's output). Reject instead of queuing, since export is user-triggered
// and rare.
const exportsInFlight = new Set<string>();

// Scales the audio of the rendered overlay to the project's overlay volume. The video stream
// is copied untouched, which keeps the alpha channel. A volume of 0 drops the audio track.
async function applyOverlayVolume(file: string, volume: number): Promise<{ ok: boolean; log: string }> {
  if (volume >= 1 || !(await hasAudioStream(file))) return { ok: true, log: '' };

  const isMov = file.endsWith('.mov');
  const tmp = `${file}.tmp${isMov ? '.mov' : '.webm'}`;
  const audioArgs = volume === 0 ? ['-an'] : ['-af', `volume=${volume}`, '-c:a', isMov ? 'pcm_s16le' : 'libopus'];
  const run = await new Promise<{ code: number | null; log: string }>((resolve) => {
    let log = '';
    const child = spawn('ffmpeg', ['-y', '-i', file, '-c:v', 'copy', ...audioArgs, tmp]);
    child.stderr.on('data', (c) => (log += c.toString()));
    child.on('error', (err) => resolve({ code: -1, log: `Could not run ffmpeg: ${err.message}` }));
    child.on('close', (code) => resolve({ code, log }));
  });
  if (run.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, log: run.log };
  }
  fs.renameSync(tmp, file);
  return { ok: true, log: '' };
}

function hasAudioStream(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
    child.stdout.on('data', (c) => (out += c.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.trim().length > 0));
  });
}

// Uses the GPU encoder when a tiny test encode actually works (an encoder can be listed by
// ffmpeg without a usable GPU); MANGO_VIDEO_ENCODER=libx264 forces the CPU encoder.
let videoEncoderArgs: Promise<string[]> | null = null;
function videoEncoder(): Promise<string[]> {
  videoEncoderArgs ??= new Promise((resolve) => {
    const cpu = ['-c:v', 'libx264'];
    if (process.env.MANGO_VIDEO_ENCODER === 'libx264') return resolve(cpu);
    const child = spawn('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
    child.on('error', () => resolve(cpu));
    child.on('close', (code) => resolve(code === 0 ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0'] : cpu));
  });
  return videoEncoderArgs;
}

function probeVideoSize(file: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file]);
    child.stdout.on('data', (c) => (out += c.toString()));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = /^(\d+)x(\d+)/.exec(out.trim());
      resolve(m ? { width: Number(m[1]), height: Number(m[2]) } : null);
    });
  });
}

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

// Everything a project owns (source video, transcript, assets, generated code, debug
// history, exports) lives under its own directory, so removing that directory is a
// complete cleanup.
projectsRouter.delete('/projects/:id', (req, res) => {
  const { id } = req.params;
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  if (exportsInFlight.has(id)) {
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

projectsRouter.post('/projects/:id/markers/plan', async (req, res) => {
  try {
    res.json(await planMarkers(req.params.id));
  } catch (err) {
    writeLog('error', 'route.error', { route: 'plan-markers', project: req.params.id, error: err });
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

projectsRouter.post('/projects/:id/export', async (req, res) => {
  const { id } = req.params;
  if (exportsInFlight.has(id)) {
    return res.status(409).json({ error: 'An export is already running for this project' });
  }
  exportsInFlight.add(id);
  writeLog('info', 'export.start', { project: id, includeVideo: !!req.body?.includeVideo, overlayVolume: overlayVolume(id) });

  try {
    const dir = projectDir(id);
    const entry = path.join(dir, '03_remotion_code', 'Root.tsx');
    const outFile = path.join(dir, '04_output', 'overlay.webm');
    const includeVideo = !!req.body?.includeVideo;

    const raw = includeVideo ? findRawVideo(id) : null;
    if (includeVideo && !raw) {
      return res.status(400).json({ success: false, log: 'No source video uploaded; cannot build the combined mp4' });
    }

    // For the combined mp4 only the frames inside markers are rendered (one overlay clip per
    // merged marker range) and composited at their offsets, instead of rendering a mostly
    // empty overlay for the whole video. Overlay-only export, or a project with no markers,
    // renders the full timeline as one clip starting at 0.
    const gap = typeof req.body?.mergeGapSeconds === 'number' ? req.body.mergeGapSeconds : undefined;
    const ranges = includeVideo ? markerFrameRanges(id, gap) : [];
    const { fps } = readCompositionConfig(id);
    const segDir = path.join(dir, '04_output', 'segments');
    fs.rmSync(segDir, { recursive: true, force: true });
    const segments: { file: string; startSec: number; frames?: FrameRange }[] =
      ranges.length > 0
        ? ranges.map((r, i) => ({ file: path.join(segDir, `seg_${i}.mov`), startSec: r.from / fps, frames: r }))
        : [{ file: includeVideo ? path.join(dir, '04_output', 'overlay_full.mov') : outFile, startSec: 0 }];
    if (ranges.length > 0) fs.mkdirSync(segDir, { recursive: true });

    const volume = overlayVolume(id);
    let renderLog = '';
    let failure: string | null = null;
    let rendered = 0;
    await renderOverlayJobs(
      entry,
      segments.map((s) => ({ outputLocation: s.file, frames: s.frames, codec: (includeVideo ? 'prores' : 'vp8') as 'vp8' | 'prores' })),
      async (i, result) => {
        const seg = segments[i];
        renderLog += `\n=== segment ${i + 1}/${segments.length} ===\n${result.log}`;
        fs.writeFileSync(path.join(dir, '04_output', 'render_log.txt'), renderLog);
        writeLog(result.ok ? 'info' : 'error', 'export.render', {
          project: id,
          segment: `${i + 1}/${segments.length}`,
          frames: seg.frames ? `${seg.frames.from}-${seg.frames.to}` : 'all',
          ok: result.ok,
          ms: result.ms,
          output: result.ok ? undefined : clip(result.log.slice(-800), 800),
        });
        if (!result.ok) {
          failure = result.log;
          return false;
        }
        rendered++;
        const scaled = await applyOverlayVolume(seg.file, volume);
        writeLog(scaled.ok ? 'info' : 'error', 'export.volume', { project: id, volume, ok: scaled.ok, output: scaled.ok ? undefined : clip(scaled.log.slice(-600), 600) });
        if (!scaled.ok) {
          failure = scaled.log;
          return false;
        }
        return true;
      }
    );
    if (failure || rendered !== segments.length) {
      return res.status(500).json({ success: false, log: failure ?? 'Render did not complete' });
    }
    if (!includeVideo || !raw) {
      writeLog('info', 'export.done', { project: id, output: outFile });
      return res.json({ success: true, output: outFile });
    }

    const finalFile = path.join(dir, '04_output', 'final.mp4');
    const [baseHasAudio, segmentHasAudio, size] = await Promise.all([
      hasAudioStream(raw),
      Promise.all(segments.map((s) => hasAudioStream(s.file))),
      probeVideoSize(raw),
    ]);
    if (!size) {
      return res.status(500).json({ success: false, log: 'Could not read the source video dimensions with ffprobe' });
    }

    // Each overlay clip is shifted to its start offset with setpts and overlaid in turn;
    // eof_action=pass shows the base video untouched before a clip starts and after it ends.
    const videoParts: string[] = [];
    let current = '0:v';
    segments.forEach((s, i) => {
      const input = i + 1;
      videoParts.push(`[${input}:v]scale=${size.width}:${size.height},setpts=PTS+${s.startSec}/TB[ov${i}]`);
      const last = i === segments.length - 1;
      videoParts.push(`[${current}][ov${i}]overlay=eof_action=pass:format=auto${last ? ',format=yuv420p' : ''}[${last ? 'v' : `c${i}`}]`);
      current = `c${i}`;
    });

    // Sounds from <Audio> in the markers end up as an audio track in each overlay clip, and the
    // source video usually has its own (speech/music). Delay each clip's audio to its offset and
    // mix everything; normalize=0 keeps the source at full level instead of halving it, and
    // alimiter guards against clipping where they overlap.
    const audioLabels: string[] = baseHasAudio ? ['[0:a]'] : [];
    const audioParts: string[] = [];
    segments.forEach((s, i) => {
      if (!segmentHasAudio[i]) return;
      audioParts.push(`[${i + 1}:a]adelay=${Math.round(s.startSec * 1000)}:all=1[a${i}]`);
      audioLabels.push(`[a${i}]`);
    });
    let audioMap: string[] = [];
    if (audioLabels.length === 1) {
      audioMap = ['-map', audioLabels[0] === '[0:a]' ? '0:a' : audioLabels[0]];
    } else if (audioLabels.length > 1) {
      audioParts.push(
        `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=${baseHasAudio ? 'first' : 'longest'}:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]`
      );
      audioMap = ['-map', '[a]'];
    }

    // Overlay clips are ProRes 4444 (alpha decodes natively; the VP8 alpha encoder was the
    // render bottleneck) and are scaled to the base video size.
    const encoderArgs = await videoEncoder();
    const mixStarted = Date.now();
    const mix = await new Promise<{ code: number | null; log: string }>((resolve) => {
      let log = '';
      const child = spawn(
        'ffmpeg',
        [
          '-y',
          '-i', raw,
          ...segments.flatMap((s) => ['-i', s.file]),
          '-filter_complex', [...videoParts, ...audioParts].join(';'),
          '-map', '[v]',
          ...audioMap,
          ...encoderArgs,
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
    writeLog(mix.code === 0 ? 'info' : 'error', 'export.mix', {
      project: id,
      code: mix.code,
      segments: segments.length,
      encoder: encoderArgs[1],
      ms: Date.now() - mixStarted,
      baseHasAudio,
      overlayHasAudio: segmentHasAudio.some(Boolean),
      output: mix.code === 0 ? undefined : clip(mix.log.slice(-800), 800),
    });
    if (mix.code === 0) {
      fs.rmSync(segDir, { recursive: true, force: true });
      writeLog('info', 'export.done', { project: id, output: finalFile });
      res.json({ success: true, output: finalFile });
    } else {
      res.status(500).json({ success: false, log: mix.log });
    }
  } finally {
    exportsInFlight.delete(id);
  }
});
