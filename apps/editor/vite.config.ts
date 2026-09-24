import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The installed app loads the editor from the runner at its own address, so asset URLs are relative.
  base: './',
  build: { chunkSizeWarningLimit: 2500 },
});
