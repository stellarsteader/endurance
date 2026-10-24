/**
 * Conversation compaction. Only when the next request would not fit (its input plus the output kept free is
 * over the window) are older turns summarized by the same model and replaced by that summary; a conversation
 * that fits is sent whole however long it is. Only as much as has to go is summarized: the newest turns stay
 * word for word as far as they fit, with room left for the next few turns so it is not summarized again at once. The summary is stored as a data part on the reply, so later
 * turns reuse it instead of summarizing again. What is summarized is never cut to fit the summarizer: a long
 * stretch is read in pieces, each folded into the summary so far.
 */
import type { UIMessageStreamWriter } from "ai";
import { request as makeRequest } from "./vendor/llm/llm";
import { Message } from "./vendor/llm/schema";
import type { AppUIMessage, CompactionData } from "../lib/types";
import type { RuntimeConnection } from "../lib/models";
import { applyStored, estimateTokens, textOf } from "../lib/token-estimate";
import { capsFor, guardedStream } from "./guarded";
import { withBody } from "./output";
import type { Tuned } from "./sampling";
import type { ThinkingRequest } from "./thinking";

export { applyStored, estimateTokens };

/** Room left after compacting for the next turns, as a share of the window, so one more message does not compact again. */
const HEADROOM = 1 / 8;
/** The summary's size, as a share of the window: it is sent with every later request. */
const SUMMARY = 1 / 8;
/** A window assumed for /compact when the runtime reports none, as small local models load by default. */
const UNKNOWN_WINDOW = 4096;
const CHARS = 3;

export function summaryMessage(summary: string) {
  return Message.user(`Summary of the earlier conversation, which is no longer shown in full:\n${summary}`);
}

interface Options {
  messages: AppUIMessage[];
  contextWindow?: number;
  /** Estimated tokens the request adds besides the conversation: system prompt, tool definitions, run steps. */
  system: number;
  /** Tokens the next call keeps free for its output (budget.reserve). */
  reserve?: number;
  model: Parameters<typeof makeRequest>[0]["model"];
  layer: typeof import("./chat").layer;
  signal: AbortSignal;
  /** Receives the `data-compaction` part; a forced compaction returns it instead. */
  writer?: UIMessageStreamWriter<AppUIMessage>;
  /** Summarize now, as /compact asks, even when the history still fits. */
  force?: boolean;
  /** The runtime's fields for thinking off: a summary needs none. */
  thinking?: ThinkingRequest;
  /** Shares the server's request slots with the conversation. */
  connection?: RuntimeConnection;
  /** The request fields for a summary of at most this many tokens, with the sampling set for thinking off. */
  tune?: (maxTokens?: number) => Tuned;
}

/** Why a history was left as it was: too little to summarize, small enough, or the summary was unusable. */
export type CompactSkip = "short" | "fits" | "failed";

const PROMPT = (words: number) =>
  `Summarize this conversation so it can continue without the original messages. Keep facts, decisions, names, numbers, file paths, the user's preferences, what has been done (files changed, commands run), what is left to do and open questions. Write in the conversation's language. Use short bullet points, at most about ${words} words.`;

/** The transcript in pieces of at most `size` characters, split between messages where it can be. */
function pieces(lines: string[], size: number) {
  const result: string[] = [];
  let current = "";
  for (const line of lines) {
    for (let start = 0; start < line.length; start += size) {
      const part = line.slice(start, start + size);
      if (current && current.length + part.length + 2 > size) {
        result.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) result.push(current);
  return result;
}

/**
 * Returns the history to send: the stored or new summary, then the recent messages. `data` is set when a
 * new summary was made, and `skipped` says why not otherwise.
 */
export async function compactHistory({ messages, contextWindow, system, reserve = 0, model, layer, signal, writer, force, thinking, connection, tune }: Options): Promise<{
  summary?: string;
  rest: AppUIMessage[];
  data?: CompactionData;
  skipped?: CompactSkip;
}> {
  const stored = applyStored(messages);
  const limit = contextWindow && contextWindow >= 1024 ? contextWindow : undefined;
  const size = (list: AppUIMessage[]) => list.reduce((total, message) => total + estimateTokens(message), 0);
  const summaryTokens = stored.summary ? Math.ceil(stored.summary.length / 2) : 0;
  const total = system + summaryTokens + size(stored.rest);
  const unchanged = (skipped: CompactSkip) => ({ summary: stored.summary, rest: stored.rest, skipped });
  if (stored.rest.length < 3) return unchanged("short");
  if (!force && (!limit || total + reserve <= limit)) return unchanged("fits");

  let kept: number;
  if (force || !limit) {
    // On request, everything before the latest turn is summarized; that turn stays word for word.
    const latest = stored.rest.findLastIndex((message) => message.role === "user");
    kept = stored.rest.length - (latest >= 0 ? latest : stored.rest.length - 1);
  } else {
    // Keep the newest turns that fit beside the request's own part, the summary, the output and the headroom,
    // always including the message being answered; only what is older is summarized.
    const room = limit - system - reserve - Math.floor(limit * SUMMARY) - Math.floor(limit * HEADROOM);
    kept = 1;
    let keptSize = estimateTokens(stored.rest.at(-1)!);
    while (kept < stored.rest.length - 1 && keptSize + estimateTokens(stored.rest.at(-1 - kept)!) <= room) {
      keptSize += estimateTokens(stored.rest.at(-1 - kept)!);
      kept++;
    }
  }
  const older = stored.rest.slice(0, stored.rest.length - kept);
  if (!older.length) return unchanged("short");

  const window = limit ?? UNKNOWN_WINDOW;
  const summaryCap = Math.floor(window * SUMMARY);
  const words = Math.max(60, Math.floor(summaryCap * 0.6));
  // Each piece leaves room for the instructions, the summary so far and the new summary.
  const piece = Math.max(1000, (window - 2 * summaryCap - 300) * CHARS);
  const lines = older.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${textOf(message)}`);
  let summary = stored.summary ?? "";
  for (const transcript of pieces(lines, piece)) {
    // The runtime stops the summary at its share of the window, when the window is known.
    const sent = tune?.(limit ? summaryCap : undefined) ?? (limit ? { generation: { maxTokens: summaryCap } } : {});
    const response = await guardedStream({
      input: makeRequest(
        withBody(
          {
            model,
            system: PROMPT(words),
            messages: [Message.user([summary ? `Earlier summary:\n${summary}` : "", `Conversation:\n${transcript}`].filter(Boolean).join("\n\n"))],
            ...thinking,
            ...(sent.generation ? { generation: sent.generation } : {}),
          },
          sent.body
        )
      ),
      layer,
      connection,
      signal,
      caps: capsFor(summaryCap),
    });
    // A summary that looped or ran too long is not used; the conversation goes on uncompacted.
    const next = response.stopped ? "" : response.text.trim();
    if (!next) return unchanged("failed");
    summary = next;
  }
  const rest = stored.rest.slice(stored.rest.length - kept);
  const data: CompactionData = {
    summary,
    compacted: older.length,
    before: total,
    after: system + Math.ceil(summary.length / 2) + size(rest),
    limit: limit ?? 0,
    upTo: older.at(-1)!.id,
  };
  writer?.write({ type: "data-compaction", id: `compaction-${data.upTo}`, data });
  return { summary, rest, data };
}
