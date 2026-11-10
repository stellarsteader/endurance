import { contextBridge, ipcRenderer } from "electron";
import type { UpdateState, UpdatesAPI } from "../src/lib/updates-api";

export function installUpdatesBridge() {
  const api: UpdatesAPI = {
    version: () => ipcRenderer.invoke("updates:version"),
    state: () => ipcRenderer.invoke("updates:state"),
    onState: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
      ipcRenderer.on("updates:state", receive);
      return () => {
        ipcRenderer.removeListener("updates:state", receive);
      };
    },
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.send("updates:install"),
    openRelease: () => ipcRenderer.send("updates:open-release"),
  };
  contextBridge.exposeInMainWorld("enduranceUpdates", api);
}
