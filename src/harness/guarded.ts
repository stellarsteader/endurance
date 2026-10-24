/**
 * The one way the harness reads a model's output, whatever the runtime or model. Every call streams, so it
 * can be watched, and stops when it loops or passes its length cap. Thinking arrives either in a separate
 * field (Ollama, llama.cpp, vLLM, LM Studio with a reasoning parser) or wrapped in tags inside the text;
 * both come out as "reasoning" pieces. The caps are counted here, not sent as max_tokens: a runtime may
 * ignore max_tokens, count thinking differently or reject a value larger than its context.
 * A call also stops when the runtime sends nothing for too long: first while it reads the request, then
 * between pieces. A model that is not loaded is loaded before the call (profile/models), so its loading time
 * is not counted here.
 */
import type { FinishReason } from "ai";
import { Effect, Stream } from "effect";
import { LLMClient } from "./vendor/llm/route/client";
import type { request as makeRequest } from "./vendor/llm/llm";
import type { LLMEvent } from "./vendor/llm/schema";
import { withSlot } from "./limit";
import { loopWatch, Stopped, type Watched } from "./loop-guard";
import { thinkSplitter } from "./think-tags";
import { transient } from "./failure";
import { brokenArguments, repairJson } from "./tool-support";
import type { RuntimeConnection } from "../lib/models";

/** Output allowed per call, in tokens: for thinking, for the reply text, and for both together. */
export interface Caps {
  reasoning: number;
  text: number;
  total?: number;
}

/** Below this the request has already filled the window; the call still gets a little room to say so. */
const MIN_ROOM = 256;

/**
 * A call's caps from an output cap (such as a summary's share): thinking may take three quarters, so an answer still
 * fits after it, and both together the whole cap. Calls that send the cap to the runtime use ./output instead.
 */
export function capsFor(cap: number | undefined): Caps {
  // An unknown window sets no length: the runtime stops at its own; loops and silence are still watched.
  if (!cap) return { reasoning: Number.POSITIVE_INFINITY, text: Number.POSITIVE_INFINITY };
  return { reasoning: Math.max(MIN_ROOM, Math.floor(cap * 0.75)), text: cap, total: cap };
}


/** Waits before giving up on a silent runtime: for its first piece, and between pieces once it streams. */
export const WAIT = { first: 300_000, idle: 120_000 };

/** Waits before trying a dropped connection again. */
const RETRIES = [1000, 2000, 4000];

/** The runtime sent nothing for too long; `first` when it never started answering. */
export class Silent extends Error {
  constructor(readonly first: boolean, seconds: number) {
    super(first ? `The model did not start answering within ${seconds} seconds.` : `The model stopped sending output for ${seconds} seconds.`);
    this.name = "Silent";
  }
}

type FinishUsage = Extract<LLMEvent, { type: "finish" }>["usage"];

/** What a call's usage alone does not say: how long it generated, and what its output held besides the reply. */
export interface CallInfo {
  /** From the first piece to the finish: the time the runtime spent writing, after it read the prompt. */
  decodeMs?: number;
  thought: boolean;
  /** It called tools, whose arguments the runtime counts as output too. */
  tools: boolean;
}

export interface GuardedOptions {
  input: ReturnType<typeof makeRequest>;
  layer: typeof import("./chat").layer;
  /** Shares the server's request slots; omitted where the caller manages none. */
  connection?: RuntimeConnection;
  signal: AbortSignal;
  caps: Caps;
  /** Each piece as it arrives, thinking split from text. */
  onPart?: (part: Watched, text: string) => void;
  onUsage?: (usage: FinishUsage, call: CallInfo) => void;
  /** Turns a streamed tool call into an error, for calls that run no tools. */
  rejectToolCalls?: string;
  /** Overrides the waits, for tests. */
  wait?: typeof WAIT;
  /** The max_tokens sent with the request, if any: a call cut there is not repaired as if it were whole. */
  maxTokens?: number;
}

export interface StreamedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface GuardedResult {
  text: string;
  thought: string;
  /** Set when the harness stopped the stream: what was looping or too long. */
  stopped?: Stopped;
  finishReason: FinishReason;
  /** Tool calls the model made, in order. */
  toolCalls: StreamedToolCall[];
}

