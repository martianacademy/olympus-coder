import { contextBridge, ipcRenderer, webUtils } from 'electron';

type Listener = (channel: string, payload: unknown) => void;
const listeners = new Set<Listener>();
ipcRenderer.on('desk:event', (_e, channel: string, payload: unknown) => {
  for (const l of listeners) l(channel, payload);
});

contextBridge.exposeInMainWorld('desk', {
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('desk:invoke', method, args),
  /** Disk path of a dropped File (empty for clipboard data). */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  /** Starts the OS's own dictation into the focused composer (src/main/dictation.ts). */
  dictate: () => ipcRenderer.invoke('desk:dictate'),
  /** Settings → Voice and the recording mic (src/main/voice). Desktop window only. */
  voice: (method: string, ...args: unknown[]) => ipcRenderer.invoke('desk:voice', method, args),
  /** Detached Workbench tool windows (src/main/panels.ts). Desktop windows only. */
  panels: (method: string, ...args: unknown[]) => ipcRenderer.invoke('desk:panels', method, args),
  on: (fn: Listener) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
});
