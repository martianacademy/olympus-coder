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
  on: (fn: Listener) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
});
