import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from '../lib/paths.js';
import { readProject, overlayVolume, voiceVolume, baseLayerOf } from '../lib/scaffold.js';
import { narrationClips } from '../lib/narration.js';
import { synthesizeBaseClip } from '../lib/baseClip.js';
import { log as writeLog, clip } from '../lib/log.js';
import { syncAssetModule } from '../lib/assetModule.js';
import { findRawVideo } from '../lib/video.js';
import { readCompositionConfig } from '../lib/composition.js';
import { markerFrameRanges, perMarkerFrameRanges, type FrameRange } from '../lib/ranges.js';
import { renderOverlayJobs } from '../lib/render.js';
import { videoEncoder } from '../lib/encoder.js';
import { probeVideo } from '../lib/probe.js';
import { spawnHidden, killTree, runCommand } from '../lib/proc.js';
import { ffmpegBin, ffprobeBin } from '../lib/bin.js';
import { assertFreeSpace, LowDiskSpaceError } from '../lib/disk.js';

export const exportRouter = Router();

export interface ExportResult {
  output?: string;
  outputDir?: string;
  outputs?: { markerId: string; file: string }[];
  // The voiceover, written beside an overlay-only export: one track for the whole timeline, or
  // one file per marker for a per-marker export.
  narration?: string;
  voices?: { markerId: string; file: string }[];
}

export interface ExportStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: 'preparing' | 'bundling' | 'rendering' | 'mixing' | 'finishing' | null;
  // 0-100, an estimate: bundling and mixing are timed loosely, rendering follows the real frame count.
  percent: number;
  message: string;
  result?: ExportResult;
  error?: string;
}

interface Job {
  status: ExportStatus;
  controller: AbortController;
}

// One export per project at a time: two would race on the same output files. The finished status
// stays available until the next export starts, so the editor can show the outcome after a reload.
const jobs = new Map<string, Job>();

export const isExporting = (id: string) => jobs.get(id)?.status.state === 'running';

export function abortAllExports(): void {
  for (const job of jobs.values()) if (job.status.state === 'running') job.controller.abort();
}

class ExportError extends Error {}

// Scales the audio of the rendered overlay to the project's overlay volume. The video stream
// is copied untouched, which keeps the alpha channel. A volume of 0 drops the audio track.
async function applyOverlayVolume(file: string, volume: number, signal: AbortSignal): Promise<{ ok: boolean; log: string }> {
  if (volume >= 1 || !(await hasAudioStream(file))) return { ok: true, log: '' };

  const isMov = file.endsWith('.mov');
  const tmp = `${file}.tmp${isMov ? '.mov' : '.webm'}`;
  const audioArgs = volume === 0 ? ['-an'] : ['-af', `volume=${volume}`, '-c:a', isMov ? 'pcm_s16le' : 'libopus'];
  const run = await runFfmpeg(['-y', '-i', file, '-c:v', 'copy', ...audioArgs, tmp], signal);
  if (run.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, log: run.log };
  }
  fs.renameSync(tmp, file);
  return { ok: true, log: '' };
}

function runFfmpeg(args: string[], signal: AbortSignal, cwd?: string): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    let log = '';
    const child = spawnHidden(ffmpegBin(), args, { cwd });
    const onAbort = () => killTree(child);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => (log += c.toString()));
    child.stderr.on('data', (c) => (log += c.toString()));
    child.on('error', (err) => resolve({ code: -1, log: `Could not run ffmpeg: ${err.message}` }));
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ code, log });
    });
  });
}

type VoiceClip = ReturnType<typeof narrationClips>[number];

