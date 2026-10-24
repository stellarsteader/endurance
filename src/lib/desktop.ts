import type { RuntimeId } from "./models";
export type SecretChange<T> = { keep: true } | { replace: T } | { remove: true };
import type { ModelInfo } from "./models";
import type { CompactionData } from "./types";
import type { FileUndo, UndoResult } from "./file-undo";
import type { ChatExportFormat } from "./chat-export";
import type { ServerInfo } from "../harness/server-info";
import type { ConnectionState, ConnectionView, LegacySettings, ServerOwner } from "./connections";

export interface CatalogResult {
  connectionId: string;
  /** The connection's kind: the protocol and native endpoints used for it. */
  runtime: RuntimeId;
  models: ModelInfo[];
  error?: string;
  reason?: ProbeReason;
  status?: number;
  detected?: RuntimeProbe["detected"];
  /** Set by the main process from the result and the connection's history. */
  state?: ConnectionState;
}
/** Why a runtime did not answer, from the transport error or HTTP status. "starting" is 502/503/504. */
export type ProbeReason = "refused" | "host" | "timeout" | "auth" | "not-api" | "tls" | "address" | "starting" | "other" | "error";
export interface RuntimeProbe {
  ok: boolean;
  /** Round trip of the first request. */
  latencyMs?: number;
  version?: string;
  models?: number;
  loaded?: { name: string; bytes?: number; context?: number }[];
  /** Largest context a served model accepts, when the runtime reports it. */
  maxContext?: number;
  reason?: ProbeReason;
  status?: number;
  /** For reason "other": the runtime that answered instead, or macOS AirPlay Receiver. */
  detected?: RuntimeId | "airplay";
}
export type ChatEvent =
  | { id: string; type: "headers"; status: number; headers: Record<string, string> }
  | { id: string; type: "chunk"; chunk: string }
  | { id: string; type: "done" }
  | { id: string; type: "error"; message: string };
