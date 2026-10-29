/**
 * Ollama's own chat API (/api/chat), used for every Ollama model instead of its OpenAI-compatible /v1. On /v1
 * Ollama fills in temperature and top_p as 1.0 when a request leaves them out, so "send no sampling" there
 * overrides the model's own values; on /api/chat a field left out means the Modelfile's value or the model's
 * default. It also takes `truncate: false` and `shift: false`, so a request that does not fit is refused with
 * the window named instead of cut from the front, and a reply that fills the window stops with done_reason
 * "length" instead of dropping the start of the conversation.
 *
 * Checked against Ollama 0.40.5 (Qwen3.5 4B): the stream is one JSON object per line; thinking arrives in
 * message.thinking; tool calls arrive whole, with an id and their arguments as an object; a trailing assistant
 * message is continued rather than answered; prompt_eval_count is the whole prompt and
 * prompt_eval_cached_count the part of it reused from the cache; an error is an {"error": "..."} object.
 *
 * Built on the vendored route pieces (src/harness/vendor/llm); this file itself is not vendored.
 */
import { Buffer } from "node:buffer";
import { Effect, Schema, Stream } from "effect";
import { Route } from "./vendor/llm/route/client";
import { Endpoint } from "./vendor/llm/route/endpoint";
import { Protocol } from "./vendor/llm/route/protocol";
import type { Framing } from "./vendor/llm/route/framing";
import { ProviderShared, JsonObject } from "./vendor/llm/protocols/shared";
import { OpenAIOptions } from "./vendor/llm/protocols/utils/openai-options";
import { Lifecycle } from "./vendor/llm/protocols/utils/lifecycle";
import { LLMEvent, Usage, type FinishReason, type LLMError, type LLMRequest, type MediaPart, type ToolContent } from "./vendor/llm/schema";

const ADAPTER = "ollama-chat";

const OllamaToolCall = Schema.Struct({
  id: Schema.optional(Schema.String),
  function: Schema.Struct({ index: Schema.optional(Schema.Number), name: Schema.String, arguments: Schema.Unknown }),
});

const OllamaMessage = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  content: Schema.String,
  images: Schema.optional(Schema.Array(Schema.String)),
  thinking: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(OllamaToolCall)),
  tool_name: Schema.optional(Schema.String),
  tool_call_id: Schema.optional(Schema.String),
});
type OllamaMessage = Schema.Schema.Type<typeof OllamaMessage>;

const OllamaBody = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(OllamaMessage),
  tools: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.Literal("function"), function: Schema.Struct({ name: Schema.String, description: Schema.String, parameters: JsonObject }) }))),
  format: Schema.optional(Schema.Unknown),
  think: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literals(["low", "medium", "high"])])),
  options: Schema.optional(JsonObject),
  stream: Schema.Literal(true),
  truncate: Schema.Literal(false),
  shift: Schema.Literal(false),
});
export type OllamaBody = Schema.Schema.Type<typeof OllamaBody>;

const OllamaEvent = Schema.Struct({
  message: Schema.optional(
    Schema.Struct({
      content: Schema.optional(Schema.String),
      thinking: Schema.optional(Schema.String),
      tool_calls: Schema.optional(Schema.NullOr(Schema.Array(OllamaToolCall))),
    })
  ),
  done: Schema.optional(Schema.Boolean),
  done_reason: Schema.optional(Schema.String),
  prompt_eval_count: Schema.optional(Schema.Number),
  prompt_eval_cached_count: Schema.optional(Schema.Number),
  eval_count: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
});
type OllamaEvent = Schema.Schema.Type<typeof OllamaEvent>;

/** One JSON object per line. */
const ndjson: Framing<string> = {
  id: "ndjson",
  frame: (bytes) =>
    bytes.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0)
    ),
};