// Filter steps placing each voice clip at its marker's start on the timeline, cut at the end of the
// video. `firstInput` is the ffmpeg input index of the first clip; labels are [vo0], [vo1], ...
function voiceFilters(clips: VoiceClip[], firstInput: number, totalSeconds: number, volume: number): { parts: string[]; labels: string[] } {
  const parts: string[] = [];
  const labels: string[] = [];
  clips.forEach((c, i) => {
    const room = Math.max(0.05, totalSeconds - c.start);
    parts.push(`[${firstInput + i}:a]aresample=48000,atrim=end=${room.toFixed(3)},adelay=${Math.round(c.start * 1000)}:all=1,volume=${volume}[vo${i}]`);
    labels.push(`[vo${i}]`);
  });
  return { parts, labels };
}

// The whole voiceover as one track as long as the video, for an overlay-only export. Silence where
// no marker speaks, so it lines up when dropped at 0 in another editor.
export async function writeNarrationTrack(clips: VoiceClip[], totalSeconds: number, volume: number, out: string, signal: AbortSignal): Promise<{ code: number | null; log: string }> {
  const { parts, labels } = voiceFilters(clips, 1, totalSeconds, volume);
  parts.push(`[0:a]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]`);
  return runFfmpeg(
    [
      '-y',
      '-f', 'lavfi', '-t', totalSeconds.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo',
      ...clips.flatMap((c) => ['-i', c.file]),
      '-filter_complex', parts.join(';'),
      '-map', '[a]',
      '-c:a', 'pcm_s16le',
      out,
    ],
    signal
  );
}

// One marker's voice, at the project's voice volume, for a per-marker export.
const writeVoiceFile = (clip: VoiceClip, volume: number, out: string, signal: AbortSignal) =>
  runFfmpeg(['-y', '-i', clip.file, '-af', `volume=${volume}`, '-c:a', 'pcm_s16le', out], signal);

