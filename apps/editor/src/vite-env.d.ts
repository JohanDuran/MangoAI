/// <reference types="vite/client" />

interface Window {
  // Modules the runner-bundled overlay code shares with the editor (see overlayBundle.ts in the runner).
  __MANGO_SHARED__?: Record<string, unknown>;
}
