/**
 * Each message's tokens as the runtime counted them, taken from the replies' usage rather than estimated from text.
 * The next request carries the previous one's conversation, its reply's text and the new message, so how much a
 * turn's first prompt (Usage.first) grew over the previous turn's is what those two took. A reply written in one go
 * has its own count (Usage.reply), and the new message takes the rest. A reply that used tools sends back the text of
 * all its steps, which no one call counted, so the growth is shared by the two messages' estimated sizes. A turn that
 * summarized the conversation, ran on another model or window, or has no count breaks the chain, and its messages
 * are left to the caller's estimate.
 */
import { estimateTokens } from "./token-estimate";
import type { AppUIMessage } from "./types";

const steps = (message: AppUIMessage) => message.parts.some((part) => part.type === "dynamic-tool" || part.type.startsWith("tool-"));

export function countedMessageTokens(messages: readonly AppUIMessage[]) {
  const counts = new Map<string, number>();
  let previous: { first: number; reply: AppUIMessage; own?: number; model?: string; window?: number } | undefined;
  let asked: AppUIMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") asked.push(message);
    if (message.role !== "assistant") continue;
    const usage = message.metadata?.usage;
    const own = usage?.reply !== undefined && !steps(message) ? usage.reply : undefined;
    if (own !== undefined) counts.set(message.id, own);
    const first = message.parts.some((part) => part.type === "data-compaction") ? undefined : usage?.first;
    // Only one message between two counted turns can take what the prompt grew by.
    if (first !== undefined && previous && asked.length === 1 && previous.model === message.metadata?.model && previous.window === usage?.window) {
      const grown = first - previous.first;
      if (previous.own !== undefined) {
        if (grown - previous.own > 0) counts.set(asked[0].id, grown - previous.own);
      } else if (grown > 0) {
        const reply = estimateTokens(previous.reply);
        const ask = estimateTokens(asked[0]);
        counts.set(previous.reply.id, Math.round((grown * reply) / (reply + ask)));
        counts.set(asked[0].id, Math.round((grown * ask) / (reply + ask)));
      }
    }
    previous = first !== undefined ? { first, reply: message, own, model: message.metadata?.model, window: usage?.window } : undefined;
    asked = [];
  }
  return counts;
}
