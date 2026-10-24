/**
 * History IPC on the main thread. The history itself (database, attachments, the data key's use) is in the
 * history thread (./history-thread), so encrypting, key rotation and VACUUM never freeze the window; this side
 * opens the key with the system keychain (./vault-key), hands it to the thread, and forwards calls to it.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { HistoryStore } from "../src/history/store";
import { keyOf } from "../src/history/vault";
import type { ChatEvent } from "../src/lib/desktop";
import type { HistorySettings, SessionInput } from "../src/lib/history-api";
import type { HistoryMethods, HistoryProgress, HistoryResult } from "./history-thread";
import {
  attachmentsFolder,
  beginKeyRotation,
  finishKeyRotation,
  historyFile,
  lockMissing,
  newRecoveryKey,
  openVault,
  recoverVault,
  retryVault,
  startOver,
  VaultLocked,
  vaultStatus,
} from "./vault-key";

class KeyMismatch extends Error {}

let thread: Worker | undefined;
const waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
let calls = 0;
function historyThread() {
  if (thread) return thread;
  const child = new Worker(join(import.meta.dirname, "history-thread.js"));
  child.on("message", (message: HistoryResult | HistoryProgress) => {
    // Encrypting an older history or a new key: every window may be waiting on it.
    if (message.type === "progress") {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("vault:progress", message);
      return;
    }
    const waiter = waiting.get(message.call);
    waiting.delete(message.call);
    if (message.ok) waiter?.resolve(message.value as never);
    else waiter?.reject(message.mismatch ? new KeyMismatch(message.error) : new Error(message.error));
  });
  child.on("error", () => {});
  child.once("exit", () => {
    thread = undefined;
    opening = undefined;
    for (const waiter of waiting.values()) waiter.reject(new Error("The history thread stopped. Try again."));
    waiting.clear();
  });
  thread = child;
  return child;
}
function send<K extends keyof HistoryMethods>(method: K, ...args: Parameters<HistoryMethods[K]>): Promise<ReturnType<HistoryMethods[K]>> {
  const call = ++calls;
  return new Promise((resolve, reject) => {
    waiting.set(call, { resolve, reject });
    historyThread().postMessage({ call, method, args });
  });
}

let opening: Promise<void> | undefined;
let opened = false;
function open() {
  opening ??= start().catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}
async function start() {
  const file = historyFile();
  let keys = openVault();
  // A key rotation the app was stopped in: the history names the key it ended with.
  const settled = Boolean(keys.next);
  if (keys.next) keys = finishKeyRotation(HistoryStore.keyId(file) === keys.next.id);
  try {
    await send("open", { file, folder: attachmentsFolder(), key: keyOf(keys.vault), id: keys.id, settled });
  } catch (error) {
    if (!(error instanceof KeyMismatch)) throw error;
    lockMissing();
    throw new VaultLocked();
  }
  opened = true;
}

/** The history database (which also holds projects) and attached documents, through the history thread. Rejects while locked. */
export async function history<K extends keyof HistoryMethods>(method: K, ...args: Parameters<HistoryMethods[K]>) {
  await open();
  return send(method, ...args);
}

let rotating = false;
/**
 * Replaces the data key: documents are encrypted again under new names, then the history in one transaction,
 * then the old files are removed and the new key becomes the only one. Stopped at any point, the next start
 * finishes or undoes it (start). The recovery key opened only the old key, so it is dropped.
 */
async function rotateKey() {
  if (rotating) throw new Error("The key is already being changed.");
  rotating = true;
  try {
    await open();
    await rotateWith(beginKeyRotation());
  } finally {
    rotating = false;
  }
}
async function rotateWith(next: ReturnType<typeof beginKeyRotation>) {
  try {
    await send("rotate", { key: keyOf(next.vault), id: next.id });
  } catch (error) {
    // Kept only if the history was committed with the new key.
    finishKeyRotation(HistoryStore.keyId(historyFile()) === next.id);
    throw error;
  }
  finishKeyRotation(true);
}

/** The vault's state once history has been tried, so a history that belongs to another key shows as locked. */
async function status() {
  try {
    await open();
  } catch {
    /* Locked: the status says why. */
  }
  return vaultStatus();
}

interface Usage {
  input?: number;
  output?: number;
  reasoning?: number;
}
const active = new Map<string, { started: number; pending: string; usage?: Usage; error?: string }>();

/** What a kept record contains: the conversation text and attachment names, not image data. */
function contents(request: Record<string, unknown>) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  return {
    model: request.runtimeModelId,
    messages: messages.map((message: { role?: string; parts?: { type?: string; text?: string; filename?: string; mediaType?: string }[] }) => ({
      role: message.role,
      content: (message.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : part.type === "file" ? `[${part.filename ?? part.mediaType ?? "attachment"}]` : ""))
        .filter(Boolean)
        .join("\n"),
    })),
  };
}

