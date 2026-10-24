/**
 * The history thread: owns the history database, the attachments folder and the data key, so encryption, the
 * first encryption of an older history, key rotation and VACUUM never hold up the windows and IPC on the main
 * thread. It is a worker thread of the main process, so the key never leaves the process. Calls are answered one
 * at a time, in the order they came; everything here is synchronous.
 */
import { chmodSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { AttachmentFolder } from "../src/history/attachment-folder";
import { HistoryKeyMismatch, HistoryStore, type Progress } from "../src/history/store";
import { Vault } from "../src/history/vault";
import type { HistorySettings, RequestStatus, SessionInput } from "../src/lib/history-api";
import type { StoredProject } from "../src/lib/workspace-api";

export type HistoryProgress = { type: "progress"; stage: "encrypting" | "rotating"; done: number; total: number };
export type HistoryResult = { type: "result"; call: number } & ({ ok: true; value: unknown } | { ok: false; error: string; mismatch: boolean });

const port = parentPort!;
let history: { store: HistoryStore; folder: AttachmentFolder } | undefined;
const opened = () => {
  if (!history) throw new Error("History is not open.");
  return history;
};
const progress =
  (stage: HistoryProgress["stage"]): Progress =>
  (done, total) =>
    port.postMessage({ type: "progress", stage, done, total } satisfies HistoryProgress);

const methods = {
  /** Opens the history with its key; a history from before encryption is encrypted first, attachments then rows. */
  open(request: { file: string; folder: string; key: Uint8Array; id: string; settled: boolean }) {
    if (history) return;
    const vault = new Vault(request.key);
    const folder = new AttachmentFolder(request.folder, vault);
    const renamed = HistoryStore.isEncrypted(request.file) ? undefined : folder.sealPlain(progress("encrypting"));
    const store = new HistoryStore(request.file, vault, { id: request.id, renamed, onProgress: progress("encrypting") });
    history = { store, folder };
    folder.removePlain();
    // A key rotation the app was stopped in leaves files no message names.
    if (request.settled) folder.removeUnreferenced(store.attachmentIds());
    try {
      chmodSync(request.file, 0o600);
    } catch {
      /* The database is still usable; the profile folder is already private to the user. */
    }
  },
  /** Encrypts the attachments, then the history in one transaction, with a new key (electron/history-ipc rotateKey). */
  rotate(request: { key: Uint8Array; id: string }) {
    const { store, folder } = opened();
    const next = new Vault(request.key);
    try {
      store.rotate(next, request.id, folder.reseal(next, progress("rotating")), progress("rotating"));
      folder.vault = next; // Reached only once the history was committed with the new key.
    } finally {
      folder.removeUnreferenced(store.attachmentIds());
    }
  },
  close() {
    history?.store.close();
    history = undefined;
  },

  saveAttachment: (bytes: Uint8Array) => opened().folder.save(bytes),
  readAttachment: (id: string) => opened().folder.read(id),
  readAttachmentText: (id: string, version: string) => opened().folder.readText(id, version),
  writeAttachmentText: (id: string, version: string, text: string) => opened().folder.writeText(id, version, text),

  listSessions: () => opened().store.listSessions(),
  messages: (session: string) => opened().store.messages(session),
  saveSession: (session: SessionInput) => opened().store.saveSession(session),
  deleteSession: (id: string) => opened().store.deleteSession(id),
  listRequests: () => opened().store.listRequests(),
  deleteRequest: (id: string) => opened().store.deleteRequest(id),
  clearRequests: () => opened().store.clearRequests(),
  settings: () => opened().store.settings(),
  setSettings: (value: Partial<HistorySettings>) => opened().store.setSettings(value),
  startRequest: (input: Parameters<HistoryStore["startRequest"]>[0]) => opened().store.startRequest(input),
  finishRequest: (id: string, outcome: { status: Exclude<RequestStatus, "running">; reason?: string; usage?: { input?: number; output?: number; reasoning?: number }; durationMs?: number }) =>
    opened().store.finishRequest(id, outcome),
  projectsImported: () => opened().store.projectsImported(),
  listProjects: () => opened().store.listProjects(),
  project: (id: string) => opened().store.project(id),
  saveProject: (project: StoredProject) => opened().store.saveProject(project),
  importProjects: (projects: StoredProject[]) => opened().store.importProjects(projects),
  deleteProject: (id: string) => opened().store.deleteProject(id),
};
export type HistoryMethods = typeof methods;

port.on("message", ({ call, method, args }: { call: number; method: keyof HistoryMethods; args: unknown[] }) => {
  try {
    const value = (methods[method] as (...values: unknown[]) => unknown)(...args);
    port.postMessage({ type: "result", call, ok: true, value } satisfies HistoryResult);
  } catch (error) {
    port.postMessage({ type: "result", call, ok: false, error: error instanceof Error ? error.message : String(error), mismatch: error instanceof HistoryKeyMismatch } satisfies HistoryResult);
  }
});
