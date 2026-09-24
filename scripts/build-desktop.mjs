// Bundles the Electron main process and preload script into apps/desktop/dist.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = createRequire(path.join(root, 'package.json'))('esbuild');
const src = path.join(root, 'apps/desktop/src');
const dist = path.join(root, 'apps/desktop/dist');

for (const [entry, out] of [['main.ts', 'main.cjs'], ['preload.ts', 'preload.cjs']]) {
  await esbuild.build({
    entryPoints: [path.join(src, entry)],
    outfile: path.join(dist, out),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
}
console.log('[desktop] built main.cjs and preload.cjs');
