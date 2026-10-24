/**
 * How long one call may write: to the end of the window, and no further. The room the window leaves is sent as
 * max_tokens (Ollama's num_predict; vLLM and llama.cpp count thinking in it), so the runtime stops on its own
 * tokenizer's count and reports `length` exactly when the window is full; an answer cut there is continued
 * (./continuation). Runtimes that take a thinking budget get one, so they close the thought and still answer
 * in the same call. The harness only watches: a loop is stopped at once, and a length past the room only when
 * a runtime ignored max_tokens. Ollama has no thinking budget, so the harness stops its thinking at its share.
 *
 * When the window is not known, nothing is sent and nothing is cut by length: the runtime stops at its own
 * window, and the harness watches for loops and silence only.
 */
import type { RuntimeId } from "../lib/models";
import type { Budget } from "./budget";
import type { Caps } from "./guarded";

/** Thinking's share of the cap, so an answer still fits after it. */
const THINKING = 0.75;
/** How far past the cap the harness lets a runtime go before it stops the call itself. */
const GUARD = 1.1;
/** Room left for the estimate being off, as a share of the request. */
const ESTIMATE_ERROR = 0.05;

/** The thinking budget each runtime takes per request; runtimes not listed take none. */
const BUDGET_FIELD: Partial<Record<RuntimeId, string>> = { vllm: "thinking_token_budget", llamacpp: "reasoning_budget_tokens" };

export interface OutputPlan {
  /** What the harness itself stops at. */
  caps: Caps;
  /** Sent to the runtime as max_tokens. */
  maxTokens?: number;
  /** Request fields for the thinking budget. */
  body?: Record<string, unknown>;
}

const UNBOUNDED: Caps = { reasoning: Number.POSITIVE_INFINITY, text: Number.POSITIVE_INFINITY };

/**
 * The plan for one call. `cap` is budget.outputCap for the request (the room the window leaves); `input` its
 * size in the runtime's tokens.
 * `retry` keeps the thinking of a call that is asked again after its thinking was stopped short.
 */
export function outputPlan(runtime: RuntimeId, budget: Budget, input: number, cap: number | undefined, thinking: boolean, retry = false): OutputPlan {
  if (!budget.window || !cap) return { caps: UNBOUNDED };
  const room = budget.window - input - Math.ceil(input * ESTIMATE_ERROR) - 16;
  const maxTokens = Math.max(64, Math.min(cap, room));
  const field = thinking ? BUDGET_FIELD[runtime] : undefined;
  const thought = Math.floor(maxTokens * (retry ? 0.1 : THINKING));
  const guard = Math.ceil(maxTokens * GUARD);
  return {
    maxTokens,
    ...(field ? { body: { [field]: thought } } : {}),
    // With a budget the runtime ends the thought itself; without one, the harness does at the same share.
    caps: { reasoning: field ? guard : Math.max(64, thought), text: guard, total: guard },
  };
}

/** Request fields merged: the thinking switch and the thinking budget both go in the body. */
export function withBody<T extends { http?: { body: Record<string, unknown> } }>(request: T, body: Record<string, unknown> | undefined): T {
  if (!body) return request;
  return { ...request, http: { ...request.http, body: { ...request.http?.body, ...body } } };
}
