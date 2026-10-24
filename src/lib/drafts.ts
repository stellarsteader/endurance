/**
 * What was typed or attached in a chat's composer and not sent yet. Kept in memory only, never on
 * disk: a draft survives switching chats, however many, but not quitting the app. Attachments stay `blob:` URLs,
 * which last as long as the window, so the draft holds them until it is sent, cleared or its chat is deleted.
 */
import type { FileUIPart } from "ai";

export type DraftFile = FileUIPart & { id: string };
export interface Draft {
  text: string;
  files: DraftFile[];
}

const drafts = new Map<string, Draft>();

export const draftFor = (chatId: string): Draft | undefined => drafts.get(chatId);

/** Remembers the composer's state for a chat; an empty composer leaves no draft. */
export function keepDraft(chatId: string, draft: Draft) {
  if (!draft.text && draft.files.length === 0) drafts.delete(chatId);
  else drafts.set(chatId, draft);
}

/** Forgets a chat's draft and frees its attachments, for a deleted chat. */
export function dropDraft(chatId: string) {
  for (const file of drafts.get(chatId)?.files ?? []) if (file.url.startsWith("blob:")) URL.revokeObjectURL(file.url);
  drafts.delete(chatId);
}