/** What /compact did: a summary to store on the conversation, or why there was none. */
export type CompactResult = { data: CompactionData } | { skipped: "short" | "failed" };
/** The chat worker's answer to a compaction request. */
export type CompactEvent = { id: string; type: "compacted"; result: CompactResult };
/** The chat worker's answer to a title request: the name its model wrote, or none. */
export type TitleEvent = { id: string; type: "titled"; title?: string };
/** A system notification for a chat, shown only while the window is in the background. */
export interface ChatNotice {
  chatId: string;
  title: string;
  body: string;
  sound: boolean;
}
/** A sent document read to be shown: its bytes, or why there are none. */
export type AttachmentRead = { state: "ok"; bytes: Uint8Array } | { state: "missing" } | { state: "too-large"; size: number };
/** The text the model read from a sent document, kept with it; "unread" until a chat has read it whole. */
export type AttachmentText = { state: "ok"; text: string } | { state: "missing" } | { state: "unread" };
/** A server added by URL or curl command, before it is saved. Typed secrets travel to the main process once. */
export interface ServerDraft {
  /** The pasted address or curl command; the main process parses it again. */
  input: string;
  /** A typed key, used instead of one found in the command. */
  apiKey?: string;
  headers?: Record<string, string>;
  name?: string;
  concurrency?: number;
}
export interface ServerCheck {
  probe: RuntimeProbe;
  baseUrl: string;
  kind: RuntimeId;
  /** Set when the server was added. */
  connection?: ConnectionView;
  /** Set when this address is already listed. */
  duplicate?: string;
}
/** Changes to a saved connection. Omitted fields and secrets stay as saved. */
export interface ConnectionEdit {
  baseUrl?: string;
  name?: string;
  concurrency?: number;
  /** Whether the person runs the server; null goes back to what the address suggests. */
  owner?: ServerOwner | null;
  apiKey?: SecretChange<string>;
  headers?: SecretChange<Record<string, string>>;
  /** Send the secrets saved for the previous address to the new one. */
  moveSecrets?: boolean;
}
/** Values being edited for a test; null uses the saved secret, when it may be sent to this address. */
export interface ConnectionTest {
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string> | null;
  moveSecrets?: boolean;
}
export interface DesktopAPI {
  platform: string;
  /** The saved connections. The first call after an update moves settings from `legacy` once. */
  connections(legacy?: LegacySettings): Promise<ConnectionView[]>;
  onConnections(listener: (connections: ConnectionView[]) => void): () => void;
  /** Checks every connection, or only the one named, and returns all their models; also pushed after automatic re-checks. */
  catalog(connectionId?: string): Promise<CatalogResult[]>;
  onCatalog(listener: (catalog: CatalogResult[]) => void): () => void;
  /** Lists runtimes found at their default addresses, except ones the person removed. */
  detect(): Promise<void>;
  /** Lists a runtime at its default address, chosen from Add server. */
  addRuntime(id: RuntimeId): Promise<void>;
  checkServer(draft: ServerDraft): Promise<ServerCheck>;
  /** Checks, then saves the server when it answers or is starting. */
  addServer(draft: ServerDraft): Promise<ServerCheck>;
  updateConnection(id: string, edit: ConnectionEdit): Promise<ConnectionView>;
  /** Saves the order the person dragged the servers into; the model lists follow it. */
  reorderConnections(ids: string[]): Promise<void>;
  /** A vLLM server's load and cache, for display; undefined for other runtimes. */
  serverInfo(id: string): Promise<ServerInfo | undefined>;
  /** Removes a server with its saved key, headers and signed query. */
  removeConnection(id: string): Promise<void>;
  testConnection(id: string, test: ConnectionTest): Promise<RuntimeProbe>;
  startChat(id: string, body: string): Promise<void>;
  /** Summarizes a runtime conversation's older turns now. `body` is a chat request without settings. */
  compactChat(body: string): Promise<CompactResult>;
  /**
   * Undoes the agent's edits to files in a chat (lib/file-undo), in its project's folders as saved in the main
   * process. Each file is put back, deleted or skipped with the reason.
   */
  undoEdits(chatId: string, projectId: string | undefined, files: FileUndo[]): Promise<UndoResult[]>;
  cancelChat(id: string): void;
  /** The chats on screen now (the open chat and an open side chat), so their requests go first. */
  showChats(ids: string[]): void;
  /** Keeps an attached document in the app's data folder; the message then refers to it as `attachment:<id>`. */
  saveAttachment(name: string, mediaType: string, data: ArrayBuffer): Promise<{ id: string; size: number }>;
  /** HEIC or TIFF bytes as PNG, converted by macOS (the window cannot decode them). Refused on other systems. */
  convertImage(data: Uint8Array): Promise<Uint8Array>;
  /** A sent document's bytes, to show it; nothing for one no longer kept or too large to show. */
  readAttachment(id: string): Promise<AttachmentRead>;
  /** The text the model read from a sent document, when it was kept. */
  readAttachmentText(id: string): Promise<AttachmentText>;
  /** Saves a copy of a sent document where the person chooses in the save dialog. */
  saveAttachmentCopy(id: string, filename: string): Promise<"saved" | "canceled" | "missing">;
  /** Saves an exported chat (lib/chat-export) where the person chooses in the save dialog; the copy is not encrypted. */
  exportChat(filename: string, format: ChatExportFormat, text: string): Promise<"saved" | "canceled">;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  /** Names a chat with its own model from its first exchange (harness/title); undefined when it could not. */
  titleChat(body: string): Promise<string | undefined>;
  /** Shows a system notification when the window is in the background; nothing when it is in front. */
  notify(notice: ChatNotice): void;
  /** A notification was clicked: the chat it was about should open. */
  onOpenChat(listener: (chatId: string) => void): () => void;
}
declare global {
  interface Window { endurance?: DesktopAPI }
}

/** Electron prefixes errors from the main process; people only need the reason. */
export const ipcMessage = (error: Error) => error.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");

/** Keep the existing AI SDK stream contract while replacing the Next.js HTTP route. */
export const chatFetch: typeof fetch = async (input, init) => {
  const desktop = window.endurance;
  if (!desktop) throw new Error("Endurance chats run in the desktop app.");
  const id = crypto.randomUUID();
  const signal = init?.signal;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise<Response>((resolve, reject) => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { desktop.cancelChat(id); cleanup(); },
    });
    const cleanup = () => { finished = true; unsubscribe(); signal?.removeEventListener("abort", abort); };
    const fail = (error: Error) => { if (finished) return; controller.error(error); reject(error); cleanup(); };
    const abort = () => { desktop.cancelChat(id); fail(new DOMException("Aborted", "AbortError")); };
    const unsubscribe = desktop.onChatEvent((event) => {
      if (event.id !== id || finished) return;
      if (event.type === "headers") resolve(new Response(stream, { status: event.status, headers: event.headers }));
      if (event.type === "chunk") controller.enqueue(encoder.encode(event.chunk));
      if (event.type === "done") { controller.close(); cleanup(); }
      if (event.type === "error") fail(new Error(event.message));
    });
    signal?.addEventListener("abort", abort, { once: true });
    desktop.startChat(id, String(init?.body ?? "{}")).catch((error: Error) => fail(error));
    if (signal?.aborted) abort();
  });
};
