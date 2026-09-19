import path from 'node:path';
import { projectDir } from './paths.js';

// Assets (generated images and anything dropped in manually) live in 02_assets and are served
// over HTTP by the assets route. Generating them is the job of skills, e.g. image-generation.
export function assetFilePath(id: string, filename: string): string {
  return path.join(projectDir(id), '02_assets', filename);
}
