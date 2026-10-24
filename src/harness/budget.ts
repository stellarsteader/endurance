/**
 * How much one model call may take of the context window, in one place for chats, the agent loop, subagents and
 * compaction. Nothing here depends on the model's size; everything follows from three figures:
 * - W, the window the request runs with (lib/context-window);
 * - R, the output kept free: what this model wrote in its recent calls (thinking included), with a margin, or
 *   a share of the window before there is any; never under an eighth of the window or over half of it;
 * - I, the request as estimated, scaled by how the runtime's own counts compared so far.
 * A request is sent whole when I ≤ W − R. Only when it is not does anything give way: the oldest tool results
 * of the run first, then the conversation through compaction. A new tool result takes at most half of what
 * the request leaves, so the next step always fits. R only plans: one call's output may run to the end of the
 * window (outputCap); a loop is stopped by the loop guard, and an answer that fills the window is continued.
 */
import { Message, Usage, type LLMEvent } from "./vendor/llm/schema";
import { estimateText, IMAGE_TOKENS } from "../lib/token-estimate";

export interface Budget {
  /** The context window, or 0 when nothing reports one and nothing is fitted. */
  window: number;
  /** Tokens kept free for the model's output: thinking, text and tool calls. */
  reserve: number;
}

/** The output kept free, as shares of the window. */
const START = { thinking: 1 / 4, plain: 1 / 8 };
const LEAST = 1 / 8;
const MOST = 1 / 2;
/** Room over the recent outputs, so a somewhat longer answer still fits. */
const MARGIN = 1.5;

/**
 * The budget for a call. `observed` is the model's recent output size (see learnOutput); without it the
 * reserve starts at a share of the window, larger when the model thinks.
 */
export function budgetFor(window: number | undefined, observed?: number, thinking = true): Budget {
  if (!window || window < 512) return { window: 0, reserve: 0 };
  const start = window * (thinking ? START.thinking : START.plain);
  const wanted = observed ? observed * MARGIN : start;
  return { window, reserve: Math.round(Math.min(window * MOST, Math.max(window * LEAST, wanted))) };
}

/** Tokens the request itself may use. */
export const inputLimit = (budget: Budget) => budget.window - budget.reserve;

/** A result's size when the window is unknown: what one call returned before budgets followed the window. */
export const UNKNOWN_RESULT = 4000;
/** Below this a result cannot say anything useful; the tool says there is no room instead. */
export const LEAST_RESULT = 64;

/** Tokens a new tool result may take: half of what the request leaves once it is this big. */
export function resultRoom(budget: Budget, used: number) {
  if (!budget.window) return UNKNOWN_RESULT;
  return Math.max(0, Math.floor((inputLimit(budget) - used) / 2));
}

/** Characters for a number of tokens, by the same estimate the budget counts with. */
export const charsFor = (tokens: number, ratio = 1) => Math.max(0, Math.floor((tokens / Math.max(ratio, 0.1)) * 3));

/** What one output may take: whatever the window leaves. Only the window stops an answer. */
export function outputCap(budget: Budget, input: number) {
  if (!budget.window) return undefined;
  return Math.max(256, budget.window - input);
}

export function messageTokens(message: Message) {
  return message.content.reduce((total, part) => {
    if (part.type === "text") return total + estimateText(part.text);
    if (part.type === "media") return total + IMAGE_TOKENS;
    if (part.type === "reasoning") return total + estimateText(part.text);
    return total + estimateText(JSON.stringify(part));
  }, 4);
}

/** Estimated tokens of a request, scaled by how the runtime's own counts compared so far. */
export const requestTokens = (system: string, history: readonly Message[], ratio = 1, extra = 0) =>
  Math.ceil((estimateText(system) + extra + history.reduce((total, message) => total + messageTokens(message), 0)) * ratio);

/**
 * Tokens the runtime counted for a message, where a call's count could be put on it: a reply's own output, and what
 * a prompt grew by between two calls, shared over the messages added in between. The rest is estimated.
 */
export const measuredTokens = new WeakMap<Message, number>();

/** The runtime's count of the last call: its prompt and output, and how many messages of the history that covers. */
export interface Anchor {
  tokens: number;
  length: number;
}

/** A message's tokens: the runtime's count when known, otherwise the estimate scaled by how counts compared so far. */
export const tokensOf = (message: Message, ratio = 1) => measuredTokens.get(message) ?? Math.ceil(messageTokens(message) * ratio);

/**
 * A request's tokens as best known, as Codex counts them: the last call's count plus what was added to the history
 * since. Without that, each message's own count where known and an estimate for the rest and for the system prompt.
 * `extra` is what the request sends besides the history, such as tool definitions, which a count already holds;
 * `added` is room the request needs on top, such as an answer to continue, which no count holds yet.
 */
