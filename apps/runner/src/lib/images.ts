import path from 'node:path';
import { projectDir } from './paths.js';

// Assets (generated images and anything dropped in manually) live in 02_assets and are served
// over HTTP by the assets route. Generating them is the job of skills, e.g. image-generation.
export function assetFilePath(id: string, filename: string): string {
  // Only a plain file name is allowed: no separators, so the result can never leave 02_assets.
  if (!filename || filename !== path.basename(filename) || /[\\/]/.test(filename) || filename.startsWith('.')) {
    throw new Error('Invalid asset file name');
  }
  return path.join(projectDir(id), '02_assets', filename);
}
