import { contextBridge, ipcRenderer } from "electron";
import type { HistoryAPI, VaultProgress } from "../src/lib/history-api";

export function installHistoryBridge() {
  const api: HistoryAPI = {
    sessions: () => ipcRenderer.invoke("history:sessions"),
    messages: (id) => ipcRenderer.invoke("history:messages", id),
    saveSession: (session) => ipcRenderer.invoke("history:save-session", session),
    deleteSession: (id) => ipcRenderer.invoke("history:delete-session", id),
    requests: () => ipcRenderer.invoke("history:requests"),
    deleteRequest: (id) => ipcRenderer.invoke("history:delete-request", id),
    clearRequests: () => ipcRenderer.invoke("history:clear-requests"),
    settings: () => ipcRenderer.invoke("history:settings"),
    setSettings: (value) => ipcRenderer.invoke("history:set-settings", value),
    vault: () => ipcRenderer.invoke("vault:status"),
    retryVault: () => ipcRenderer.invoke("vault:retry"),
    recoverVault: (recoveryKey) => ipcRenderer.invoke("vault:recover", recoveryKey),
    newRecoveryKey: () => ipcRenderer.invoke("vault:recovery-key"),
    rotateKey: () => ipcRenderer.invoke("vault:rotate"),
    startOver: () => ipcRenderer.invoke("vault:start-over"),
    onVaultProgress: (listener) => {
      const forward = (_event: Electron.IpcRendererEvent, progress: VaultProgress) => listener({ stage: progress.stage, done: progress.done, total: progress.total });
      ipcRenderer.on("vault:progress", forward);
      return () => ipcRenderer.removeListener("vault:progress", forward);
    },
  };
  contextBridge.exposeInMainWorld("enduranceHistory", api);
}
