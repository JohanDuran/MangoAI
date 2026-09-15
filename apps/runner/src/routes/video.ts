import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { inputDir } from '../lib/paths.js';
import { readProject } from '../lib/scaffold.js';
import { findRawVideo, removeExistingRawVideo } from '../lib/video.js';
import { updateCompositionConfig } from '../lib/composition.js';

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
  const { durationInFrames } = req.body as { durationInFrames?: number };
  if (!durationInFrames || durationInFrames <= 0) {
    return res.status(400).json({ error: 'durationInFrames must be a positive number' });
  }
  res.json(updateCompositionConfig(req.params.id, { durationInFrames }));
});
