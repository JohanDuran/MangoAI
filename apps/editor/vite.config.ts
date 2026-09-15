import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The editor dynamically imports each project's generated CustomOverlay.tsx, which lives
// outside apps/editor (in apps/runner/proyectos/<id>/). Vite must be allowed to serve and
// watch that directory for hot-reload to work across the app boundary.
const projectsAbsPath = path.resolve(__dirname, '..', 'runner', 'proyectos').replace(/\\/g, '/');

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..', 'runner', 'proyectos'), path.resolve(__dirname)],
    },
  },
  // Exposed so the editor can build /@fs/<abs-path> URLs at runtime to dynamically import a
  // project's generated overlay — see DualLayerPreview.tsx for why this can't be a static
  // import.meta.glob (projects/markers are created after the dev server starts).
  define: {
    __PROJECTS_ABS_PATH__: JSON.stringify(projectsAbsPath),
  },
});
