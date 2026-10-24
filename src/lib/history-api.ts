import type { AppUIMessage, ChatChoice } from "./types";

export type RequestStatus = "running" | "ok" | "error" | "cancelled";

export interface HistorySession {
  id: string;
  title: string;
  projectId?: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  /** The chat's own model and effort; see ChatChoice. */
  choice?: ChatChoice;
  /** Totals of the usage reported on the stored replies. */
  tokens?: { input: number; output: number; reasoning: number; cached: number };
  /** Listed chats come without their messages (HistoryAPI.messages); these stand in for them until then. */
  messageCount?: number;
  /** The model that wrote the last reply. */
  replyModel?: string;
}
/** A chat to save; without messages, only the chat (title, project, pin, model) is saved and its messages stay. */
export type SessionInput = Omit<HistorySession, "tokens" | "messageCount" | "replyModel"> & { messages?: AppUIMessage[] };
export interface HistoryRequest {
  id: string;
  time: number;
  sessionId: string;
  sessionTitle?: string;
  runtime: string;
  model: string;
  origin: string;
  status: RequestStatus;
  reason?: string;
  durationMs?: number;
  tokens: { input: number; output: number; reasoning: number };
  /** The request messages, only when Keep request contents was on. */
  content?: string;
}
export interface HistorySettings {
  retainRequests: boolean;
}
/**
 * Whether the encrypted history can be opened. Locked, it says why: no usable keychain ("keystore"), the keychain
 * did not open the key ("unreadable"), or the key is gone and only starting over helps ("missing").
 */
/** How far encrypting an older history ("encrypting") or a new key ("rotating") has got, in the current step. */
export interface VaultProgress {
  stage: "encrypting" | "rotating";
  done: number;
  total: number;
}
export type VaultStatus =
  | { status: "open"; hasRecovery: boolean }
  | { status: "locked"; reason: "keystore" | "unreadable" | "missing"; hasRecovery: boolean };
export interface HistoryAPI {
  sessions(): Promise<HistorySession[]>;
  /** One chat's messages, read when the chat is opened. */
  messages(sessionId: string): Promise<AppUIMessage[]>;
  saveSession(session: SessionInput): Promise<void>;
  deleteSession(id: string): Promise<void>;
  requests(): Promise<HistoryRequest[]>;
  deleteRequest(id: string): Promise<void>;
  clearRequests(): Promise<void>;
  settings(): Promise<HistorySettings>;
  setSettings(value: Partial<HistorySettings>): Promise<HistorySettings>;
  vault(): Promise<VaultStatus>;
  retryVault(): Promise<VaultStatus>;
  /** Rejects when the key does not open the history. */
  recoverVault(recoveryKey: string): Promise<VaultStatus>;
  /** A new recovery key, shown once; the previous one stops working. */
  newRecoveryKey(): Promise<string>;
  /** Encrypts the history and attachments again with a new key; the recovery key stops working. */
  rotateKey(): Promise<VaultStatus>;
  /** Only while locked: deletes the history that cannot be opened and starts a new one. */
  startOver(): Promise<VaultStatus>;
  /** Progress while the history is encrypted (first start after an update, or a new key); returns unsubscribe. */
  onVaultProgress(listener: (progress: VaultProgress) => void): () => void;
}
declare global {
  interface Window {
    enduranceHistory?: HistoryAPI;
  }
}
