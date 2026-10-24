/**
 * Reasoning for the agent's structured calls. The agent asks for each step as JSON constrained by a schema;
 * some runtimes then think separately (Ollama streams `reasoning` beside the JSON), others reject the pair,
 * think inside the JSON or never finish the JSON. Each connection and model gets the first way that works:
 * - together: the schema and reasoning in one call.
 * - separate: reasoning without the schema; the JSON is read from the text.
 * - off: the schema without reasoning, as before reasoning was followed for steps.
 * A way is dropped after it fails twice for that model, and every failed call falls back at once. Together
 * also counts as failed when a model that reports thinking sends none, as when a grammar suppresses it.
 */
import { request as makeRequest } from "./vendor/llm/llm";
import { Message } from "./vendor/llm/schema";
import { layer, modelFor, thinkingOff, type ChatRequest } from "./chat";
import { endpoint } from "./runtime";
import { guardedStream, type Caps, type CallInfo } from "./guarded";
import { outputPlan, withBody } from "./output";
import { tuned } from "./sampling";
import { explainOverflow, learnOutput, learnRatio, measure } from "./profile/models";
import { Stopped } from "./loop-guard";
import { thinkingRequest } from "./thinking";
import { wholePrompt } from "./budget";

export type ThinkMode = "together" | "separate" | "off";
const MODES: ThinkMode[] = ["together", "separate", "off"];
const STRIKES = 2;

/** Failures per model and way, kept for the chat worker's lifetime. */
const strikes = new Map<string, number>();
const key = (body: ChatRequest, mode: ThinkMode) => `${endpoint(body.connection)}|${body.runtimeModelId}|${mode}`;
export const resetThinkModes = () => strikes.clear();
const strike = (body: ChatRequest, mode: ThinkMode) => strikes.set(key(body, mode), (strikes.get(key(body, mode)) ?? 0) + 1);

/** Off when the person turned thinking off for a model that reports it; otherwise follow the model. */
export const wantsThinking = (body: ChatRequest) => !(body.reasoningSupported && thinkingOff(body));

/** The ways still worth trying for this model, in order. */
export function thinkModes(body: ChatRequest): ThinkMode[] {
  if (!wantsThinking(body)) return ["off"];
  return MODES.filter((mode) => mode === "off" || (strikes.get(key(body, mode)) ?? 0) < STRIKES);
}

interface Call {
  body: ChatRequest;
  system: string;
  messages: Message[];
  schema?: object;
  /** False switches thinking off in the way the runtime understands, when the model reports thinking. */
  think: boolean;
  signal: AbortSignal;
  /** Output allowed for this call; by default what the budget leaves (budget.outputCap). */
  caps?: Caps;
  onReasoning?: (delta: string) => void;
  /** Called when the harness stops the call because it looped or ran past its cap. */
  onStopped?: (stopped: Stopped) => void;
  addUsage: (usage: unknown, call?: CallInfo) => void;
}

/**
 * One guarded call. Throws Stopped when it looped or ran too long; a runtime's "does not fit" error teaches
 * the window and says so.
 */
export async function streamCall(call: Call) {
  try {
    return await guardedCall(call);
  } catch (error) {
    throw error instanceof Stopped ? error : explainOverflow(call.body, error);
  }
}

async function guardedCall(call: Call) {
  // Only the sampling the person set for the model is sent; the rest stays the model's own or the runtime's.
  const thinks = call.think && wantsThinking(call.body) && Boolean(call.body.reasoningSupported);
  const measured = await measure(call.body, call.system, call.messages, thinks);
  const output = outputPlan(call.body.runtime, measured.budget, measured.input, measured.cap, thinks);
  const sent = tuned(call.body, thinks, output);
  const input = makeRequest(
    withBody(
      {
        model: modelFor(call.body),
        system: call.system,
        messages: call.messages,
        ...(await thinkingRequest(call.body, call.think)),
        ...(call.schema ? { responseFormat: { type: "json" as const, schema: call.schema as never } } : {}),
        ...(sent.generation ? { generation: sent.generation } : {}),
      },
      sent.body
    )
  );
  const { estimated } = measured;
  const result = await guardedStream({
    input,
    layer,
    connection: call.body.connection,
    signal: call.signal,
    caps: call.caps ?? output.caps,
    maxTokens: output.maxTokens,
    onUsage: (reported, info) => {
      const { usage, trusted } = wholePrompt(reported, estimated);
      if (trusted) learnRatio(call.body, estimated, usage?.inputTokens);
      learnOutput(call.body, thinks, usage?.outputTokens);
      call.addUsage(usage, info);
    },
    onPart: (part, text) => {
      if (part === "reasoning") call.onReasoning?.(text);
    },
  });
  if (result.stopped) {
    call.onStopped?.(result.stopped);
    throw result.stopped;
  }
  return { text: result.text, thought: result.thought };
}

