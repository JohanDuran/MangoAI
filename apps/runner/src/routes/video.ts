import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { inputDir } from '../lib/paths.js';
import { readProject } from '../lib/scaffold.js';
import { findRawVideo, removeExistingRawVideo } from '../lib/video.js';
import { updateCompositionConfig } from '../lib/composition.js';
import { generateImage, assetFilePath } from '../lib/images.js';
import { regenerateRegistry } from '../lib/registry.js';

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const id = req.params.id;
    if (!readProject(id)) {
      cb(new Error('Project not found'), '');
      return;
    }
    removeExistingRawVideo(id);
    cb(null, inputDir(id));
  },
  filename: (_req, file, cb) => {
    cb(null, `raw_video${path.extname(file.originalname) || '.mp4'}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('video/')),
});

export const videoRouter = Router();

videoRouter.post('/projects/:id/video', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'video file is required (field name "video")' });
    res.status(201).json({ url: `/projects/${req.params.id}/video` });
  });
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
  res.sendFile(file);
});

videoRouter.post('/projects/:id/images', async (req, res) => {
  const { prompt } = req.body as { prompt?: string };
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  try {
    const { file, relativePath } = await generateImage(req.params.id, prompt);
    res.status(201).json({ file, relativePath, url: `/projects/${req.params.id}/assets/${file}` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
