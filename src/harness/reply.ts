/**
 * Streams a reply to the chat, for plain chats and for the agent's answer. Thinking that loops or fills its
 * share of the window is stopped and the reply is asked for once more with thinking switched off for that
 * runtime, and told to answer directly. A reply that loops is stopped where it is; one that fills the window
 * is continued in the same answer once room is made (./continuation). A note in the message says what
 * happened.
 */
import type { FinishReason, UIMessageStreamWriter } from "ai";
import { request as makeRequest } from "./vendor/llm/llm";
import type { LLMEvent, Message } from "./vendor/llm/schema";
import { layer, modelFor, thinkingOff, type ChatRequest } from "./chat";
import { guardedStream, type CallInfo } from "./guarded";
import { Stopped, type Watched } from "./loop-guard";
import { outputPlan, withBody } from "./output";
import { tuned } from "./sampling";
import { thinkingRequest } from "./thinking";
import { continueAnswer } from "./continuation";
import { explainOverflow, learnOutput, learnRatio, measure } from "./profile/models";
import type { AppUIMessage } from "../lib/types";
import { wholePrompt } from "./budget";

type FinishUsage = Extract<LLMEvent, { type: "finish" }>["usage"];

export interface ReplyOptions {
  body: ChatRequest;
  system: string;
  messages: Message[];
  writer: UIMessageStreamWriter<AppUIMessage>;
  signal: AbortSignal;
  /** Called with each call's reported usage; a retried reply reports twice. */
  onUsage?: (usage: FinishUsage, call?: CallInfo) => void;
  /** Turns a streamed tool call into an error, for a chat that runs no tools. */
  rejectToolCalls?: string;
  /** Frees room to continue an answer of this many tokens; see ContinueOptions.makeRoom. */
  makeRoom?: (answerTokens: number) => Promise<Message[] | undefined>;
}

/** Whether the person wants this model to think: on unless they turned it off for a model that reports it. */
const thinks = (body: ChatRequest) => Boolean(body.reasoningSupported) && !thinkingOff(body);

const DIRECT = "Answer directly now. Do not deliberate at length; keep any thinking to a few sentences.";

/** The part being written. It stays open between calls, so a continued answer goes on in the same part. */
class Parts {
  open: { part: Watched; id: string } | undefined;
  constructor(private readonly writer: ReplyOptions["writer"]) {}
  write(part: Watched, delta: string) {
    if (this.open?.part !== part) {
      this.close();
      this.open = { part, id: `${part}-${crypto.randomUUID()}` };
      this.writer.write({ type: part === "text" ? "text-start" : "reasoning-start", id: this.open.id });
    }
    this.writer.write({ type: part === "text" ? "text-delta" : "reasoning-delta", id: this.open.id, delta });
  }
  close() {
    if (this.open) this.writer.write({ type: this.open.part === "text" ? "text-end" : "reasoning-end", id: this.open.id });
    this.open = undefined;
  }
}

async function once(options: ReplyOptions, parts: Parts, retry: boolean) {
  const { body } = options;
  const think = !retry;
  const system = retry ? `${options.system}\n\n${DIRECT}` : options.system;
  const measured = await measure(body, system, options.messages, think && thinks(body));
  const output = outputPlan(body.runtime, measured.budget, measured.input, measured.cap, think && thinks(body), retry);
  // Only the sampling the person set for the model is sent; the rest stays the model's own or the runtime's.
  const sent = tuned(body, think && thinks(body), output);
  const input = makeRequest(
    withBody(
      {
        model: modelFor(body),
        system,
        messages: options.messages,
        ...(await thinkingRequest(body, think, retry)),
        ...(sent.generation ? { generation: sent.generation } : {}),
      },
      sent.body
    )
  );
  const { estimated } = measured;
  const result = await guardedStream({
    input,
    layer,
    connection: body.connection,
    signal: options.signal,
    caps: output.caps,
    maxTokens: output.maxTokens,
    onUsage: (reported, call) => {
      // A count that left out the cached prompt is replaced by the estimate and teaches nothing (budget.wholePrompt).
      const { usage, trusted } = wholePrompt(reported, estimated);
      if (trusted) learnRatio(body, estimated, usage?.inputTokens);
      // A reply stopped for looping says nothing about how long this model's answers run.
      if (!retry) learnOutput(body, think && thinks(body), usage?.outputTokens);
      options.onUsage?.(usage, call);
    },
    rejectToolCalls: options.rejectToolCalls,
    onPart: (part, text) => parts.write(part, text),
  });
  return { ...result, system };
}

const note = (writer: ReplyOptions["writer"], stopped: { part: Watched; reason: "loop" | "limit" }, retried = false) =>
  writer.write({ type: "data-loop", data: { part: stopped.part, reason: stopped.reason, ...(retried ? { retried } : {}) } });

/** Streams the reply and returns why it finished. */
export async function streamReply(options: ReplyOptions): Promise<FinishReason> {
  try {
    return await reply(options);
  } catch (error) {
    throw explainOverflow(options.body, error);
  }
}

async function reply(options: ReplyOptions): Promise<FinishReason> {
  const parts = new Parts(options.writer);
  const done = (stopped?: Stopped, retried = false) => {
    parts.close();
    if (stopped) note(options.writer, stopped, retried);
  };
  // An answer that filled the window goes on where it stopped; one that still ends there gets the note.
  const goOn = async (answer: string, system: string) => {
    const end = await continueAnswer({
      body: options.body,
      system,
      messages: options.messages,
      answer,
      signal: options.signal,
      onText: (delta) => parts.write("text", delta),
      onUsage: options.onUsage,
      makeRoom: options.makeRoom ?? (async () => undefined),
    });
    done(end.stopped ?? (end.full ? new Stopped("text", "limit") : undefined));
    return end.finishReason;
  };
  const first = await once(options, parts, false);
  // The runtime stopped at the window: an answer cut there goes on; thinking that used it all left none.
  if (!first.stopped && first.finishReason === "length") {
    if (first.text.trim() || !first.thought.trim()) return goOn(first.text, first.system);
    first.stopped = new Stopped("reasoning", "limit");
  }
  if (!first.stopped) {
    done();
    return first.finishReason;
  }
  // A reply that was already being written is kept as far as it got.
  if (first.stopped.part === "text") {
    done(first.stopped);
    return "other";
  }
  // The note goes between the stopped thought and the new reply.
  done(first.stopped, true);
  const second = await once(options, parts, true);
  if (!second.stopped && second.finishReason === "length" && second.text.trim()) return goOn(second.text, second.system);
  done(second.stopped ?? (second.finishReason === "length" ? new Stopped("text", "limit") : undefined));
  return second.finishReason;
}
