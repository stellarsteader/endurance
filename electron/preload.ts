import { contextBridge, ipcRenderer } from "electron";
import { installModelSettingsBridge } from "./model-settings-preload";
import { installWorkspaceBridge } from "./workspace-preload";
import { installHistoryBridge } from "./history-preload";
import { installVoiceBridge } from "./voice-preload";
import { installTerminalBridge } from "./terminal-preload";
import type { CatalogResult, ChatEvent, DesktopAPI } from "../src/lib/desktop";
import type { ConnectionView } from "../src/lib/connections";

function subscribe<T>(channel: string, listener: (value: T) => void) {
  const receive = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => {
    ipcRenderer.removeListener(channel, receive);
  };
}

const api: DesktopAPI = {
  platform: process.platform,
  connections: (legacy) => ipcRenderer.invoke("connections:list", legacy),
  onConnections: (listener) => subscribe<ConnectionView[]>("connections:changed", listener),
  catalog: (connectionId) => ipcRenderer.invoke("connections:catalog", connectionId),
  onCatalog: (listener) => subscribe<CatalogResult[]>("catalog:changed", listener),
  detect: () => ipcRenderer.invoke("connections:detect"),
  addRuntime: (id) => ipcRenderer.invoke("connections:add-runtime", id),
  checkServer: (draft) => ipcRenderer.invoke("connections:check-server", draft),
  addServer: (draft) => ipcRenderer.invoke("connections:add-server", draft),
  updateConnection: (id, edit) => ipcRenderer.invoke("connections:update", id, edit),
  reorderConnections: (ids) => ipcRenderer.invoke("connections:reorder", ids),
  serverInfo: (id) => ipcRenderer.invoke("connections:server-info", id),
  removeConnection: (id) => ipcRenderer.invoke("connections:remove", id),
  testConnection: (id, test) => ipcRenderer.invoke("connections:test", id, test),
  startChat: (id, body) => ipcRenderer.invoke("chat:start", id, body),
  cancelChat: (id) => ipcRenderer.send("chat:cancel", id),
  showChats: (ids) => ipcRenderer.send("chat:visible", ids),
  compactChat: (body) => ipcRenderer.invoke("chat:compact", body),
  undoEdits: (chatId, projectId, files) => ipcRenderer.invoke("chat:undo-edits", chatId, projectId, files),
  saveAttachment: (name, mediaType, data) => ipcRenderer.invoke("attachments:save", name, mediaType, data),
  convertImage: (data) => ipcRenderer.invoke("attachments:convert-image", data),
  readAttachment: (id) => ipcRenderer.invoke("attachments:read", id),
  readAttachmentText: (id) => ipcRenderer.invoke("attachments:read-text", id),
  saveAttachmentCopy: (id, filename) => ipcRenderer.invoke("attachments:save-copy", id, filename),
  exportChat: (filename, format, text) => ipcRenderer.invoke("chat:export", filename, format, text),
  onChatEvent: (listener) => subscribe<ChatEvent>("chat:event", listener),
  titleChat: (body) => ipcRenderer.invoke("chat:title", body),
  notify: (notice) => ipcRenderer.send("chat:notify", notice),
  onOpenChat: (listener) => subscribe<string>("chat:open", listener),
};
contextBridge.exposeInMainWorld("endurance", api);
installModelSettingsBridge();
installWorkspaceBridge();
installHistoryBridge();
installVoiceBridge();
installTerminalBridge();
