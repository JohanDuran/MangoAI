import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';

// Single choke point for "text prompt -> image file on disk". Swapping providers later
// (Stability, Replicate, etc.) means changing the body of this function only — nothing
// that calls it needs to know which provider produced the file.
async function generateImageBytes(prompt: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set on the server');

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI image generation failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data returned');
  return Buffer.from(b64, 'base64');
}

interface AssetManifestEntry {
  file: string;
  prompt: string;
  createdAt: string;
}

export async function generateImage(id: string, prompt: string): Promise<{ file: string; relativePath: string }> {
  const bytes = await generateImageBytes(prompt);
  const assetsDir = path.join(projectDir(id), '02_assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const file = `img_${Date.now()}.png`;
  fs.writeFileSync(path.join(assetsDir, file), bytes);

  const manifestFile = path.join(assetsDir, 'asset_manifest.json');
  const manifest: AssetManifestEntry[] = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, 'utf-8'))
    : [];
  manifest.push({ file, prompt, createdAt: new Date().toISOString() });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  return { file, relativePath: `02_assets/${file}` };
}

export function assetFilePath(id: string, filename: string): string {
  return path.join(projectDir(id), '02_assets', filename);
}
