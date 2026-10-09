import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { inputDir } from '../lib/paths.js';
import { readProject, baseLayerOf, updateProjectSettings } from '../lib/scaffold.js';
import { musicSettings, musicFilePath, removeMusicFiles, speechIntervals, DUCK_LEVEL, RAMP_SEC } from '../lib/music.js';
import { runCommand } from '../lib/proc.js';
import { ffprobeBin } from '../lib/bin.js';
import { findRawVideo, removeExistingRawVideo } from '../lib/video.js';
import { updateCompositionConfig } from '../lib/composition.js';
import { assetFilePath } from '../lib/images.js';
import { regenerateRegistry } from '../lib/registry.js';
import { skillPublicFile } from '../lib/skills.js';
import { bundleOverlay } from '../lib/overlayBundle.js';
import { assertSafeId, InvalidIdError } from '../lib/paths.js';
import { probeVideo, PREVIEW_RISKY_CODECS } from '../lib/probe.js';
import { assertFreeSpace } from '../lib/disk.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.3gp']);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// The upload lands under a temporary name and only replaces the project's current video once ffprobe
// has confirmed it is a real, readable video. A failed or aborted upload leaves the old video alone.
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const id = req.params.id;
    if (!readProject(id)) {
      cb(new Error('Project not found'), '');
      return;
    }
    if (baseLayerOf(id).type !== 'video') {
      cb(new Error('This project was started without a video and cannot accept a video upload'), '');
      return;
    }
    cb(null, inputDir(id));
  },
  filename: (_req, _file, cb) => {
    cb(null, `upload_${crypto.randomBytes(4).toString('hex')}.part`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  // Some systems report no video mimetype for .mkv and friends, so the extension counts too; ffprobe decides in the end.
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('video/') || VIDEO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())),
});

export const videoRouter = Router();

videoRouter.post('/projects/:id/video', (req, res) => {
  const id = req.params.id;
  try {
    assertSafeId('project id', id);
    if (!readProject(id)) return res.status(404).json({ error: 'not found' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 0) assertFreeSpace(inputDir(id), declared * 1.1 + 500 * 1024 ** 2, 'this video and its exports');
  } catch (err) {
    return res.status(err instanceof InvalidIdError ? 400 : 507).json({ error: err instanceof Error ? err.message : String(err) });
  }

  upload.single('video')(req, res, async (err) => {
    if (err) {
      const tooLarge = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'That file is larger than 2 GB. Trim or compress it first.' : err.message });
    }
    const uploaded = req.file;
    if (!uploaded) return res.status(400).json({ error: 'A video file is required (form field "video"), and it must be a video.' });

    try {
      const info = await probeVideo(uploaded.path);
      if (!info) {
        fs.rmSync(uploaded.path, { force: true });
        return res.status(400).json({ error: 'This file could not be read as a video. It may be corrupted or use a format ffmpeg cannot open.' });
      }
      removeExistingRawVideo(id);
      const rawExt = path.extname(uploaded.originalname).toLowerCase();
      const ext = /^\.[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : '.mp4';
      fs.renameSync(uploaded.path, path.join(inputDir(id), `raw_video${ext}`));

      const warnings: string[] = [];
      if (PREVIEW_RISKY_CODECS.has(info.codec)) warnings.push(`This video uses the ${info.codec} codec, which the preview may not be able to play. Export still works.`);
      if (info.rotation !== 0) warnings.push(`This video is rotated (${info.rotation}°). Dimensions were adjusted so the overlay lines up.`);
      res.status(201).json({
        url: `/projects/${id}/video`,
        info: { width: info.width, height: info.height, durationSeconds: info.durationSeconds, codec: info.codec, hasAudio: info.hasAudio },
        warnings,
      });
    } catch (e) {
      fs.rmSync(uploaded.path, { force: true });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
});

// The project's generated overlay, bundled into one ES module for the editor's live preview.
videoRouter.get('/projects/:id/overlay.js', async (req, res) => {
  try {
    assertSafeId('project id', req.params.id);
    if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
    const { code } = await bundleOverlay(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').send(code);
  } catch (err) {
    res.status(err instanceof InvalidIdError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------- background music (see music.ts)

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm']);
const MAX_MUSIC_BYTES = 200 * 1024 * 1024;

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      if (!readProject(req.params.id)) cb(new Error('Project not found'), '');
      else cb(null, inputDir(req.params.id));
    },
    filename: (_req, _file, cb) => cb(null, `upload_${crypto.randomBytes(4).toString('hex')}.part`),
  }),
  limits: { fileSize: MAX_MUSIC_BYTES },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('audio/') || AUDIO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())),
});

// The music, plus what the preview needs to duck it the same way the export does.
const musicState = (id: string) => ({ music: musicSettings(id), intervals: speechIntervals(id), duckLevel: DUCK_LEVEL, rampSec: RAMP_SEC });

videoRouter.get('/projects/:id/music', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(musicState(req.params.id));
});

