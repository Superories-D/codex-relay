import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Bridge, Snapshot } from "../shared/types";
const bridge: Bridge = {
  onOpenJob: (fn) => {
    const listener = (_event: Electron.IpcRendererEvent, id:string) => fn(id);
    ipcRenderer.on("relay:open-job",listener);
    return () => ipcRenderer.removeListener("relay:open-job",listener);
  },
  filePath: (file) => webUtils.getPathForFile(file),
  snapshot: () => ipcRenderer.invoke("relay:command", "snapshot"),
  command: (name, args) => ipcRenderer.invoke("relay:command", name, args),
  onSnapshot: (fn) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Snapshot) =>
      fn(value);
    ipcRenderer.on("relay:snapshot", listener);
    return () => ipcRenderer.removeListener("relay:snapshot", listener);
  },
  onCatalogLogin: (fn) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      value: import("../shared/types").CatalogLoginUpdate,
    ) => fn(value);
    ipcRenderer.on("relay:catalog-login", listener);
    return () => ipcRenderer.removeListener("relay:catalog-login", listener);
  },
  onChat: (fn) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      value: { id: string; page: import("../shared/types").ChatPage },
    ) => fn(value);
    ipcRenderer.on("relay:chat", listener);
    return () => ipcRenderer.removeListener("relay:chat", listener);
  },
};
contextBridge.exposeInMainWorld("relay", bridge);