async function hasAudioStream(file: string): Promise<boolean> {
  const result = await runCommand(ffprobeBin(), ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
  return result.stdout.trim().length > 0;
}

// Rough size of the intermediate files, so a nearly full disk is reported before hours of rendering.
// ProRes 4444 is very large (tens of MB per second at 1080p); the transparent webm is small.
function estimateBytes(seconds: number, width: number, height: number, prores: boolean): number {
  const scale = (width * height) / (1920 * 1080);
  return Math.ceil(seconds * scale * (prores ? 30 * 1024 ** 2 : 3 * 1024 ** 2));
}

async function execute(id: string, body: { includeVideo?: boolean; perMarker?: boolean; mergeGapSeconds?: unknown }, job: Job): Promise<ExportResult> {
  const { status, controller } = job;
  const signal = controller.signal;
  const set = (phase: ExportStatus['phase'], percent: number, message: string) => {
    status.phase = phase;
    status.percent = Math.max(status.percent, Math.min(100, Math.round(percent)));
    status.message = message;
  };
  const cancelled = () => signal.aborted;
  const outputStart = () => {
    if (cancelled()) throw new ExportError('Export cancelled.');
  };

  set('preparing', 1, 'Preparing');
  syncAssetModule(id);
  const dir = projectDir(id);
  const entry = path.join(dir, '03_remotion_code', 'Root.tsx');
  const outFile = path.join(dir, '04_output', 'overlay.webm');
  fs.mkdirSync(path.join(dir, '04_output'), { recursive: true });
  const baseLayer = baseLayerOf(id);
  const { fps, width, height, durationInFrames } = readCompositionConfig(id);
  // Exporting per marker only ever makes sense for the overlay alone (there's no useful way to
  // composite N separate marker clips onto one base video in a single file), so it overrides includeVideo.
  const perMarker = !!body.perMarker;
  // A transparent base has no video to composite onto — the overlay-only alpha render below is
  // already the correct deliverable for it, so a "combined" export request degrades to that.
  const includeVideo = !!body.includeVideo && baseLayer.type !== 'transparent' && !perMarker;
  const totalSeconds = durationInFrames / fps;
  const clips = narrationClips(id);
  const voiceVol = voiceVolume(id);

  if (perMarker) {
    const markerDir = path.join(dir, '04_output', 'by_marker');
    const jobRanges = perMarkerFrameRanges(id);
    if (jobRanges.length === 0) throw new ExportError('No markers to export');
    const seconds = jobRanges.reduce((sum, r) => sum + (r.to - r.from + 1) / fps, 0);
    assertFreeSpace(path.join(dir, '04_output'), estimateBytes(seconds, width, height, false), 'this export');
    fs.rmSync(markerDir, { recursive: true, force: true });
    fs.mkdirSync(markerDir, { recursive: true });
    const volume = overlayVolume(id);
    const outputs: { markerId: string; file: string }[] = [];
    let renderLog = '';
    let failure: string | null = null;
    await renderOverlayJobs(
      entry,
      jobRanges.map((r) => ({ outputLocation: path.join(markerDir, `${r.markerId}.webm`), frames: r, codec: 'vp8' as const })),
      async (i, result) => {
        const jobRange = jobRanges[i];
        renderLog += `\n=== marker ${jobRange.markerId} ===\n${result.log}`;
        fs.writeFileSync(path.join(dir, '04_output', 'render_log.txt'), renderLog);
        writeLog(result.ok ? 'info' : 'error', 'export.render', {
          project: id,
          marker: jobRange.markerId,
          ok: result.ok,
          ms: result.ms,
          output: result.ok ? undefined : clip(result.log.slice(-800), 800),
        });
        if (!result.ok) {
          failure = result.log;
          return false;
        }
        const file = path.join(markerDir, `${jobRange.markerId}.webm`);
        const scaled = await applyOverlayVolume(file, volume, signal);
        if (!scaled.ok) {
          failure = scaled.log;
          return false;
        }
        outputs.push({ markerId: jobRange.markerId, file });
        return true;
      },
      {
        signal,
        onPhase: (phase) => (phase === 'bundling' ? set('bundling', 3, 'Preparing the animations') : set('rendering', 12, 'Rendering')),
        onProgress: (i, fraction) => set('rendering', 12 + 85 * ((i + fraction) / jobRanges.length), `Rendering marker ${i + 1} of ${jobRanges.length}`),
      }
    );
    if (cancelled()) {
      fs.rmSync(markerDir, { recursive: true, force: true });
      throw new ExportError('Export cancelled.');
    }
    if (failure) throw new ExportError(failure);
    const voices: { markerId: string; file: string }[] = [];
    if (voiceVol > 0) {
      for (const c of clips) {
        const file = path.join(markerDir, `${c.markerId}_voice.wav`);
        const made = await writeVoiceFile(c, voiceVol, file, signal);
        if (cancelled()) throw new ExportError('Export cancelled.');
        if (made.code !== 0) throw new ExportError(`Could not write the voiceover for ${c.markerId}: ${made.log.slice(-600)}`);
        voices.push({ markerId: c.markerId, file });
      }
    }
    writeLog('info', 'export.done', { project: id, output: markerDir, count: outputs.length, voices: voices.length });
    return { outputDir: markerDir, outputs, ...(voices.length > 0 && { voices }) };
  }

  let raw: string | null = null;
  if (includeVideo) {
    if (baseLayer.type === 'video') {
      raw = findRawVideo(id);
      if (!raw) throw new ExportError('No source video uploaded; cannot build the combined mp4');
    } else {
      raw = path.join(dir, '04_output', 'base_clip.mp4');
      const synth = await synthesizeBaseClip(baseLayer, { width, height, durationInFrames, fps }, raw);
      if (!synth.ok) throw new ExportError(synth.log || 'Could not synthesize the color/gradient base clip');
    }
  }
  outputStart();

  // For the combined mp4 only the frames inside markers are rendered (one overlay clip per
  // merged marker range) and composited at their offsets, instead of rendering a mostly
  // empty overlay for the whole video. Overlay-only export, or a project with no markers,
  // renders the full timeline as one clip starting at 0.
  const gap = typeof body.mergeGapSeconds === 'number' ? body.mergeGapSeconds : undefined;
  const ranges = includeVideo ? markerFrameRanges(id, gap) : [];
  const segDir = path.join(dir, '04_output', 'segments');
  fs.rmSync(segDir, { recursive: true, force: true });
  const segments: { file: string; startSec: number; frames?: FrameRange }[] =
    ranges.length > 0
      ? ranges.map((r, i) => ({ file: path.join(segDir, `seg_${i}.mov`), startSec: r.from / fps, frames: r }))
      : [{ file: includeVideo ? path.join(dir, '04_output', 'overlay_full.mov') : outFile, startSec: 0 }];
  if (ranges.length > 0) fs.mkdirSync(segDir, { recursive: true });

  const renderSeconds = ranges.length > 0 ? ranges.reduce((sum, r) => sum + (r.to - r.from + 1) / fps, 0) : durationInFrames / fps;
  let needed = estimateBytes(renderSeconds, width, height, includeVideo);
  if (includeVideo && raw && fs.existsSync(raw)) needed += fs.statSync(raw).size * 1.2;
  assertFreeSpace(path.join(dir, '04_output'), needed, 'this export');

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
      const scaled = await applyOverlayVolume(seg.file, volume, signal);
      writeLog(scaled.ok ? 'info' : 'error', 'export.volume', { project: id, volume, ok: scaled.ok, output: scaled.ok ? undefined : clip(scaled.log.slice(-600), 600) });
      if (!scaled.ok) {
        failure = scaled.log;
        return false;
      }
      return true;
    },
    {
      signal,
      onPhase: (phase) => (phase === 'bundling' ? set('bundling', 3, 'Preparing the animations') : set('rendering', 12, 'Rendering')),
      onProgress: (i, fraction) => {
        const share = includeVideo ? 70 : 85;
        set('rendering', 12 + share * ((i + fraction) / segments.length), segments.length > 1 ? `Rendering part ${i + 1} of ${segments.length}` : 'Rendering');
      },
    }
  );
  if (cancelled()) {
    fs.rmSync(segDir, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
    throw new ExportError('Export cancelled.');
  }
  if (failure || rendered !== segments.length) {
    fs.rmSync(segDir, { recursive: true, force: true });
    throw new ExportError(failure ?? 'Render did not complete');
  }
  if (!includeVideo || !raw) {
    const narrationFile = path.join(dir, '04_output', 'narration.wav');
    fs.rmSync(narrationFile, { force: true });
    if (clips.length > 0 && voiceVol > 0) {
      set('mixing', 97, 'Writing the voiceover');
      const made = await writeNarrationTrack(clips, totalSeconds, voiceVol, narrationFile, signal);
      if (cancelled()) {
        fs.rmSync(narrationFile, { force: true });
        throw new ExportError('Export cancelled.');
      }
      writeLog(made.code === 0 ? 'info' : 'error', 'export.narration', { project: id, clips: clips.length, code: made.code, output: made.code === 0 ? undefined : clip(made.log.slice(-600), 600) });
      if (made.code !== 0) throw new ExportError(`Could not write the voiceover track: ${made.log.slice(-600)}`);
      writeLog('info', 'export.done', { project: id, output: outFile, narration: narrationFile });
      return { output: outFile, narration: narrationFile };
    }
    writeLog('info', 'export.done', { project: id, output: outFile });
    return { output: outFile };
  }

  set('mixing', 85, 'Combining with the video');
  const finalFile = path.join(dir, '04_output', 'final.mp4');
  const [baseHasAudio, segmentHasAudio, sourceInfo] = await Promise.all([
    hasAudioStream(raw),
    Promise.all(segments.map((s) => hasAudioStream(s.file))),
    probeVideo(raw),
  ]);
  if (!sourceInfo) throw new ExportError('Could not read the source video dimensions with ffprobe');
  const size = { width: sourceInfo.width, height: sourceInfo.height };

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
  // The voiceover clips come after the overlay segments in the input list.
  const voices = voiceVol > 0 ? voiceFilters(clips, segments.length + 1, totalSeconds, voiceVol) : { parts: [], labels: [] };
  audioParts.push(...voices.parts);
  audioLabels.push(...voices.labels);
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
  const encoder = await videoEncoder();
  const mixStarted = Date.now();
  const mix = await runFfmpeg(
    [
      '-y',
      '-i', raw,
      ...segments.flatMap((s) => ['-i', s.file]),
      ...(voices.labels.length > 0 ? clips.flatMap((c) => ['-i', c.file]) : []),
      '-filter_complex', [...videoParts, ...audioParts].join(';'),
      '-map', '[v]',
      ...audioMap,
      ...encoder.args,
      '-c:a', 'aac',
      '-movflags', '+faststart',
      finalFile,
    ],
    signal,
    dir
  );
  fs.writeFileSync(path.join(dir, '04_output', 'mix_log.txt'), mix.log);
  writeLog(mix.code === 0 ? 'info' : 'error', 'export.mix', {
    project: id,
    code: mix.code,
    segments: segments.length,
    encoder: encoder.label,
    ms: Date.now() - mixStarted,
    baseHasAudio,
    overlayHasAudio: segmentHasAudio.some(Boolean),
    voices: voices.labels.length,
    output: mix.code === 0 ? undefined : clip(mix.log.slice(-800), 800),
  });
  if (cancelled()) {
    fs.rmSync(finalFile, { force: true });
    fs.rmSync(segDir, { recursive: true, force: true });
    throw new ExportError('Export cancelled.');
  }
  if (mix.code !== 0) {
    fs.rmSync(finalFile, { force: true });
    throw new ExportError(mix.log.slice(-1200));
  }
  fs.rmSync(segDir, { recursive: true, force: true });
  writeLog('info', 'export.done', { project: id, output: finalFile });
  return { output: finalFile };
}