// Replaces the project's music. Like a video upload, it only takes over once ffprobe has confirmed
// the file has audio, and a replaced file is deleted.
videoRouter.post('/projects/:id/music', (req, res) => {
  const id = req.params.id;
  try {
    assertSafeId('project id', id);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  musicUpload.single('music')(req, res, async (err) => {
    if (err) {
      const tooLarge = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'That file is larger than 200 MB.' : err.message });
    }
    const uploaded = req.file;
    if (!uploaded) return res.status(400).json({ error: 'An audio file is required (form field "music"): mp3, wav, m4a, ogg, opus or flac.' });
    try {
      const probe = await runCommand(ffprobeBin(), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', uploaded.path], { timeoutMs: 30_000 });
      const parsed = JSON.parse(probe.stdout || '{}') as { streams?: unknown[]; format?: { duration?: string } };
      const durationSec = Number.parseFloat(parsed.format?.duration ?? '');
      if (!parsed.streams?.length || !Number.isFinite(durationSec) || durationSec <= 0) {
        fs.rmSync(uploaded.path, { force: true });
        return res.status(400).json({ error: 'This file could not be read as audio.' });
      }
      const rawExt = path.extname(uploaded.originalname).toLowerCase();
      const ext = AUDIO_EXTENSIONS.has(rawExt) ? rawExt : '.mp3';
      const file = `music-${crypto.randomBytes(4).toString('hex')}${ext}`;
      fs.renameSync(uploaded.path, path.join(inputDir(id), file));
      const previous = musicSettings(id);
      updateProjectSettings(id, {
        music: {
          file,
          name: path.basename(uploaded.originalname).slice(0, 120),
          durationSec: Math.round(durationSec * 100) / 100,
          volume: previous?.volume ?? 0.35,
          loop: previous?.loop ?? true,
          duck: previous?.duck ?? true,
        },
      });
      removeMusicFiles(id, file);
      res.status(201).json(musicState(id));
    } catch (e) {
      fs.rmSync(uploaded.path, { force: true });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
});

videoRouter.patch('/projects/:id/music', (req, res) => {
  const id = req.params.id;
  const music = musicSettings(id);
  if (!music) return res.status(404).json({ error: 'no music' });
  const { volume, loop, duck } = req.body as { volume?: unknown; loop?: unknown; duck?: unknown };
  if (volume !== undefined && (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1)) {
    return res.status(400).json({ error: 'volume must be a number from 0 to 1' });
  }
  if ((loop !== undefined && typeof loop !== 'boolean') || (duck !== undefined && typeof duck !== 'boolean')) {
    return res.status(400).json({ error: 'loop and duck must be true or false' });
  }
  updateProjectSettings(id, {
    music: { ...music, ...(volume !== undefined && { volume }), ...(loop !== undefined && { loop }), ...(duck !== undefined && { duck }) },
  });
  res.json(musicState(id));
});

videoRouter.delete('/projects/:id/music', (req, res) => {
  const id = req.params.id;
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  updateProjectSettings(id, { music: undefined });
  removeMusicFiles(id);
  res.status(204).end();
});

videoRouter.get('/projects/:id/music/file', (req, res) => {
  const file = musicFilePath(req.params.id);
  if (!file) return res.status(404).json({ error: 'no music' });
  res.sendFile(file);
});

videoRouter.get('/projects/:id/video', (req, res) => {
  const file = findRawVideo(req.params.id);
  if (!file) return res.status(404).json({ error: 'no video uploaded for this project' });
  res.sendFile(file);
});

videoRouter.patch('/projects/:id/composition', (req, res) => {
  const { durationInFrames, width, height } = req.body as {
    durationInFrames?: number;
    width?: number;
    height?: number;
  };
  const patch: { durationInFrames?: number; width?: number; height?: number } = {};

  if (durationInFrames !== undefined) {
    if (durationInFrames <= 0) return res.status(400).json({ error: 'durationInFrames must be a positive number' });
    patch.durationInFrames = durationInFrames;
  }
  if (width !== undefined) {
    if (width <= 0) return res.status(400).json({ error: 'width must be a positive number' });
    patch.width = Math.round(width);
  }
  if (height !== undefined) {
    if (height <= 0) return res.status(400).json({ error: 'height must be a positive number' });
    patch.height = Math.round(height);
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'at least one of durationInFrames, width, height is required' });
  }

  const next = updateCompositionConfig(req.params.id, patch);
  // Marker regions are baked into CustomOverlay.tsx as pixel rects at generation time, so
  // a canvas resize (new video upload) invalidates them until regenerated.
  if (patch.width !== undefined || patch.height !== undefined) {
    regenerateRegistry(req.params.id);
  }
  res.json(next);
});

// Serves generated (or manually dropped-in) assets over plain HTTP so the same URL works
// both in the browser preview (Vite page fetching cross-origin) and in Remotion's headless
// render (Chromium fetching a normal localhost URL) — no dev-server-specific path tricks
// needed in either place.
videoRouter.get('/projects/:id/assets/:filename', (req, res) => {
  const file = assetFilePath(req.params.id, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
});

// Static files a skill ships in its public/ folder (sound files, for example). Same reasoning as
// the assets route: a plain HTTP URL works in both the browser preview and Remotion's headless render.
videoRouter.get('/skills/:name/public/*', (req, res) => {
  const file = skillPublicFile(req.params.name, (req.params as Record<string, string>)[0]);
  if (!file) return res.status(404).json({ error: 'not found' });
  res.sendFile(file);
});

// Marker code generated before sounds became a skill links to /sfx/<file>; keep those URLs working.
videoRouter.get('/sfx/:filename', (req, res) => {
  const file = skillPublicFile('sound-effects', req.params.filename);
  if (!file) return res.status(404).json({ error: 'not found' });
  res.sendFile(file);
});
