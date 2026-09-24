import { contextBridge, ipcRenderer } from 'electron';

// The only things the editor page can ask the desktop app to do. Every call is checked again in the
// main process, which also confirms the request comes from the editor's own address.
contextBridge.exposeInMainWorld('mangoDesktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  setOpenAIKey: (key: string) => ipcRenderer.invoke('desktop:set-openai-key', key),
  clearOpenAIKey: () => ipcRenderer.invoke('desktop:clear-openai-key'),
  openFolder: (which: 'logs' | 'projects') => ipcRenderer.invoke('desktop:open-folder', which),
  showInFolder: (file: string) => ipcRenderer.invoke('desktop:show-in-folder', file),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url),
  exportDiagnostics: () => ipcRenderer.invoke('desktop:export-diagnostics'),
  onOpenStatus: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('desktop:open-status', listener);
    return () => ipcRenderer.removeListener('desktop:open-status', listener);
  },
});
