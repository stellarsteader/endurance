/**
 * Find in the open chat (⌘F): where a phrase occurs in what the person and the model wrote. Only the text of
 * messages is searched, as the chat shows it (lib/derive messageText); thoughts, tool calls and their results are
 * not. Case is ignored. Pure, so the find bar (components/app/find-bar) only shows and jumps.
 */
import { messageText } from "./derive";
import type { AppUIMessage } from "./types";

export interface FindMatch {
  messageId: string;
  /** Which occurrence in that message, from 0. */
  occurrence: number;
  /** Where it is in the message's text. */
  start: number;
  end: number;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for the phrase, case ignored; undefined for one with nothing to find. */
export function findPattern(query: string) {
  return query.trim() ? new RegExp(escape(query), "giu") : undefined;
}

/** Every occurrence of the phrase in the chat's messages, in reading order. Occurrences do not overlap. */
export function findInConversation(messages: AppUIMessage[], query: string): FindMatch[] {
  const pattern = findPattern(query);
  if (!pattern) return [];
  const matches: FindMatch[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    let occurrence = 0;
    for (const found of messageText(message).matchAll(pattern)) {
      matches.push({ messageId: message.id, occurrence: occurrence++, start: found.index, end: found.index + found[0].length });
    }
  }
  return matches;
}
