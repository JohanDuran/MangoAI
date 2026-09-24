// The bridge the desktop app exposes to the editor (see apps/desktop/src/preload.ts). Absent when the
// editor runs in a normal browser during development.
export interface DesktopInfo {
  version: string;
  platform: string;
  projectsDir: string;
  logsDir: string;
  secureStorage: boolean;
  hasOpenAIKey: boolean;
}

export interface DesktopApi {
  info(): Promise<DesktopInfo>;
  setOpenAIKey(key: string): Promise<{ ok: boolean; validated?: boolean; error?: string }>;
  clearOpenAIKey(): Promise<{ ok: boolean }>;
  openFolder(which: 'logs' | 'projects'): Promise<void>;
  showInFolder(file: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  exportDiagnostics(): Promise<{ saved: boolean; file?: string }>;
  onOpenStatus(callback: () => void): () => void;
}

declare global {
  interface Window {
    mangoDesktop?: DesktopApi;
  }
}

export const desktop = (): DesktopApi | undefined => window.mangoDesktop;
