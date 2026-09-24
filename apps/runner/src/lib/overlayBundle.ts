import path from 'node:path';
import * as esbuild from 'esbuild';
import { projectDir, NODE_MODULES_DIR } from './paths.js';

// Packages the editor already contains. The generated overlay must use the editor's own copies:
// a second copy of react or remotion would have its own contexts, so hooks like useCurrentFrame
// would find no Player around them. The editor publishes them on window.__MANGO_SHARED__.
const SHARED = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'remotion', '@mangoai/remotion-overlay']);

const sharedPlugin: esbuild.Plugin = {
  name: 'mango-shared',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (SHARED.has(args.path)) return { path: args.path, namespace: 'mango-shared' };
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: 'mango-shared' }, (args) => ({
      contents: `module.exports = window.__MANGO_SHARED__[${JSON.stringify(args.path)}];`,
      loader: 'js',
    }));
  },
};

export interface OverlayBundle {
  code: string;
}

// Bundles a project's generated CustomOverlay.tsx into one ES module for the editor's live preview.
// This replaces loading the file through the Vite dev server, which does not exist in the
// installed app. Everything except the shared packages is bundled from disk, so imports such as
// other @remotion/* packages keep working.
export async function bundleOverlay(projectId: string): Promise<OverlayBundle> {
  const entry = path.join(projectDir(projectId), '03_remotion_code', 'CustomOverlay.tsx');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    logLevel: 'silent',
    sourcemap: 'inline',
    nodePaths: [NODE_MODULES_DIR],
    plugins: [sharedPlugin],
    // Some remotion sub-packages check for these at load time.
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  return { code: result.outputFiles[0].text };
}
