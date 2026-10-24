/**
 * Token estimates shared by the harness, which compacts with them, and the renderer, which shows them
 * when a runtime does not report usage.
 */
import type { AppUIMessage } from "./types";

/** What one attached image is counted as; vision encoders take roughly this much for a resized photo. */
export const IMAGE_TOKENS = 1200;

export const textOf = (message: AppUIMessage) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** A rough count that errs high: about three characters per token, more for scripts like Korean. */
export function estimateText(text: string) {
  const wide = text.replace(/[ -~\s]/g, "").length;
  return Math.ceil((text.length - wide) / 3 + wide * 1.2);
}

export function estimateTokens(message: AppUIMessage) {
  const images = message.parts.filter((part) => part.type === "file" && part.mediaType.startsWith("image/")).length;
  return estimateText(textOf(message)) + images * IMAGE_TOKENS + 8;
}

/** The latest stored compaction and the messages that follow the part of the history it covers. */
export function applyStored(messages: AppUIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const part = messages[index].parts.findLast((item) => item.type === "data-compaction");
    if (!part || part.type !== "data-compaction") continue;
    const end = messages.findIndex((message) => message.id === part.data.upTo);
    if (end < 0) continue;
    return { summary: part.data.summary, rest: messages.slice(end + 1) };
  }
  return { summary: undefined, rest: messages };
}