/** Ollama takes three levels or on and off; the effort menu has more, mapped to the nearest. */
function think(request: LLMRequest): OllamaBody["think"] {
  const effort = OpenAIOptions.reasoningEffort(request);
  if (effort === undefined) return undefined;
  if (effort === "none") return false;
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

/** Images go as bare base64, without the data: prefix. */
function image(part: MediaPart | { mediaType: string; data: string }) {
  if (typeof part.data !== "string") return Buffer.from(part.data).toString("base64");
  const match = /^data:[^,]*;base64,(.*)$/s.exec(part.data);
  return match ? match[1] : part.data;
}

const lowerMessages = Effect.fn("OllamaChat.lowerMessages")(function* (request: LLMRequest) {
  const messages: OllamaMessage[] = request.system.length ? [{ role: "system", content: ProviderShared.joinText(request.system) }] : [];
  for (const message of request.messages) {
    if (message.role === "system") {
      // A system update mid-conversation reads as part of the user's turn, as on /v1.
      const part = yield* ProviderShared.wrappedSystemUpdate("Ollama", message);
      const previous = messages.at(-1);
      if (previous?.role === "user") messages[messages.length - 1] = { ...previous, content: `${previous.content}\n${part.text}` };
      else messages.push({ role: "user", content: part.text });
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") return yield* ProviderShared.unsupportedContent("Ollama", "tool", ["tool-result"]);
        const content: ReadonlyArray<ToolContent> | undefined = part.result.type === "content" ? part.result.value : undefined;
        const files = content?.filter((item) => item.type === "file") ?? [];
        messages.push({
          role: "tool",
          content: content ? content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n") : ProviderShared.toolResultText(part),
          tool_name: part.name,
          tool_call_id: part.id,
          ...(files.length ? { images: files.map((file) => image({ mediaType: file.mime, data: file.uri })) } : {}),
        });
      }
      continue;
    }
    const text: string[] = [];
    const thinking: string[] = [];
    const images: string[] = [];
    const calls: Schema.Schema.Type<typeof OllamaToolCall>[] = [];
    for (const part of message.content) {
      if (part.type === "text") text.push(part.text);
      else if (part.type === "media" && message.role === "user") images.push(image(part));
      else if (part.type === "reasoning" && message.role === "assistant") thinking.push(part.text);
      else if (part.type === "tool-call" && message.role === "assistant") calls.push({ id: part.id, function: { name: part.name, arguments: part.input ?? {} } });
      else return yield* ProviderShared.unsupportedContent("Ollama", message.role, message.role === "user" ? ["text", "media"] : ["text", "reasoning", "tool-call"]);
    }
    const previous = messages.at(-1);
    if (message.role === "user" && previous?.role === "user") {
      // Some chat templates (Gemma; older Mistral) refuse two user messages in a row, which the harness can
      // produce (a compaction summary, or a system update, before the latest user message). The two become one
      // turn, in order: text a blank line apart, images one after the other. Only user follows user here.
      const content = [previous.content, text.join("\n\n")].filter((piece) => piece !== "").join("\n\n");
      const merged = [...(previous.images ?? []), ...images];
      messages[messages.length - 1] = { ...previous, content, ...(merged.length ? { images: merged } : {}) };
      continue;
    }
    messages.push({
      role: message.role,
      // A user message's parts are the user's text and what the app adds beside it (attached files, notes), so a
      // blank line keeps each apart, as separate parts are on the OpenAI-compatible API.
      content: text.join(message.role === "user" ? "\n\n" : "\n"),
      ...(images.length ? { images } : {}),
      ...(thinking.length ? { thinking: thinking.join("") } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    });
  }
  return messages;
});

const fromRequest = Effect.fn("OllamaChat.fromRequest")(function* (request: LLMRequest) {
  const generation = request.generation;
  const options = Object.fromEntries(
    Object.entries({
      num_predict: generation?.maxTokens,
      temperature: generation?.temperature,
      top_p: generation?.topP,
      frequency_penalty: generation?.frequencyPenalty,
      presence_penalty: generation?.presencePenalty,
      seed: generation?.seed,
      stop: generation?.stop,
    }).filter(([, value]) => value !== undefined)
  );
  const level = think(request);
  return {
    model: request.model.id,
    messages: yield* lowerMessages(request),
    ...(request.tools.length
      ? { tools: request.tools.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> } })) }
      : {}),
    ...(request.responseFormat?.type === "json" ? { format: request.responseFormat.schema } : {}),
    ...(level !== undefined ? { think: level } : {}),
    // The window is the model's own (its Modelfile's num_ctx): sending one here would reload the model.
    ...(Object.keys(options).length ? { options } : {}),
    stream: true as const,
    truncate: false as const,
    shift: false as const,
  };
});

