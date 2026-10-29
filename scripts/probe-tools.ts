/**
 * Checks, against a running runtime, what the agent's tool-call requests assume and loopback fakes cannot
 * confirm: that `parallel_tool_calls` is taken, that the chat template takes several calls in one message,
 * which field it reads earlier thinking from, and that the merged summary + latest message is taken. Bodies are
 * built by the harness's own lowering, so this checks what the app sends. Where the server can render the
 * prompt (vLLM /tokenize, llama.cpp /apply-template) nothing is generated; elsewhere one short generation is
 * sent and judged by whether it is accepted. Nothing is saved. Run by hand when a runtime or the request shape
 * changes; it is not part of npm test.
 *
 *   npm run probe:tools -- --model gemma4:e4b-mlx
 *   npm run probe:tools -- --runtime vllm --base http://127.0.0.1:8000/v1 --model Qwen/Qwen3-4B
 *   npm run probe:tools -- --runtime llamacpp --model any --generate
 *
 * --generate also asks for three independent reads with the agent's batching sentence and counts the calls.
 */
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { request as makeRequest } from "../src/harness/vendor/llm/llm";
import { Message } from "../src/harness/vendor/llm/schema";
import { OpenAIChat } from "../src/harness/vendor/llm/protocols/openai-chat";
import { OllamaChat } from "../src/harness/ollama-chat";
import { Ollama } from "../src/harness/vendor/schema/ollama";
import { modelFor, type ChatRequest } from "../src/harness/chat";
import { BATCHING, oneCallPerMessage, PARALLEL_FIELD } from "../src/harness/agent";
import { singleCallTemplate } from "../src/harness/tool-support";
import { definitions } from "../src/harness/tools";
import { RUNTIMES, isRuntimeId } from "../src/lib/models";

const { values } = parseArgs({
  options: {
    runtime: { type: "string", default: "ollama" },
    base: { type: "string" },
    model: { type: "string" },
    "api-key": { type: "string", default: "" },
    generate: { type: "boolean", default: false },
  },
});
if (!values.model || !isRuntimeId(values.runtime)) {
  console.error("Usage: npm run probe:tools -- --model <runtime model id> [--runtime ollama] [--base http://127.0.0.1:11434/v1] [--api-key KEY] [--generate]");
  process.exit(2);
}
const runtime = values.runtime;
const base = (values.base ?? RUNTIMES.find((item) => item.id === runtime)!.baseUrl).replace(/\/+$/, "");
if (!base) {
  console.error(`--base is required for ${runtime}.`);
  process.exit(2);
}
const apiKey = values["api-key"];
const native = runtime === "ollama";
const model = modelFor({ runtime, runtimeModelId: values.model, connection: { baseUrl: base, apiKey } } as unknown as ChatRequest);
// The server's own endpoints (/api/chat, /tokenize, /apply-template) sit beside /v1, not under it.
const root = Ollama.baseURL(base);
const chatUrl = native ? `${root}/api/chat` : `${base}/chat/completions`;
const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };


/** Whether later bodies carry parallel_tool_calls: only once check 1 found it taken, so a refusal there is not
 * repeated as every other check's failure. */
let sendParallel = false;

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

type Body = Record<string, unknown> & { messages: Record<string, unknown>[] };

/** The body the harness would send for these messages: its own lowering, then the extra field nativeTurn adds. */
async function lowered(messages: Message[], options: { system?: string; maxTokens?: number; parallel?: boolean } = {}): Promise<Body> {
  const input = makeRequest({ model, system: options.system ?? "You are a coding assistant.", messages, tools: definitions(["read"]), generation: { maxTokens: options.maxTokens ?? 16 } });
  const body = native ? await Effect.runPromise(OllamaChat.protocol.body.from(input)) : await Effect.runPromise(OpenAIChat.protocol.body.from(input));
  // Through JSON, as it is sent: fields left undefined drop out.
  const plain = JSON.parse(JSON.stringify(body)) as Body;
  return (options.parallel ?? sendParallel) ? { ...plain, parallel_tool_calls: true } : plain;
}