/** Called by the chat bridge for model requests. */
export function recordStart(id: string, request: Record<string, unknown>) {
  const connection = request.connection as { baseUrl?: string } | undefined;
  let origin = "";
  try {
    origin = new URL(String(connection?.baseUrl)).origin;
  } catch {
    /* An invalid address fails the request and is recorded as an error. */
  }
  active.set(id, { started: Date.now(), pending: "" });
  // History must never block a chat.
  history("startRequest", {
    id,
    sessionId: typeof request.id === "string" ? request.id : "",
    runtime: String(request.runtime ?? ""),
    model: String(request.runtimeModelId ?? request.model ?? ""),
    origin,
    content: contents(request),
  }).catch(() => {});
}

export function recordEvent(event: ChatEvent) {
  const entry = active.get(event.id);
  if (!entry) return;
  if (event.type === "chunk") {
    entry.pending += event.chunk;
    const lines = entry.pending.split("\n");
    entry.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: {")) continue;
      try {
        const data = JSON.parse(line.slice(6)) as { type?: string; errorText?: string; messageMetadata?: { usage?: Usage } };
        if (data.type === "finish" && data.messageMetadata?.usage) entry.usage = data.messageMetadata.usage;
        if (data.type === "error") entry.error = data.errorText;
      } catch {
        /* Not a stream event. */
      }
    }
    return;
  }
  if (event.type !== "done" && event.type !== "error") return;
  active.delete(event.id);
  const cancelled = event.type === "error" && event.message === "Cancelled";
  const reason = event.type === "error" ? event.message : entry.error;
  // Keep the chat working if the history file is unavailable.
  history("finishRequest", event.id, {
    status: cancelled ? "cancelled" : reason ? "error" : "ok",
    reason: cancelled ? undefined : reason,
    usage: entry.usage,
    durationMs: Date.now() - entry.started,
  }).catch(() => {});
}

export function recordCancel(id: string) {
  recordEvent({ id, type: "error", message: "Cancelled" });
}

export function registerHistoryIPC(trusted: (event: IpcMainInvokeEvent | IpcMainEvent) => void, idle: () => void) {
  ipcMain.handle("history:sessions", (event) => {
    trusted(event);
    return history("listSessions");
  });
  ipcMain.handle("history:messages", (event, id: string) => {
    trusted(event);
    return history("messages", id);
  });
  ipcMain.handle("history:save-session", (event, session: SessionInput) => {
    trusted(event);
    return history("saveSession", session);
  });
  ipcMain.handle("history:delete-session", (event, id: string) => {
    trusted(event);
    return history("deleteSession", id);
  });
  ipcMain.handle("history:requests", (event) => {
    trusted(event);
    return history("listRequests");
  });
  ipcMain.handle("history:delete-request", (event, id: string) => {
    trusted(event);
    return history("deleteRequest", id);
  });
  ipcMain.handle("history:clear-requests", (event) => {
    trusted(event);
    return history("clearRequests");
  });
  ipcMain.handle("history:settings", (event) => {
    trusted(event);
    return history("settings");
  });
  ipcMain.handle("history:set-settings", (event, value: Partial<HistorySettings>) => {
    trusted(event);
    return history("setSettings", { retainRequests: value?.retainRequests === true ? true : value?.retainRequests === false ? false : undefined });
  });
  ipcMain.handle("vault:status", (event) => {
    trusted(event);
    return status();
  });
  ipcMain.handle("vault:retry", (event) => {
    trusted(event);
    retryVault();
    return status();
  });
  ipcMain.handle("vault:recover", (event, recoveryKey: unknown) => {
    trusted(event);
    if (typeof recoveryKey !== "string" || recoveryKey.length > 200 || !recoverVault(recoveryKey)) throw new Error("This recovery key doesn't open your history.");
    return status();
  });
  ipcMain.handle("vault:recovery-key", async (event) => {
    trusted(event);
    await open();
    return newRecoveryKey();
  });
  ipcMain.handle("vault:rotate", async (event) => {
    trusted(event);
    // A reply in progress may be reading a document under its old name.
    idle();
    await rotateKey();
    return status();
  });
  ipcMain.handle("vault:start-over", (event) => {
    trusted(event);
    if (opened) throw new Error("History is open; there is nothing to start over.");
    startOver();
    return status();
  });
  app.on("will-quit", () => {
    if (thread) void send("close");
  });
}