export async function guardedStream(options: GuardedOptions): Promise<GuardedResult> {
  // Our own stop for loops and caps, separate from the person's Stop.
  const controller = new AbortController();
  const stop = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) stop();
  else options.signal.addEventListener("abort", stop, { once: true });
  const watch = loopWatch();
  const split = thinkSplitter();
  const result = { text: "", thought: "" };
  const pieces: Record<Watched, number> = { reasoning: 0, text: 0 };
  const chars: Record<Watched, number> = { reasoning: 0, text: 0 };
  let stopped: Stopped | undefined;
  let finishReason: FinishReason = "stop";
  const toolCalls: StreamedToolCall[] = [];
  // Each call's arguments as streamed, to repair them if the runtime's own parse fails at the end.
  const raw = new Map<string, { name: string; text: string }>();
  const wait = options.wait ?? WAIT;
  let silent: Silent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Tells the request slot when the first piece arrived (see limit.firstPiece).
  let firstPiece: (() => void) | undefined;
  // When the runtime began writing: generation speed is counted from here, not from the request.
  let writingSince: number | undefined;
  // Restarted on every piece the runtime sends; firing stops the call as silent.
  const arm = (first: boolean) => {
    clearTimeout(timer);
    const ms = first ? wait.first : wait.idle;
    timer = setTimeout(() => {
      silent = new Silent(first, Math.round(ms / 1000));
      controller.abort(silent);
    }, ms);
  };
  arm(true);

  /** The streamed calls with their arguments repaired, or undefined when any of them cannot be. */
  const repairCalls = () => {
    const pending = [...raw].filter(([id]) => !toolCalls.some((call) => call.id === id));
    const calls = pending.map(([id, entry]) => ({ id, name: entry.name, input: repairJson(entry.text) }));
    return calls.length && calls.every((call) => call.input !== undefined) ? calls : undefined;
  };
  const countTool = (text: string) => {
    chars.text += text.length;
    pieces.text++;
    const tokens = Math.max(pieces.text, Math.ceil(chars.text / 4));
    if (tokens > options.caps.text) {
      stopped = new Stopped("text", "limit");
      controller.abort(stopped);
    }
  };
  const take = (part: Watched, text: string) => {
    if (stopped || !text) return;
    if (part === "text") result.text += text;
    else result.thought += text;
    pieces[part]++;
    chars[part] += text.length;
    options.onPart?.(part, text);
    // Runtimes stream about one token per delta; long deltas are counted at about four characters a token.
    const tokens = Math.max(pieces[part], Math.ceil(chars[part] / 4));
    const looped = watch.add(part, text);
    const other: Watched = part === "text" ? "reasoning" : "text";
    const together = tokens + Math.max(pieces[other], Math.ceil(chars[other] / 4));
    if (looped) stopped = new Stopped(looped, "loop");
    else if (tokens > options.caps[part] || (options.caps.total && together > options.caps.total)) stopped = new Stopped(part, "limit");
    if (stopped) controller.abort(stopped);
  };

  const program = LLMClient.stream(options.input).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (stopped) return;
        arm(false);
        firstPiece?.();
        // An empty first piece (a role-only chunk) can come before the prompt is read, so writing starts at the first text.
        if (writingSince === undefined && (event.type === "reasoning-delta" || event.type === "text-delta" || event.type === "tool-input-delta") && event.text) writingSince = Date.now();
        if (event.type === "reasoning-delta") take("reasoning", event.text);
        if (event.type === "text-delta") for (const piece of split.feed(event.text)) take(piece.part, piece.text);
        // A tool call's arguments are output too: a written file counts toward the cap like text.
        if (event.type === "tool-input-start") raw.set(event.id, { name: event.name, text: "" });
        if (event.type === "tool-input-delta") {
          const entry = raw.get(event.id);
          if (entry) entry.text += event.text;
          countTool(event.text);
        }
        if (event.type === "provider-error") throw new Error(event.message);
        if (event.type === "tool-call" && options.rejectToolCalls) throw new Error(options.rejectToolCalls);
        if (event.type === "tool-call") toolCalls.push({ id: event.id, name: event.name, input: event.input });
        if (event.type === "finish") {
          options.onUsage?.(event.usage, { ...(writingSince !== undefined ? { decodeMs: Date.now() - writingSince } : {}), thought: pieces.reasoning > 0, tools: toolCalls.length > 0 || raw.size > 0 });
          finishReason = event.reason === "unknown" ? "other" : event.reason;
        }
      })
    ),
    Effect.provide(options.layer)
  );
  // A connection that dropped is tried again, a few times, while nothing has arrived yet. A busy server is
  // tried again by the client itself (vendor route/executor).
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await Effect.runPromise(program, { signal: controller.signal });
      } catch (error) {
        const started = pieces.reasoning + pieces.text + toolCalls.length > 0;
        if (started || stopped || silent || controller.signal.aborted || attempt >= RETRIES.length || !transient(error)) throw error;
        clearTimeout(timer);
        await new Promise((resolve) => setTimeout(resolve, RETRIES[attempt]));
        if (controller.signal.aborted) throw error;
        arm(true);
      }
    }
  };
  try {
    // Waiting for a request slot is not the runtime's silence.
    await (options.connection
      ? withSlot({ connection: options.connection, runtime: String(options.input.model.provider), model: String(options.input.model.id) }, controller.signal, (slot) => {
          firstPiece = slot.first;
          arm(true);
          return run();
        })
      : run());
  } catch (error) {
    if (silent && !options.signal.aborted) throw silent;
    const broken = !stopped && !options.signal.aborted && brokenArguments(error instanceof Error ? error.message : String(error));
    // Arguments that ran into max_tokens were cut, not mistyped: closing them would run half a call.
    const written = Math.max(pieces.reasoning + pieces.text, Math.ceil((chars.reasoning + chars.text) / 4));
    if (broken && options.maxTokens && written >= options.maxTokens * 0.9) stopped = new Stopped("text", "limit");
    const repaired = broken && !stopped ? repairCalls() : undefined;
    if (repaired) {
      toolCalls.push(...repaired);
      finishReason = "tool-calls";
    } else if (!stopped || options.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
  }
  if (!stopped) for (const piece of split.flush()) take(piece.part, piece.text);
  return { ...result, stopped, toolCalls, finishReason: stopped ? "other" : finishReason };
}
