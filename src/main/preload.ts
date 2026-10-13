import { contextBridge, ipcRenderer } from "electron";
import type { Bridge, Snapshot } from "../shared/types";
const bridge: Bridge = {
  snapshot: () => ipcRenderer.invoke("relay:command", "snapshot"),
  command: (name, args) => ipcRenderer.invoke("relay:command", name, args),
  onSnapshot: (fn) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Snapshot) =>
      fn(value);
    ipcRenderer.on("relay:snapshot", listener);
    return () => ipcRenderer.removeListener("relay:snapshot", listener);
  },
};
contextBridge.exposeInMainWorld("relay", bridge);
