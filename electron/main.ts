import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, utilityProcess } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, UtilityProcess, WebContents } from "electron";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { registerModelSettingsIPC } from "./model-settings-ipc";
import { attachWorkspace, registerWorkspaceIPC } from "./workspace-ipc";
import { recordCancel, recordEvent, recordStart, registerHistoryIPC } from "./history-ipc";
import { registerConnectionsIPC, resolveConnection } from "./connections-ipc";
import { answerAttachment, registerAttachmentsIPC } from "./attachments-ipc";
import { registerHfTokenIPC } from "./hf-token";
import { registerFileUndoIPC, routeFileUndo } from "./file-undo-ipc";
import { answerTranscription, audioOnly, failTranscriptions, registerVoiceIPC } from "./voice-ipc";
import { configureIdentity } from "./identity";
import { registerExportIPC } from "./export-ipc";
import { registerTerminalIPC, stopTerminals, terminalsRunning } from "./terminal-ipc";
import type { ChatEvent, ChatNotice, CompactEvent, CompactResult, TitleEvent } from "../src/lib/desktop";
import { IMAGE_SIDE } from "../src/lib/attachments";
import type { AttachmentAsk } from "../src/harness/attachments";

const identity = configureIdentity(app);
protocol.registerSchemesAsPrivileged([{ scheme: "endurance", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const clients = new Map<string, WebContents>();
/** /compact requests waiting for the worker, with the window that asked. */
const compactions = new Map<string, { owner: WebContents; resolve: (result: CompactResult) => void; reject: (error: Error) => void }>();
/** Chat names the worker is writing (harness/title), by request. Each settles with a name or none. */
const titles = new Map<string, { owner: WebContents; resolve: (title: string | undefined) => void }>();
let worker: UtilityProcess | undefined;
/** The chats on screen, as the window last said; a worker started later is told at once. */
let visibleChats: string[] = [];
let mainWindow: BrowserWindow | undefined;
const devURL = process.env.ELECTRON_RENDERER_URL;

function trusted(event: IpcMainInvokeEvent | IpcMainEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) throw new Error("Unsupported frame");
  const url = new URL(frame.url);
  if (!(url.protocol === "endurance:" && url.hostname === "app") && !(devURL && url.origin === new URL(devURL).origin)) throw new Error("Unsupported origin");
}
function engine() {
  if (worker) return worker;
  // The worker keeps what it measures about runtimes (such as Ollama's parallel requests) in the app's data folder.
  const child = utilityProcess.fork(join(import.meta.dirname, "worker.js"), [], { serviceName: "Endurance local chat", stdio: "pipe", env: { ...process.env, ENDURANCE_STATE_DIR: app.getPath("userData") } });
  child.on("message", (event: ChatEvent | CompactEvent | TitleEvent | AttachmentAsk) => {
    // The worker asks for attached documents here: only this process holds the key that opens them.
    if (event.type === "attachment") { void answerAttachment(event).then((answer) => child.postMessage(answer)); return; }
    if (answerTranscription(event)) return;
    // Copies of files from before the agent's edits, and undoing those edits (file-undo-ipc).
    if (routeFileUndo(event, child)) return;
    const title = titles.get(event.id);
    if (title) {
      titles.delete(event.id);
      title.resolve(event.type === "titled" ? event.title : undefined);
      return;
    }
    if (event.type === "titled") return;
    const compaction = compactions.get(event.id);
    if (compaction) {
      compactions.delete(event.id);
      if (event.type === "compacted") compaction.resolve(event.result);
      else if (event.type === "error") compaction.reject(new Error(event.message));
      return;
    }
    if (event.type === "compacted") return;
    recordEvent(event);
    const owner = clients.get(event.id);
    if (owner && !owner.isDestroyed()) owner.send("chat:event", event);
    if (event.type === "done" || event.type === "error") clients.delete(event.id);
  });
  child.once("exit", () => {
    worker = undefined;
    for (const [id, owner] of clients) {
      const message = "The local chat process stopped. Retry to reconnect.";
      recordEvent({ id, type: "error", message });
      if (!owner.isDestroyed()) owner.send("chat:event", { id, type: "error", message });
    }
    clients.clear();
    for (const compaction of compactions.values()) compaction.reject(new Error("The local chat process stopped. Try /compact again."));
    compactions.clear();
    for (const title of titles.values()) title.resolve(undefined);
    titles.clear();
    failTranscriptions();
  });
  // Never log request bodies or runtime credentials.
  child.stderr?.on("data", () => {});
  worker = child;
  child.postMessage({ type: "visible", ids: visibleChats });
  return child;
}
/**
 * Images are made ready when they are sent (src/lib/prepare-image), so this only shrinks large ones kept by chats from
 * before that, to the same side. nativeImage reads PNG and JPEG only; any other format is left as it is, and the chat
 * worker sends a note in its place when it is not one runtimes take (harness/chat toMessages).
 */
function prepareImages(request: Record<string, unknown>) {
  if (!Array.isArray(request.messages)) return;
  for (const message of request.messages as { parts?: { type?: string; mediaType?: string; url?: string }[] }[])
    for (const part of message.parts ?? []) {
      if (part.type !== "file" || !part.mediaType?.startsWith("image/") || !part.url?.startsWith("data:")) continue;
      const image = nativeImage.createFromDataURL(part.url);
      if (image.isEmpty()) continue;
      const { width, height } = image.getSize();
      if (Math.max(width, height) <= IMAGE_SIDE) continue;
      const scale = IMAGE_SIDE / Math.max(width, height);
      const resized = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" });
      // A PNG may be transparent, which JPEG would turn black.
      const png = part.mediaType === "image/png";
      part.url = png ? resized.toDataURL() : `data:image/jpeg;base64,${resized.toJPEG(85).toString("base64")}`;
      part.mediaType = png ? "image/png" : "image/jpeg";
    }
}
function cancelOwned(owner: WebContents) {
  for (const [id, client] of clients) if (client === owner) { worker?.postMessage({ id, type: "cancel" }); recordCancel(id); clients.delete(id); }
  for (const [id, compaction] of compactions)
    if (compaction.owner === owner) { worker?.postMessage({ id, type: "cancel" }); compaction.reject(new Error("Cancelled")); compactions.delete(id); }
  for (const [id, title] of titles)
    if (title.owner === owner) { worker?.postMessage({ id, type: "cancel" }); title.resolve(undefined); titles.delete(id); }
}
/**
 * The renderer names a connection; its address, secrets and location come from the saved copy.
 * Folder access and skill text are removed here and only ever filled in by this process.
 * A saved plain http:// address to another computer throws the HTTPS refusal, so nothing is sent to it.
 */
function resolveRuntime(request: Record<string, unknown>) {
  const connectionId = typeof request.connectionId === "string" ? request.connectionId : typeof request.runtime === "string" ? request.runtime : "";
  const resolved = resolveConnection(connectionId);
  if (!resolved) throw new Error("This model's server is no longer listed. Choose another model.");
  Object.assign(request, { connectionId, runtime: resolved.runtime, connection: resolved.value, location: resolved.location, host: resolved.host });
  // The model that reads scanned pages is named the same way; one no longer listed is dropped, and chats go on without it.
  // One at a plain http:// address to another computer throws the HTTPS refusal like the chat's own server,
  // so pages are not skipped without a word.
  const reader = request.reader as Record<string, unknown> | undefined;
  if (reader && typeof reader === "object") {
    const found = typeof reader.connectionId === "string" && typeof reader.runtimeModelId === "string" ? resolveConnection(reader.connectionId) : undefined;
    if (found) Object.assign(reader, { runtime: found.runtime, connection: found.value });
    else delete request.reader;
  }
}
async function openWindow() {
  let bounds: { width?: number; height?: number; x?: number; y?: number } = {};
  try { bounds = JSON.parse(readFileSync(join(app.getPath("userData"), "window.json"), "utf8")); } catch { /* First launch. */ }
  const window = new BrowserWindow({
    width: bounds.width ?? 1360, height: bounds.height ?? 900, x: bounds.x, y: bounds.y,
    minWidth: 960, minHeight: 640, show: false, title: identity.name, backgroundColor: "#1b1b1b",
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 14 },
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  mainWindow = window;
  window.on("page-title-updated", (event) => { event.preventDefault(); window.setTitle(identity.name); });
  window.once("ready-to-show", () => window.show());
  window.on("close", () => {
    if (!window.isMaximized() && !window.isFullScreen()) writeFileSync(join(app.getPath("userData"), "window.json"), JSON.stringify(window.getBounds()));
    cancelOwned(window.webContents);
  });
  window.webContents.on("render-process-gone", () => cancelOwned(window.webContents));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The app's own window may use the microphone (voice input) and write to the clipboard (copy buttons).
  // Reading the clipboard and everything else stays denied.
  const allowed = new Set(["media", "clipboard-sanitized-write"]);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window.webContents && allowed.has(permission) && (permission !== "media" || audioOnly(details))));
  if (devURL) await window.loadURL(devURL);
  else await window.loadURL("endurance://app/index.html");
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.show(); });
  app.whenReady().then(async () => {
    const renderer = resolve(import.meta.dirname, "../renderer");
    protocol.handle("endurance", async (request) => {
      const url = new URL(request.url);
      const file = resolve(renderer, "." + decodeURIComponent(url.pathname));
      if (url.host !== "app" || !file.startsWith(renderer + sep)) return new Response("Not found", { status: 404 });
      const response = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; connect-src 'self' blob: data:; media-src 'self' blob: data:; frame-src https: http: about: blob:");
      return new Response(response.body, { status: response.status, headers });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
    registerConnectionsIPC(trusted);
    ipcMain.handle("chat:start", async (event, id: string, body: string) => {
      trusted(event);
      if (typeof id !== "string" || !/^[a-z0-9-]{1,80}$/i.test(id) || typeof body !== "string" || body.length > 32 * 1024 * 1024 || clients.has(id)) throw new Error("Invalid chat request");
      clients.set(id, event.sender);
      try {
        const request = JSON.parse(body) as Record<string, unknown>;
        // Folder access and skill text come from this process, never from the renderer request.
        if (request.runtime || request.connectionId) {
          resolveRuntime(request);
          await attachWorkspace(request);
          prepareImages(request);
          recordStart(id, request);
        }
        engine().postMessage({ id, type: "chat", body: JSON.stringify(request) });
      } catch (error) { clients.delete(id); throw error; }
    });
    // /compact for a runtime model: the worker summarizes with the chat's own model and returns the summary.
    ipcMain.handle("chat:compact", async (event, body: string) => {
      trusted(event);
      if (typeof body !== "string" || body.length > 32 * 1024 * 1024) throw new Error("Invalid compaction request");
      const request = JSON.parse(body) as Record<string, unknown>;
      if (!request.runtime && !request.connectionId) throw new Error("Only local runtime models can compact a conversation.");
      for (const key of ["workspace", "skills", "skillCatalog", "projectInstructions"]) delete request[key];
      resolveRuntime(request);
      const id = crypto.randomUUID();
      const result = new Promise<CompactResult>((resolve, reject) => compactions.set(id, { owner: event.sender, resolve, reject }));
      engine().postMessage({ id, type: "compact", body: JSON.stringify(request) });
      return result;
    });
    ipcMain.on("chat:visible", (event, ids: unknown) => {
      trusted(event);
      if (!Array.isArray(ids) || ids.length > 8 || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) return;
      visibleChats = ids;
      worker?.postMessage({ type: "visible", ids });
    });
    // A chat's name from its own model, after its first reply. Only the chat's connection is used; folders,
    // skills and project instructions are not sent.
    ipcMain.handle("chat:title", async (event, body: string) => {
      trusted(event);
      if (typeof body !== "string" || body.length > 4 * 1024 * 1024) throw new Error("Invalid title request");
      const request = JSON.parse(body) as Record<string, unknown>;
      if (!request.runtime && !request.connectionId) return undefined;
      for (const key of ["workspace", "skills", "skillCatalog", "projectInstructions"]) delete request[key];
      resolveRuntime(request);
      const id = crypto.randomUUID();
      const result = new Promise<string | undefined>((resolve) => titles.set(id, { owner: event.sender, resolve }));
      engine().postMessage({ id, type: "title", body: JSON.stringify(request) });
      return result;
    });
    // Notifications only while the window is in the background; in front, the chat itself shows what happened.
    ipcMain.on("chat:notify", (event, notice: ChatNotice) => {
      trusted(event);
      if (!Notification.isSupported() || !mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
      if (typeof notice?.chatId !== "string" || typeof notice.title !== "string" || typeof notice.body !== "string") return;
      const shown = new Notification({ title: notice.title.slice(0, 120), body: notice.body.slice(0, 200), silent: notice.sound !== true });
      shown.on("click", () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send("chat:open", notice.chatId);
      });
      shown.show();
    });
    ipcMain.on("chat:cancel", (event, id: string) => {
      trusted(event);
      if (clients.get(id) !== event.sender) return;
      worker?.postMessage({ id, type: "cancel" }); recordCancel(id); clients.delete(id);
    });
    registerModelSettingsIPC(trusted, () => {
      if (clients.size || compactions.size) throw new Error("Stop active generations before changing runtime models.");
    }, resolveConnection);
    registerWorkspaceIPC(trusted, () => resolveConnection("ollama")?.value);
    registerHistoryIPC(trusted, () => {
      if (clients.size || compactions.size) throw new Error("Stop active replies before changing the key.");
    });
    registerAttachmentsIPC(trusted);
    registerFileUndoIPC(trusted, engine);
    registerHfTokenIPC(trusted);
    registerVoiceIPC(trusted, engine);
    registerExportIPC(trusted);
    registerTerminalIPC(trusted);
    await openWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void openWindow(); });
  });
  // Quitting asks the worker to end its running commands first (they are detached and would outlive it), then ends it.
  // The terminal process ends the person's shells at the same time (terminal-ipc).
  let quitting = false;
  app.on("before-quit", (event) => {
    const child = worker;
    if ((!child && !terminalsRunning()) || quitting) return;
    quitting = true;
    event.preventDefault();
    const chats = new Promise<void>((done) => {
      if (!child) return done();
      const timer = setTimeout(() => { child.kill(); done(); }, 1500);
      child.once("exit", () => { clearTimeout(timer); done(); });
      child.postMessage({ type: "shutdown" });
    });
    void Promise.all([chats, stopTerminals()]).then(() => app.quit());
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
