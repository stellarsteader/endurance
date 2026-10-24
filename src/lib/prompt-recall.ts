/**
 * ↑ and ↓ in the composer bring back what was sent earlier in the same chat. The list comes from
 * the chat's own messages, so nothing new is stored. Only the text returns; attachments are not sent again.
 */
import { messageText } from "./derive";
import type { AppUIMessage } from "./types";

/** Where browsing is: the entry shown (0 is the latest) and what was typed before browsing began. -1 is not browsing. */
export interface Recall {
  index: number;
  typed: string;
  /** The text last put in the composer, so typing over it ends browsing. */
  shown: string;
}

export const NOT_BROWSING: Recall = { index: -1, typed: "", shown: "" };

/** The chat's sent messages, newest first, without empty ones or a repeat of the one just after. */
export function sentPrompts(messages: AppUIMessage[]) {
  const list: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = messageText(messages[i]).trim();
    if (text && list.at(-1) !== text) list.push(text);
  }
  return list;
}

/**
 * The next composer text for a key, or undefined when the key should move the caret as usual. ↑ starts only from an
 * empty composer and, while browsing, acts with the caret at the start; ↓ acts while browsing with the caret at the
 * end, and past the latest entry gives back what was typed before.
 */
export function recall(
  list: readonly string[],
  state: Recall,
  key: "up" | "down",
  value: string,
  caret: { start: number; end: number }
): { state: Recall; text: string } | undefined {
  // Typing over a recalled prompt makes it the person's own text again.
  const browsing = state.index >= 0 && value === state.shown;
  const collapsed = caret.start === caret.end;
  if (key === "up") {
    if (!collapsed || (browsing ? caret.start !== 0 : value !== "")) return undefined;
    const index = browsing ? state.index + 1 : 0;
    if (index >= list.length) return undefined;
    return { state: { index, typed: browsing ? state.typed : value, shown: list[index] }, text: list[index] };
  }
  if (!browsing || !collapsed || caret.end !== value.length) return undefined;
  if (state.index === 0) return { state: NOT_BROWSING, text: state.typed };
  const index = state.index - 1;
  return { state: { ...state, index, shown: list[index] }, text: list[index] };
}