interface State {
  readonly lifecycle: Lifecycle.State;
  readonly calls: ReadonlyArray<LLMEvent>;
  readonly usage?: Usage;
  readonly finishReason?: FinishReason;
}

const finishReason = (reason: string | undefined, calls: boolean): FinishReason => {
  if (reason === "length") return "length";
  if (calls) return "tool-calls";
  return reason === "stop" ? "stop" : "unknown";
};

const step = (state: State, event: OllamaEvent): Effect.Effect<readonly [State, ReadonlyArray<LLMEvent>], LLMError> =>
  Effect.gen(function* () {
    if (event.error) return yield* ProviderShared.eventError(ADAPTER, event.error);
    const events: LLMEvent[] = [];
    let lifecycle = state.lifecycle;
    let calls = state.calls;
    const message = event.message;
    if (message?.thinking) lifecycle = Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", message.thinking);
    if (message?.content) {
      lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0");
      lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", message.content);
    }
    for (const call of message?.tool_calls ?? []) {
      lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0");
      lifecycle = Lifecycle.stepStart(lifecycle, events);
      const id = call.id || `call_${crypto.randomUUID()}`;
      const name = call.function.name;
      const input = typeof call.function.arguments === "string" ? yield* ProviderShared.parseToolInput(ADAPTER, name, call.function.arguments) : (call.function.arguments ?? {});
      // The call comes whole; its input is reported as one piece, as a streaming runtime's would add up to.
      events.push(LLMEvent.toolInputStart({ id, name }), LLMEvent.toolInputDelta({ id, name, text: ProviderShared.encodeJson(input) }));
      calls = [...calls, LLMEvent.toolInputEnd({ id, name }), LLMEvent.toolCall({ id, name, input })];
    }
    if (!event.done) return [{ ...state, lifecycle, calls }, events] as const;
    const usage = new Usage({
      inputTokens: event.prompt_eval_count,
      outputTokens: event.eval_count,
      nonCachedInputTokens: ProviderShared.subtractTokens(event.prompt_eval_count, event.prompt_eval_cached_count),
      cacheReadInputTokens: event.prompt_eval_cached_count,
      totalTokens: ProviderShared.totalTokens(event.prompt_eval_count, event.eval_count, undefined),
    });
    return [{ lifecycle, calls, usage, finishReason: finishReason(event.done_reason, calls.length > 0) }, events] as const;
  });

const onHalt = (state: State): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = [];
  const lifecycle = state.calls.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle;
  events.push(...state.calls);
  if (state.finishReason) Lifecycle.finish(lifecycle, events, { reason: state.finishReason, usage: state.usage });
  return events;
};

export const protocol = Protocol.make({
  id: ADAPTER,
  body: { schema: OllamaBody, from: fromRequest },
  stream: {
    event: Protocol.jsonEvent(OllamaEvent),
    initial: (): State => ({ lifecycle: Lifecycle.initial(), calls: [] }),
    step,
    onHalt,
  },
});

/** The route; the server's address is set per connection (see chat.modelFor). */
export const route = Route.make({ id: ADAPTER, protocol, endpoint: Endpoint.path("/api/chat"), framing: ndjson });

export * as OllamaChat from "./ollama-chat";
