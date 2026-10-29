/**
 * Continuing an answer the window cut off, in the same answer. Output stops only at the window (./output), so
 * an answer that ends with `length` filled it. Room is made the usual way (older tool results cleared, older
 * turns summarized, each at most once per request), then the answer so far goes back as the last assistant
 * message, which the runtime continues instead of starting a new turn, and what comes back is appended to the
 * same answer on screen.
 *
 * - Only runtimes known to continue a trailing assistant message are asked: Ollama's /api/chat and llama.cpp
 *   do it by default, vLLM and SGLang with continue_final_message. Elsewhere the answer stays cut, with a note
 *   and the Continue button, which asks in a new message.
 * - The answer's thinking is not sent back, which frees its room, and the continuation is asked without
 *   thinking, so it goes on writing instead of starting to deliberate again.
 * - A model often repeats the last words it was given; that overlap is cut before it is shown.
 * - It ends when there is too little room to go on, a round adds almost nothing, the loop guard stops it, or
 *   after MAX_ROUNDS rounds.
 */
import type { FinishReason } from "ai";
import { request as makeRequest } from "./vendor/llm/llm";
import { Message, type LLMEvent } from "./vendor/llm/schema";
import { layer, modelFor, type ChatRequest } from "./chat";
import { guardedStream, type CallInfo } from "./guarded";
import type { Stopped } from "./loop-guard";
import { outputPlan, withBody } from "./output";
import { tuned } from "./sampling";
import { thinkingRequest } from "./thinking";
import { learnRatio, measure } from "./profile/models";
import { estimateText } from "../lib/token-estimate";
import type { RuntimeId } from "../lib/models";
import { wholePrompt } from "./budget";

type FinishUsage = Extract<LLMEvent, { type: "finish" }>["usage"];

/** Request fields that make each runtime continue the last assistant message; runtimes not listed are not asked. */
const CONTINUES: Partial<Record<RuntimeId, Record<string, unknown>>> = {
  ollama: {},
  llamacpp: {},
  vllm: { continue_final_message: true, add_generation_prompt: false },
  sglang: { continue_final_message: true, add_generation_prompt: false },
};

export const continues = (runtime: RuntimeId) => runtime in CONTINUES;

/** Rounds one answer may be continued. */
const MAX_ROUNDS = 4;
/** A round that adds fewer tokens than this ends it: the model has nothing more, or no room to say it. */
const LEAST_ROUND = 16;
/** Text held back at the start of a round, to cut what repeats the answer's end. */
const HOLD = 200;
/** A shorter repeat may be the text itself; it is kept. */
const LEAST_OVERLAP = 12;

/** How many characters at the start of `next` repeat the end of `previous`. */
export function overlap(previous: string, next: string) {
  for (let size = Math.min(previous.length, next.length, HOLD); size >= LEAST_OVERLAP; size--) if (previous.endsWith(next.slice(0, size))) return size;
  return 0;
}

/** The room a round needs: an eighth of the window, as the output reserve at its least. */
const roomNeeded = (window: number) => Math.max(256, Math.floor(window / 8));

export interface ContinueOptions {
  body: ChatRequest;
  system: string;
  /** The conversation the answer replies to. */
  messages: Message[];
  /** The answer so far, as shown. */
  answer: string;
  signal: AbortSignal;
  onText: (delta: string) => void;
  onUsage?: (usage: FinishUsage, call?: CallInfo) => void;
  /** Frees room for an answer of this many tokens: the conversation to send now, or undefined to keep it. */
  makeRoom: (answerTokens: number) => Promise<Message[] | undefined>;
}

export interface ContinueEnd {
  finishReason: FinishReason;
  stopped?: Stopped;
  /** The answer still ends at the window: it could not go on, or ran out of rounds. */
  full?: boolean;
}

export async function continueAnswer(options: ContinueOptions): Promise<ContinueEnd> {
  const { body, system, signal } = options;
  const fields = CONTINUES[body.runtime];
  if (!fields) return { finishReason: "length", full: true };
  let answer = options.answer;
  let messages = options.messages;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    messages = (await options.makeRoom(estimateText(answer))) ?? messages;
    const sent = [...messages, Message.assistant(answer)];
    const measured = await measure(body, system, sent, false);
    const window = measured.budget.window;
    if (window && window - measured.input < roomNeeded(window)) return { finishReason: "length", full: true };
    const output = outputPlan(body.runtime, measured.budget, measured.input, measured.cap, false);
    // Continuing without thinking, so with the set for thinking off.
    const tuning = tuned(body, false, output);
    const input = makeRequest(
      withBody(
        {
          model: modelFor(body),
          system,
          messages: sent,
          ...(await thinkingRequest(body, false)),
          ...(tuning.generation ? { generation: tuning.generation } : {}),
        },
        { ...tuning.body, ...fields }
      )
    );
    let held = "";
    let flushed = false;
    let added = "";
    const show = (text: string) => {
      if (!text) return;
      added += text;
      options.onText(text);
    };
    const flush = () => {
      if (flushed) return;
      flushed = true;
      show(held.slice(overlap(answer, held)));
    };
    const result = await guardedStream({
      input,
      layer,
      connection: body.connection,
      signal,
      caps: output.caps,
      maxTokens: output.maxTokens,
      onUsage: (reported, call) => {
        const { usage, trusted } = wholePrompt(reported, measured.estimated);
        if (trusted) learnRatio(body, measured.estimated, usage?.inputTokens);
        options.onUsage?.(usage, call);
      },
      // Thinking asked off but sent anyway is not shown: it would split the answer it continues.
      onPart: (part, text) => {
        if (part !== "text") return;
        if (flushed) return show(text);
        held += text;
        if (held.length >= HOLD) flush();
      },
    });
    flush();
    answer += added;
    if (result.stopped) return { finishReason: "other", stopped: result.stopped };
    if (result.finishReason !== "length") return { finishReason: result.finishReason };
    if (estimateText(added) < LEAST_ROUND) return { finishReason: "length", full: true };
  }
  return { finishReason: "length", full: true };
}