const SEPARATE_PROMPT = (schema: object) =>
  `Think it through, then reply with only one JSON object matching this schema, without code fences:\n${JSON.stringify(schema)}`;

/**
 * A structured call that thinks when the model can. `parse` turns the text into a value or undefined when
 * it is unusable, which counts against the way used and moves on to the next one.
 */
export async function thinkingCall<T>(
  call: Omit<Call, "think"> & { schema: object; parse: (text: string) => T | undefined }
): Promise<{ value: T | undefined; mode: ThinkMode; thought: string }> {
  const modes = thinkModes(call.body);
  let skip = false;
  for (const mode of modes) {
    const last = mode === modes.at(-1);
    // Thinking that looped or ran too long is not tried again for this call; the model, not the way, is the problem.
    if (skip && !last) continue;
    try {
      const result = await streamCall({
        ...call,
        think: mode !== "off",
        schema: mode === "separate" ? undefined : call.schema,
        messages: mode === "separate" ? [...call.messages, Message.user(SEPARATE_PROMPT(call.schema))] : call.messages,
      });
      const value = call.parse(result.text);
      // A model that reports thinking but sent none here likely had it dropped by the schema: still use the
      // answer, but count it, so later steps try thinking without the schema.
      if (value !== undefined && mode === "together" && call.body.reasoningSupported && !result.thought.trim()) strike(call.body, mode);
      if (value !== undefined || last) return { value, mode, thought: result.thought };
    } catch (error) {
      if (error instanceof Stopped && last && !call.signal.aborted) return { value: undefined, mode, thought: "" };
      if (call.signal.aborted || last) throw error;
      if (error instanceof Stopped) {
        skip = true;
        continue;
      }
    }
    strike(call.body, mode);
  }
  return { value: undefined, mode: "off", thought: "" };
}

export interface ProbeResult {
  /** The first way that returned valid JSON, or undefined when none did. */
  mode?: ThinkMode;
  /** Each way tried: whether it answered with valid JSON, how much reasoning arrived, and any error. */
  tried: { mode: ThinkMode; valid: boolean; reasoning: number; ms: number; error?: string }[];
}

/**
 * Asks a small question each way, in order, and reports which works for this model, without remembering it.
 * The agent learns the same thing on its own; this is for checking a runtime by hand.
 */
export async function probeReasoning(body: ChatRequest, signal: AbortSignal, modes: ThinkMode[] = MODES): Promise<ProbeResult> {
  const schema = { type: "object", properties: { answer: { type: "string", enum: ["yes", "no"] } }, required: ["answer"] };
  const parse = (text: string) => {
    try {
      const value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      return value?.answer === "yes" || value?.answer === "no" ? value.answer : undefined;
    } catch {
      return undefined;
    }
  };
  const tried: ProbeResult["tried"] = [];
  for (const mode of modes) {
    const started = Date.now();
    try {
      const result = await streamCall({
        body,
        system: "Decide and return one JSON object.",
        messages: [Message.user("Is 91 a prime number?"), ...(mode === "separate" ? [Message.user(SEPARATE_PROMPT(schema))] : [])],
        schema: mode === "separate" ? undefined : schema,
        think: mode !== "off",
        signal,
        addUsage: () => {},
      });
      tried.push({ mode, valid: parse(result.text) !== undefined, reasoning: result.thought.length, ms: Date.now() - started });
    } catch (error) {
      if (signal.aborted) throw error;
      tried.push({ mode, valid: false, reasoning: 0, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { mode: tried.find((item) => item.valid && (item.mode === "off" || item.reasoning > 0))?.mode ?? tried.find((item) => item.valid)?.mode, tried };
}