async function runJob(id: string, body: Parameters<typeof execute>[1], job: Job): Promise<void> {
  const { status } = job;
  try {
    status.result = await execute(id, body, job);
    status.state = 'done';
    status.percent = 100;
    status.phase = null;
    status.message = 'Export complete';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (job.controller.signal.aborted) {
      status.state = 'cancelled';
      status.message = 'Export cancelled';
    } else {
      status.state = 'failed';
      status.message = err instanceof LowDiskSpaceError || err instanceof ExportError ? message.split('\n')[0].slice(0, 300) : 'Export failed';
      status.error = message;
      writeLog('error', 'export.failed', { project: id, error: clip(message, 800) });
    }
    status.phase = null;
  }
}

exportRouter.post('/projects/:id/export', (req, res) => {
  const { id } = req.params;
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  if (isExporting(id)) return res.status(409).json({ error: 'An export is already running for this project' });

  const job: Job = {
    controller: new AbortController(),
    status: { state: 'running', phase: 'preparing', percent: 0, message: 'Starting' },
  };
  jobs.set(id, job);
  const body = (req.body ?? {}) as { includeVideo?: boolean; perMarker?: boolean; mergeGapSeconds?: unknown };
  writeLog('info', 'export.start', { project: id, includeVideo: !!body.includeVideo, perMarker: !!body.perMarker, overlayVolume: overlayVolume(id) });
  void runJob(id, body, job);
  res.status(202).json(job.status);
});

exportRouter.get('/projects/:id/export/status', (req, res) => {
  const job = jobs.get(req.params.id);
  const status: ExportStatus = job?.status ?? { state: 'idle', phase: null, percent: 0, message: '' };
  res.json(status);
});

exportRouter.post('/projects/:id/export/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status.state !== 'running') return res.status(409).json({ error: 'No export is running' });
  job.controller.abort();
  writeLog('info', 'export.cancel', { project: req.params.id });
  res.status(202).json({ cancelling: true });
});