export function countedTokens(system: string, history: readonly Message[], ratio = 1, extra = 0, anchor?: Anchor, added = 0) {
  if (anchor && anchor.length <= history.length) return anchor.tokens + history.slice(anchor.length).reduce((total, message) => total + tokensOf(message, ratio), 0) + added;
  return Math.ceil((estimateText(system) + extra) * ratio) + history.reduce((total, message) => total + tokensOf(message, ratio), 0) + added;
}

/**
 * Moves the estimate toward what the runtime reported for a request (`estimated` is the unscaled estimate),
 * so later fitting follows its tokenizer rather than a guess. Bounded, so one odd report cannot undo the budget.
 */
export function calibrate(ratio: number, estimated: number, reported: number | undefined) {
  if (!reported || estimated < 200) return ratio;
  const measured = Math.min(3, Math.max(0.4, reported / estimated));
  return ratio === 1 ? measured : (ratio + measured) / 2;
}

/** Clearing stops once the request is this far under its limit, so it happens rarely and in one go. */
const CLEAR_TO = 0.75;

/** How a tool result starts for a model that calls tools by writing JSON, where it comes back as a user message. */
export const RESULT_PREFIX = "Result of ";
const textOf = (message: Message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
const CLEARED = "Its result was cleared to make room.]";
// What a cleared result keeps is which call it was, as claude-code and Hermes clear old tool output.
const cleared = (label: string) => `[${label}. ${CLEARED}`;
/** Whether a tool result is the line left by clearing, so the call may run again (./agent). */
export const isCleared = (text: string) => text.endsWith(CLEARED);

/**
 * Clears tool results of the run, oldest first, until the request fits well under its limit. Messages before
 * `from` are the conversation and stay. The results of the latest step stay whole: the model is reading them.
 * A cleared result says what was done, so the model knows it happened. It does not ask for the call again: a model
 * that reads everything back fills the window and clears it once more. The call is not refused if it does run again.
 * Returns how many were cleared and whether the request fits now.
 */
export function clearResults(system: string, history: readonly Message[], from: number, budget: Budget, ratio: number, labelOf: (id: string) => string, extra = 0, anchor?: Anchor, added = 0) {
  const fitted = [...history];
  if (!budget.window) return { history: fitted, cleared: 0, fits: true };
  const limit = inputLimit(budget);
  let size = countedTokens(system, fitted, ratio, extra, anchor, added);
  if (size <= limit) return { history: fitted, cleared: 0, fits: true };
  const latest = fitted.findLastIndex((message) => message.role === "assistant");
  let count = 0;
  for (let index = from; index < fitted.length && size > limit * CLEAR_TO; index++) {
    const message = fitted[index];
    if (index > latest) continue;
    let replacement: Message | undefined;
    const part = message.content[0];
    if (message.role === "tool" && part?.type === "tool-result" && !(part.result.type === "text" && isCleared(String(part.result.value))))
      replacement = Message.tool({ id: part.id, name: part.name, result: cleared(labelOf(part.id)), resultType: "text" });
    const text = message.role === "user" ? textOf(message) : "";
    if (text.startsWith(RESULT_PREFIX) && !isCleared(text))
      replacement = Message.user(cleared(text.slice(RESULT_PREFIX.length).split("\n")[0].replace(/:$/, "")));
    if (!replacement) continue;
    size -= tokensOf(message, ratio) - tokensOf(replacement, ratio);
    fitted[index] = replacement;
    count++;
  }
  return { history: fitted, cleared: count, fits: size <= limit };
}

type FinishUsage = Extract<LLMEvent, { type: "finish" }>["usage"];
/** A reported count far under the estimate is taken as one that left out the cached part. */
const LEAST_WHOLE = 1 / 3;
const estimatedPrompts = new WeakSet<object>();

/**
 * The prompt the window holds, from what the runtime reported. Cached tokens still sit in the
 * window, so the count must include them. A runtime that reports its cached part separately (Ollama's
 * prompt_eval_cached_count, the OpenAI API's cached_tokens) includes it in its total, as checked on Ollama 0.40.5.
 * One that reports no cached part and a count far under the estimate probably counted only what it processed anew:
 * the estimate stands in, the usage is marked estimated (isEstimatedPrompt), and `trusted` is false so the count
 * does not teach the budget.
 */
export function wholePrompt(usage: FinishUsage, estimated: number): { usage: FinishUsage; trusted: boolean } {
  const reported = usage?.inputTokens;
  if (!usage || reported === undefined) return { usage, trusted: false };
  if (usage.cacheReadInputTokens !== undefined || estimated < 200 || reported >= estimated * LEAST_WHOLE) return { usage, trusted: true };
  // A new Usage, not a spread copy: the class's visibleOutputTokens getter does not survive a spread.
  const whole = new Usage({ ...usage, inputTokens: estimated });
  estimatedPrompts.add(whole);
  return { usage: whole, trusted: false };
}

/** The usage's prompt count is the harness's estimate, not the runtime's (wholePrompt). */
export const isEstimatedPrompt = (usage: FinishUsage) => Boolean(usage && estimatedPrompts.has(usage));
