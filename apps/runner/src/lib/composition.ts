import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';

export interface CompositionConfig {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  // Address of the runner serving this project's images; kept in sync by syncAssetModule.
  runnerUrl?: string;
}

const configFile = (id: string) => path.join(projectDir(id), '03_remotion_code', 'CompositionConfig.json');

export function readCompositionConfig(id: string): CompositionConfig {
  return JSON.parse(fs.readFileSync(configFile(id), 'utf-8'));
}

export function updateCompositionConfig(
  id: string,
  patch: Partial<CompositionConfig>
): CompositionConfig {
  const next = { ...readCompositionConfig(id), ...patch };
  fs.writeFileSync(configFile(id), JSON.stringify(next, null, 2));
  return next;
}
