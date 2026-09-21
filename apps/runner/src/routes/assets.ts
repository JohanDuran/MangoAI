import { Router } from 'express';
import multer from 'multer';
import { readProject, setAutoDescribeImages } from '../lib/scaffold.js';
import {
  MAX_ASSET_BYTES,
  addUploadedAsset,
  deleteAsset,
  describeAsset,
  findAsset,
  markersUsingAsset,
  readAssets,
  updateAsset,
} from '../lib/assets.js';
import { log } from '../lib/log.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ASSET_BYTES, files: 1 } });

export const assetsRouter = Router();

assetsRouter.get('/projects/:id/assets', (req, res) => {
  if (!readProject(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(readAssets(req.params.id));
});

assetsRouter.post('/projects/:id/assets', (req, res) => {
  const { id } = req.params;
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'image file is required (field name "image")' });
    try {
      const asset = await addUploadedAsset(id, { buffer: req.file.buffer, originalName: req.file.originalname });
      log('info', 'asset.upload', { project: id, asset: asset.id, bytes: asset.bytes, size: `${asset.width}x${asset.height}` });
      res.status(201).json(asset);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
});

assetsRouter.patch('/projects/:id/assets/:assetId', (req, res) => {
  const { id, assetId } = req.params;
  if (!findAsset(id, assetId)) return res.status(404).json({ error: 'not found' });
  const { name, description } = req.body as { name?: unknown; description?: unknown };
  if ((name !== undefined && typeof name !== 'string') || (description !== undefined && typeof description !== 'string')) {
    return res.status(400).json({ error: 'name and description must be strings' });
  }
  res.json(updateAsset(id, assetId, { name: name as string | undefined, description: description as string | undefined }));
});

// Deleting an image that markers use is refused unless ?force=1, in which case it is detached from them.
assetsRouter.delete('/projects/:id/assets/:assetId', (req, res) => {
  const { id, assetId } = req.params;
  if (!findAsset(id, assetId)) return res.status(404).json({ error: 'not found' });
  const used = markersUsingAsset(id, assetId).map((m) => m.marker_id);
  if (used.length > 0 && req.query.force !== '1') {
    return res.status(409).json({ error: 'Image is attached to markers', markers: used });
  }
  deleteAsset(id, assetId);
  log('info', 'asset.delete', { project: id, asset: assetId, detachedFrom: used });
  res.status(204).end();
});

// Has Claude write the image's description. Replaces an existing description only with ?overwrite=1.
assetsRouter.post('/projects/:id/assets/:assetId/describe', async (req, res) => {
  const { id, assetId } = req.params;
  if (!findAsset(id, assetId)) return res.status(404).json({ error: 'not found' });
  try {
    res.json(await describeAsset(id, assetId, { overwrite: req.query.overwrite === '1' }));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

assetsRouter.put('/projects/:id/asset-settings', (req, res) => {
  const { id } = req.params;
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  const { autoDescribe } = req.body as { autoDescribe?: unknown };
  if (typeof autoDescribe !== 'boolean') return res.status(400).json({ error: 'autoDescribe must be true or false' });
  setAutoDescribeImages(id, autoDescribe);
  res.json({ autoDescribe });
});
