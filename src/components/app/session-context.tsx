"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { FileUIPart } from "ai";
import { createContext, useContext } from "react";
import type { Thread, WorkspaceTab } from "@/lib/store";
import type { AppUIMessage, ChatChoice, ChatSettings, Effort } from "@/lib/types";
import type { ModelInfo } from "@/lib/models";

export interface QueuedMessage {
  id: string;
  text: string;
  files: FileUIPart[];
  /** Send now: ahead of a reply waiting for approval or after a failure, not only once the chat is idle. */
  steer?: boolean;
}

export interface SessionValue {
  thread: Thread;
  chat: UseChatHelpers<AppUIMessage>;
  busy: boolean;
  pendingApproval: boolean;
  queue: QueuedMessage[];
  enqueue: (message: Omit<QueuedMessage, "id">, front?: boolean) => void;
  removeQueued: (id: string) => void;
  sendNow: (id: string) => void;
  moveQueued: (id: string, dir: -1 | 1) => void;
  send: (message: { text: string; files?: FileUIPart[] }, overrides?: Partial<ChatSettings>) => void;
  workspaceTab: WorkspaceTab;
  openWorkspace: (tab: WorkspaceTab, focus?: string) => void;
  focus: string | undefined;
  agentId: string | undefined;
  openAgent: (id: string | null) => void;
  openSideChat: () => void;
  isSide: boolean;
  /** The chat on screen. Background chats stay mounted, so app-wide dialogs belong only to this one. */
  active: boolean;
  /** What the reply waits on before anything streams: the model loading, or an attached document being read. */
  waitStatus?: string;
  /** The model this chat runs on, and the effort it sends, fitted to the model. */
  model: ModelInfo;
  effort: Effort;
  /** Picks a model or effort for this chat. */
  choose: (patch: ChatChoice) => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside a ChatSession");
  return ctx;
}
