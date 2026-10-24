import { contextBridge, ipcRenderer } from "electron";
import type {
  ModelDownload,
  ModelSettingsAPI,
} from "../src/features/model-settings/types";
export function installModelSettingsBridge() {
  const api: ModelSettingsAPI = {
    details: (target, modelId) =>
      ipcRenderer.invoke("models:details", target, modelId),
    mutate: (target, modelId, action, context) =>
      ipcRenderer.invoke("models:mutate", target, modelId, action, context),
    searchHuggingFace: (id, query) =>
      ipcRenderer.invoke("models:hf-search", id, query),
    downloadHuggingFace: (id, input, display) =>
      ipcRenderer.invoke("models:hf-download", id, input, display),
    lookupOllama: (id, query, target) =>
      ipcRenderer.invoke("models:ollama-lookup", id, query, target),
    pullOllama: (id, input, display) =>
      ipcRenderer.invoke("models:ollama-pull", id, input, display),
    cancel: (id) => ipcRenderer.send("models:cancel", id),
    downloads: () => ipcRenderer.invoke("models:downloads"),
    dismissDownload: (id) => ipcRenderer.send("models:download-dismiss", id),
    manager: {
      info: (target) => ipcRenderer.invoke("manager:info", target),
      models: (target) => ipcRenderer.invoke("manager:models", target),
      plan: (target, model, window) => ipcRenderer.invoke("manager:plan", target, model, window),
      start: (target, model, options) => ipcRenderer.invoke("manager:start", target, model, options),
      stop: (target, model) => ipcRenderer.invoke("manager:stop", target, model),
      remove: (target, model) => ipcRenderer.invoke("manager:delete", target, model),
      logs: (target, model) => ipcRenderer.invoke("manager:logs", target, model),
      download: (target, model) => ipcRenderer.invoke("manager:download", target, model),
      downloads: (target) => ipcRenderer.invoke("manager:downloads", target),
    },
    hfToken: {
      status: () => ipcRenderer.invoke("hf:token-status"),
      save: (value) => ipcRenderer.invoke("hf:token-save", value),
    },
    onDownloads: (listener) => {
      const receive = (
        _event: Electron.IpcRendererEvent,
        downloads: ModelDownload[],
      ) => listener(downloads);
      ipcRenderer.on("models:downloads", receive);
      return () => ipcRenderer.removeListener("models:downloads", receive);
    },
  };
  contextBridge.exposeInMainWorld("enduranceModels", api);
}
