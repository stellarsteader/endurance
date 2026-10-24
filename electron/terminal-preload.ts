import { contextBridge, ipcRenderer } from "electron";
import type { TerminalAPI, TerminalEvent } from "../src/lib/terminal-api";

/** The person's terminal (terminal-ipc). Only on macOS, where its sandbox is; elsewhere the Shell view is not shown. */
export function installTerminalBridge() {
  if (process.platform !== "darwin") return;
  const api: TerminalAPI = {
    access: (projectId) => ipcRenderer.invoke("terminal:access", projectId),
    requestFullAccess: (projectId) => ipcRenderer.invoke("terminal:request-full-access", projectId),
    useSandbox: (projectId) => ipcRenderer.invoke("terminal:use-sandbox", projectId),
    list: (projectId) => ipcRenderer.invoke("terminal:list", projectId),
    open: (projectId, options) => ipcRenderer.invoke("terminal:open", projectId, options),
    attach: (id) => ipcRenderer.invoke("terminal:attach", id),
    detach: (id) => ipcRenderer.send("terminal:detach", id),
    write: (id, data) => ipcRenderer.send("terminal:write", id, data),
    resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", id, cols, rows),
    ack: (id, bytes) => ipcRenderer.send("terminal:ack", id, bytes),
    close: (id) => ipcRenderer.invoke("terminal:close", id),
    onEvent: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, value: TerminalEvent) => listener(value);
      ipcRenderer.on("terminal:event", receive);
      return () => {
        ipcRenderer.removeListener("terminal:event", receive);
      };
    },
  };
  contextBridge.exposeInMainWorld("enduranceTerminal", api);
}