/** One line of a server's error, from whichever shape it uses ({error: "..."}, {error: {message}}, {message}, {detail}). */
function errorText(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { error?: string | { message?: string }; message?: string; detail?: unknown };
    const found = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message ?? parsed.detail);
    if (found !== undefined) return oneLine(typeof found === "string" ? found : JSON.stringify(found));
  } catch {
    // Not JSON: the text itself.
  }
  return oneLine(raw);
}
const oneLine = (text: string, most = 400) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most)}…` : flat;
};

interface Sent {
  ok: boolean;
  status: number;
  error?: string;
  promptTokens?: number;
  calls: { name: string; args: string }[];
  text: string;
  ms: number;
}

/** One generation on the chat route the harness uses, read to the end of its stream (ndjson or SSE). */
async function generate(body: Body, timeoutMs = 120_000): Promise<Sent> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) });
  } catch (error) {
    return { ok: false, status: 0, error: `no response: ${(error as Error).message}`, calls: [], text: "", ms: Date.now() - started };
  }
  const raw = await response.text();
  const ms = Date.now() - started;
  if (!response.ok) return { ok: false, status: response.status, error: errorText(raw), calls: [], text: "", ms };
  const calls = new Map<string, { name: string; args: string }>();
  let text = "";
  let promptTokens: number | undefined;
  let error: string | undefined;
  for (const line of raw.split("\n")) {
    const data = line.replace(/^data:\s*/, "").trim();
    if (!data || data === "[DONE]" || line.startsWith("event:")) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.error) error = typeof event.error === "string" ? event.error : (event.error.message ?? JSON.stringify(event.error));
    // Ollama: tool calls come whole, arguments as an object; prompt_eval_count is the whole prompt.
    if (event.message) {
      text += event.message.content ?? "";
      for (const call of event.message.tool_calls ?? []) calls.set(String(calls.size), { name: call.function?.name ?? "", args: JSON.stringify(call.function?.arguments ?? {}) });
    }
    if (typeof event.prompt_eval_count === "number") promptTokens = event.prompt_eval_count;
    // OpenAI-compatible: tool calls stream in pieces keyed by index.
    const delta = event.choices?.[0]?.delta;
    if (delta) {
      text += delta.content ?? "";
      for (const piece of delta.tool_calls ?? []) {
        const key = String(piece.index ?? piece.id ?? calls.size);
        const call = calls.get(key) ?? { name: "", args: "" };
        calls.set(key, { name: call.name + (piece.function?.name ?? ""), args: call.args + (piece.function?.arguments ?? "") });
      }
    }
    if (typeof event.usage?.prompt_tokens === "number") promptTokens = event.usage.prompt_tokens;
  }
  return { ok: !error, status: response.status, ...(error ? { error: oneLine(error) } : {}), promptTokens, calls: [...calls.values()], text, ms };
}

/** One streamed piece, as Ollama (`message`) or an OpenAI-compatible server (`choices`) writes it. */
interface StreamEvent {
  error?: string | { message?: string };
  message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  prompt_eval_count?: number;
  choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number };
}

/** Whether this server can render a chat prompt without generating; cleared when the endpoint turns out missing. */
let renders = runtime === "vllm" || runtime === "llamacpp";

/** The rendered prompt, or the server's refusal; undefined when the server has no render endpoint. */
async function render(body: Body): Promise<{ prompt: string } | { refused: string } | undefined> {
  if (!renders) return undefined;
  const post = async (path: string, payload: unknown) => {
    const response = await fetch(`${root}${path}`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
    return { status: response.status, raw: await response.text() };
  };
  try {
    // llama.cpp parses /apply-template as it does a chat request, so the whole body goes.
    const first =
      runtime === "llamacpp"
        ? await post("/apply-template", body)
        : await post("/tokenize", { model: body.model, messages: body.messages, ...(body.tools ? { tools: body.tools } : {}), add_generation_prompt: true });
    if (first.status === 404 || first.status === 405) {
      renders = false;
      console.log(`(${root}${runtime === "llamacpp" ? "/apply-template" : "/tokenize"} answered ${first.status}; judging by one short generation instead)`);
      return undefined;
    }
    if (first.status >= 400) return { refused: `HTTP ${first.status}: ${errorText(first.raw)}` };
    const parsed = JSON.parse(first.raw) as { prompt?: string; tokens?: number[] };
    if (runtime === "llamacpp") return { prompt: parsed.prompt ?? "" };
    const second = await post("/detokenize", { model: body.model, tokens: parsed.tokens ?? [] });
    if (second.status >= 400) return { refused: `detokenize HTTP ${second.status}: ${errorText(second.raw)}` };
    return { prompt: (JSON.parse(second.raw) as { prompt?: string }).prompt ?? "" };
  } catch (error) {
    return { refused: `no response: ${(error as Error).message}` };
  }
}

type Outcome = { accepted: true; prompt?: string; sent?: Sent } | { accepted: false; error: string };

/** Rendered where the server can, otherwise one short generation judged by acceptance. */
async function attempt(body: Body): Promise<Outcome> {
  const rendered = await render(body);
  if (rendered && "prompt" in rendered) return { accepted: true, prompt: rendered.prompt };
  if (rendered) return { accepted: false, error: rendered.refused };
  const sent = await generate(body);
  return sent.ok ? { accepted: true, sent } : { accepted: false, error: sent.status ? `HTTP ${sent.status}: ${sent.error}` : sent.error! };
}

const acceptedAs = (outcome: Outcome & { accepted: true }) =>
  outcome.prompt !== undefined
    ? "rendered"
    : `HTTP ${outcome.sent!.status}${outcome.sent!.promptTokens !== undefined ? `, prompt ${outcome.sent!.promptTokens} tokens` : ""}, ${(outcome.sent!.ms / 1000).toFixed(1)}s`;

/** The rendered prompt around the given strings, so the evidence shows them in place. */
function excerpt(prompt: string, from: string, to = from, most = 700) {
  const start = Math.max(0, prompt.indexOf(from) - 120);
  const end = prompt.indexOf(to) >= 0 ? prompt.indexOf(to) + to.length + 80 : start + most;
  const piece = prompt.slice(start, Math.min(end, start + most));
  return piece.replace(/\n/g, "⏎");
}

function report(number: number, name: string, verdict: "PASS" | "FAIL" | "SKIP", reason: string, evidence: string[] = []) {
  console.log(`\n${number}. ${name}: ${verdict} — ${reason}`);
  for (const line of evidence) console.log(`   ${line}`);
}

// The pieces of history. Ids are 9 alphanumerics: Mistral templates refuse any other, and its models make these.
const read = (id: string, path: string) => ({ type: "tool-call" as const, id, name: "read", input: { path } });
const result = (id: string, text: string) => Message.tool({ id, name: "read", resultType: "text", result: text });
const ALPHA = "ALPHA-RESULT: export const alpha = 1;";
const BETA = "BETA-RESULT: export const beta = 2;";
const MARKER = "PROBE-THINKING-7319 the user wants alpha.txt read first, so I call read on it before anything else; zebra quartz lantern";

// Reachable at all, before anything is judged. Any HTTP answer will do; only no answer stops here.
try {
  await fetch(native ? `${root}/api/tags` : `${base}/models`, { headers, signal: AbortSignal.timeout(5_000) });
} catch (error) {
  console.error(`Cannot reach ${runtime} at ${base}: ${(error as Error).message}`);
  process.exit(1);
}
console.log(`Probing ${values.model} on ${runtime} at ${base} (${renders ? "rendering the prompt where it can" : "one short generation per request"})…`);

// 1. parallel_tool_calls with tools.
if (!PARALLEL_FIELD.has(runtime)) report(1, "parallel_tool_calls", "SKIP", `the harness does not send it to ${runtime}`);
else {
  const messages = [Message.user("Read project/alpha.txt.")];
  const withField = await generate(await lowered(messages, { parallel: true }));
  if (withField.ok) {
    sendParallel = true;
    report(1, "parallel_tool_calls", "PASS", "accepted together with tools", [`HTTP ${withField.status}, ${withField.calls.length} tool call(s) in 16 tokens`]);
  } else {
    const without = await generate(await lowered(messages, { parallel: false }));
    report(
      1,
      "parallel_tool_calls",
      "FAIL",
      without.ok ? "refused with the field and accepted without it" : "refused with or without the field, so the tools themselves are",
      [`with: HTTP ${withField.status}: ${withField.error}`, `without: ${without.ok ? `HTTP ${without.status}, accepted` : `HTTP ${without.status}: ${without.error}`}`]
    );
  }
}

// 2. One assistant message with two calls, then both results.
{
  const history = [Message.user("Read project/alpha.txt and project/beta.txt."), Message.assistant([read("alphaA001", "project/alpha.txt"), read("betaBB002", "project/beta.txt")]), result("alphaA001", ALPHA), result("betaBB002", BETA)];
  const outcome = await attempt(await lowered(history));
  if (outcome.accepted && outcome.prompt !== undefined) {
    const missing = ["project/alpha.txt", "project/beta.txt", ALPHA, BETA].filter((piece) => !outcome.prompt!.includes(piece));
    report(
      2,
      "two calls in one message",
      missing.length ? "FAIL" : "PASS",
      missing.length ? `rendered, but without ${missing.join(", ")}` : "rendered with both calls and both results",
      [`prompt: ${excerpt(outcome.prompt, "project/alpha.txt", BETA)}`]
    );
  } else if (outcome.accepted) report(2, "two calls in one message", "PASS", "accepted (no render endpoint: judged by acceptance)", [acceptedAs(outcome)]);
  else if (!singleCallTemplate(outcome.error)) report(2, "two calls in one message", "FAIL", "refused", [outcome.error]);
  else {
    const split = await attempt(await lowered(oneCallPerMessage(history)));
    report(
      2,
      "two calls in one message",
      split.accepted ? "PASS" : "FAIL",
      split.accepted ? "a single-call template refused it; through oneCallPerMessage it is accepted" : "a single-call template refused it, and refused it through oneCallPerMessage too",
      [`as one message: ${outcome.error}`, split.accepted ? `split: ${split.prompt !== undefined ? excerpt(split.prompt, "project/alpha.txt", BETA) : acceptedAs(split)}` : `split: ${split.error}`]
    );
  }
}

// 3. The field earlier thinking is read from. The call message is after the last user message, where templates
// that keep any thinking keep it. Rendered: is the marker in the prompt; generated: does the prompt grow by it.
{
  const history = (thinking: boolean) => [
    Message.user("Read project/alpha.txt."),
    Message.assistant([...(thinking ? [{ type: "reasoning" as const, text: MARKER }] : []), read("alphaA001", "project/alpha.txt")]),
    result("alphaA001", ALPHA),
  ];
  // Ollama's native API takes `thinking`; on OpenAI-compatible servers the harness sends both fields a server may read.
  const fields = native ? ["thinking"] : ["reasoning_content", "reasoning"];
  const withThinking = await lowered(history(true));
  /** The same body with the thinking under one field name only. */
  const renamed = (field: string): Body => ({
    ...withThinking,
    messages: withThinking.messages.map((message) => {
      const thought = fields.map((name) => message[name]).find((value) => value !== undefined);
      if (thought === undefined) return message;
      const rest = Object.fromEntries(Object.entries(message).filter(([name]) => !fields.includes(name)));
      return { ...rest, [field]: thought };
    }),
  });
  const baseline = renders ? undefined : await attempt(await lowered(history(false)));
  const baseTokens = baseline?.accepted ? baseline.sent?.promptTokens : undefined;
  const readFields: string[] = [];
  const evidence: string[] = [];
  let judged = true;
  for (const field of fields) {
    const outcome = await attempt(renamed(field));
    if (!outcome.accepted) {
      evidence.push(`${field}: refused: ${outcome.error}`);
      continue;
    }
    if (outcome.prompt !== undefined) {
      const found = outcome.prompt.includes("PROBE-THINKING-7319");
      if (found) readFields.push(field);
      evidence.push(`${field}: ${found ? `in the prompt: ${excerpt(outcome.prompt, "PROBE-THINKING-7319")}` : "not in the prompt"}`);
      continue;
    }
    const tokens = outcome.sent?.promptTokens;
    if (tokens === undefined || baseTokens === undefined) {
      judged = false;
      evidence.push(`${field}: accepted, but the server reported no prompt token count to compare`);
      continue;
    }
    // The marker is about 35 tokens; a template that leaves it out changes the prompt by none.
    const grew = tokens - baseTokens;
    if (grew >= 15) readFields.push(field);
    evidence.push(`${field}: prompt ${tokens} tokens against ${baseTokens} without thinking (${grew >= 0 ? "+" : ""}${grew})`);
  }
  if (!judged && !readFields.length) report(3, "earlier thinking field", "SKIP", "no prompt to look in and no token counts to compare", evidence);
  else if (readFields.length) report(3, "earlier thinking field", "PASS", `the server reads ${readFields.join(" and ")}, which the harness sends`, evidence);
  else report(3, "earlier thinking field", "PASS", "no field is rendered: this template leaves earlier thinking out, so sending it costs nothing", evidence);
}

// 4. A summary and the latest message: merged by the lowering (what is sent), and as two (informational).
{
  const summary = "Summary of the earlier conversation: SUMMARY-MARKER the user is reviewing project/alpha.txt.";
  const latest = "Now read project/alpha.txt.";
  const merged = await lowered([Message.user(summary), Message.user(latest)]);
  const users = merged.messages.filter((message) => message.role === "user").length;
  const system = merged.messages.filter((message) => message.role === "system");
  const unmerged: Body = { ...merged, messages: [...system, { role: "user", content: summary }, { role: "user", content: latest }] };
  const outcome = await attempt(merged);
  const apart = await attempt(unmerged);
  const informational = `unmerged (informational): ${apart.accepted ? `also accepted (${acceptedAs(apart)})` : `refused: ${apart.error}`}`;
  if (users !== 1) report(4, "summary + latest message", "FAIL", `the lowering sent ${users} user messages, not one`, [informational]);
  else if (outcome.accepted)
    report(4, "summary + latest message", "PASS", "the merged message is accepted", [
      outcome.prompt !== undefined ? `prompt: ${excerpt(outcome.prompt, "SUMMARY-MARKER", latest)}` : acceptedAs(outcome),
      informational,
    ]);
  else report(4, "summary + latest message", "FAIL", "the merged message is refused", [outcome.error, informational]);
}

// 5. Whether the model batches independent calls when asked as the agent asks.
if (!values.generate) report(5, "batched calls", "SKIP", "pass --generate to ask the model for three independent reads");
else {
  const body = await lowered([Message.user("Read project/alpha.txt, project/beta.txt and project/gamma.txt, then tell me the first line of each.")], {
    system: `You are a coding assistant working in the folder "project".\n\n${BATCHING}`,
    maxTokens: 4096,
  });
  const sent = await generate(body, 600_000);
  const calls = sent.calls.map((call) => `${call.name}(${call.args})`);
  if (!sent.ok) report(5, "batched calls", "FAIL", "the request was refused", [`HTTP ${sent.status}: ${sent.error}`]);
  else
    report(5, "batched calls", sent.calls.length >= 3 ? "PASS" : "FAIL", `${sent.calls.length} tool call(s) came back in one response`, [
      `${(sent.ms / 1000).toFixed(1)}s${calls.length ? `: ${calls.join(", ")}` : ""}`,
      ...(sent.text.trim() ? [`text: ${oneLine(sent.text, 200)}`] : []),
    ]);
}
