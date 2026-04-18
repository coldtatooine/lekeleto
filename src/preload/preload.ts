import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lekeleto", {
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
  onRenderProgress: (callback: (data: string) => void) => {
    const listener = (_: unknown, data: string) => callback(data);
    ipcRenderer.on("render:progress", listener);
    return () => ipcRenderer.removeListener("render:progress", listener);
  },
  openAssetDialog: () => ipcRenderer.invoke("assets:openDialog"),
  readAssetFile: (filePath: string) =>
    ipcRenderer.invoke("assets:readFile", { path: filePath }),
});
