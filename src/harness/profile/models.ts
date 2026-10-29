/**
 * What the harness knows about one model on one connection: what its runtime reports now, what was learned
 * while using it, and what the person set. Runtime facts are re-read shortly before use, so a model that was
 * reloaded with another window, or loaded for the first time, is seen as it is now. Learned values live for
 * the chat worker's lifetime.
 */
import type { ChatRequest } from "../chat";
import { endpoint } from "../runtime";
import { runtimeProfile, type ModelFacts, type RuntimeProfile } from "./runtimes";
import { observedDefault, resolveWindow, type WindowSource } from "../../lib/context-window";
import { knobNamed, thinkingKnob, type Knob } from "./template";
import { budgetFor, countedTokens, outputCap, requestTokens, type Anchor } from "../budget";
import type { Message } from "../vendor/llm/schema";

/** How long runtime facts are reused: long enough for one turn's calls, short enough to see a reload. */
const FRESH_MS = 15_000;

interface Learned {
  /** A window the runtime named when a request did not fit. Superseded once the runtime reports one. */
  window?: number;
  /** How the runtime's token counts compare with the estimate, from its reported usage. */
  ratio?: number;
  /** Output tokens of recent finished calls, thinking included, with thinking on and off; newest last. */
  outputs?: { thinking: number[]; plain: number[] };
}

/** Outputs remembered per model and mode; enough for a stable high percentile, few enough to follow a change. */
const OUTPUTS = 20;
/** Calls seen before their sizes stand in for the starting share of the window. */
const ENOUGH = 3;

export interface ModelProfile {
  runtime: RuntimeProfile;
  facts: ModelFacts;
  /** The window requests have to fit, or undefined when nothing reports or names one. */
  window?: number;
  /** Where the window came from; undefined when only the app's last figure stands in for it. */
  source?: WindowSource;
  /** How the runtime's counts compare with the estimate; 1 until usage was reported. */
  ratio: number;
  /** The template variable that switches thinking; null when the model cannot be switched through one. */
  knob: Knob | null | undefined;
}

const facts = new Map<string, { at: number; value: Promise<ModelFacts> }>();
const learned = new Map<string, Learned>();
/** Ollama's default window per server, seen on a model it loaded with no setting. */
const defaults = new Map<string, number>();
const keyOf = (body: Pick<ChatRequest, "connection" | "runtimeModelId">) => `${endpoint(body.connection)}|${body.runtimeModelId}`;

export function resetProfiles() {
  facts.clear();
  learned.clear();
  defaults.clear();
}

function freshFacts(body: ChatRequest) {
  const key = keyOf(body);
  const cached = facts.get(key);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
  const value = runtimeProfile(body.runtime)
    .inspect({ runtime: body.runtime, connection: body.connection }, body.runtimeModelId)
    .catch((): ModelFacts => ({}));
  facts.set(key, { at: Date.now(), value });
  return value;
}

/** The person's choice in Models settings wins; then the variable the template reads. */
function knobFor(body: ChatRequest, reported: ModelFacts): Knob | null | undefined {
  const chosen = body.thinkingSwitch;
  if (chosen === "none") return null;
  if (chosen && chosen !== "auto") return knobNamed(chosen) ?? undefined;
  return thinkingKnob(reported.template);
}

/** The window from what the runtime reports and the person set, with a window learned from a refusal if given. */
function windowOf(body: ChatRequest, reported: ModelFacts, learnedWindow?: number) {
  const server = endpoint(body.connection);
  const seen = body.runtime === "ollama" ? observedDefault(reported) : undefined;
  if (seen) defaults.set(server, seen);
  return resolveWindow(
    body.runtime,
    { ...reported, runtimeDefault: body.runtime === "ollama" ? defaults.get(server) : undefined },
    { limit: body.runtime === "ollama" ? undefined : body.contextLimit, reported: learnedWindow }
  );
}

export async function modelProfile(body: ChatRequest): Promise<ModelProfile> {
  const reported = await freshFacts(body);
  const known = learned.get(keyOf(body)) ?? {};
  const resolved = windowOf(body, reported, known.window);
  // When the runtime could not be asked, the window the app last saw for the model stands in.
  const window = resolved.tokens ?? body.contextWindow;
  return { runtime: runtimeProfile(body.runtime), facts: reported, window, source: resolved.source, ratio: known.ratio ?? 1, knob: knobFor(body, reported) };
}

const loading = new Map<string, Promise<void>>();

/**
 * Some runtimes have to load the model before its window is known or right: LM Studio keeps no window of its
 * own and loads at the person's choice; an Ollama model with no setting loads at a default only Ollama knows.
 * The default seen for another model on the same server is only a guess for this one (it depends on the server's
 * memory and settings), so it is shown before the first message but the model is still loaded before sending.
 * The model is loaded first, once however many requests arrive together. It would load for the request anyway,
 * so this costs a round trip, and a failure to load is reported as that rather than as a failed reply.
 */
async function loadFirst(body: ChatRequest, profile: ModelProfile, onLoad?: () => void) {
  const load = profile.runtime.load;
  if (!load || profile.facts.loaded) return false;
  const window = body.runtime === "ollama" ? undefined : body.contextLimit;
  if (body.runtime === "ollama" ? profile.source && profile.source !== "default" : !window) return false;
  const key = keyOf(body);
  let pending = loading.get(key);
  onLoad?.();
  if (!pending) {
    pending = load({ runtime: body.runtime, connection: body.connection }, body.runtimeModelId, window).finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  await pending;
  facts.delete(key);
  return true;
}

/**
 * The request with the window the runtime holds now, so compaction, budgets and caps all fit the same one.
 * `onLoad` is told when the model has to be loaded first, so the chat can say so while it waits. `onWindow` is told
 * when the runtime holds a different window than the app sent, so the app reads its model list again.
 */
export async function withLiveWindow<T extends ChatRequest>(body: T, onLoad?: () => void, onWindow?: (window: number) => void): Promise<T> {
  let profile = await modelProfile(body);
  if (await loadFirst(body, profile, onLoad)) profile = await modelProfile(body);
  const { window } = profile;
  if (!window || window === body.contextWindow) return body;
  onWindow?.(window);
  return { ...body, contextWindow: window };
}

/** Remembers a window the runtime named when a request did not fit. */
export function learnWindow(body: ChatRequest, window: number) {
  const key = keyOf(body);
  learned.set(key, { ...learned.get(key), window });
  facts.delete(key);
}

/**
 * After a runtime named a window when a request did not fit, it is asked again, so the window has one source.
 * When it now reports that window or less (a server restarted with a smaller one since the app last asked),
 * its report stands and nothing learned is kept. When it still reports more (a proxy that names the model's
 * maximum), the named window is kept, and the runtime's figure comes back too, so the chat can show both.
 */
export async function recheckWindow(body: ChatRequest, named: number): Promise<{ window: number; runtime?: number }> {
  learnWindow(body, named);
  const reported = windowOf(body, await freshFacts(body)).tokens;
  if (reported && reported <= named) {
    const key = keyOf(body);
    learned.set(key, { ...learned.get(key), window: undefined });
    return { window: reported };
  }
  return { window: named, ...(reported ? { runtime: reported } : {}) };
}

/** Remembers how much a finished call wrote, so later calls keep about that much room for output. */
export function learnOutput(body: ChatRequest, thinking: boolean, tokens: number | undefined) {
  if (!tokens || tokens <= 0) return;
  const key = keyOf(body);
  const known = learned.get(key) ?? {};
  const outputs = known.outputs ?? { thinking: [], plain: [] };
  const mode = thinking ? "thinking" : "plain";
  learned.set(key, { ...known, outputs: { ...outputs, [mode]: [...outputs[mode], tokens].slice(-OUTPUTS) } });
}

/** The 95th percentile of the model's recent outputs in that mode, or undefined until enough calls finished. */
export function observedOutput(body: ChatRequest, thinking: boolean) {
  const list = learned.get(keyOf(body))?.outputs?.[thinking ? "thinking" : "plain"] ?? [];
  if (list.length < ENOUGH) return undefined;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

/** Moves the remembered estimate ratio toward what the runtime reported, bounded so one odd report cannot undo it. */
export function learnRatio(body: ChatRequest, estimated: number, reported: number | undefined) {
  if (!reported || estimated < 200) return;
  const key = keyOf(body);
  const previous = learned.get(key)?.ratio;
  const measured = Math.min(3, Math.max(0.4, reported / estimated));
  learned.set(key, { ...learned.get(key), ratio: previous ? (previous + measured) / 2 : measured });
}

/**
 * The window named in a runtime's "does not fit" error, as vLLM, llama.cpp, LM Studio, SGLang and OpenAI-style
 * servers word it: "maximum context length is 8192 tokens", "context size (4096 tokens)", "context length of
 * only 4096 tokens". Undefined for any other error.
 */
export function windowFromError(message: string): number | undefined {
  const patterns = [
    /maximum context length (?:is|of) (\d+)/i,
    /context (?:size|window|length) (?:is |of )?(?:only )?\(?(\d+)(?: tokens)?\)?/i,
    /max_model_len[^\d]{0,20}(\d+)/i,
    /n_ctx[^\d]{0,10}(\d+)/i,
  ];
  if (!/context|n_ctx|max_model_len|too long|exceed/i.test(message)) return undefined;
  for (const pattern of patterns) {
    const value = Number(message.match(pattern)?.[1]);
    if (Number.isSafeInteger(value) && value >= 256) return value;
  }
  return undefined;
}

/**
 * The request's estimated size, unscaled (to compare with what the runtime reports) and scaled by what it
 * reported before, and the room the window leaves for output.
 */
export async function measure(body: ChatRequest, system: string, messages: readonly Message[], thinking = true, extra = 0, anchor?: Anchor) {
  const profile = await modelProfile(body);
  // The estimate alone is what the runtime's count teaches the ratio from; the input uses its counts where there are any.
  const estimated = requestTokens(system, messages, 1, extra);
  const input = countedTokens(system, messages, profile.ratio, extra, anchor);
  const budget = budgetOf(body, profile, thinking);
  return { estimated, input, budget, cap: outputCap(budget, input), ratio: profile.ratio };
}

// The profile's window already takes in one the runtime named when a request did not fit.
const budgetOf = (body: ChatRequest, profile: ModelProfile, thinking: boolean) =>
  budgetFor(profile.window ?? body.contextWindow, observedOutput(body, thinking), thinking);

/**
 * The output the next request on this model keeps free, with what this turn's calls taught it: the context meter
 * draws the line where older turns are summarized at the window less this. Undefined without a window.
 */
export async function nextReserve(body: ChatRequest, thinking: boolean) {
  const budget = budgetOf(body, await modelProfile(body), thinking);
  return budget.window ? budget.reserve : undefined;
}

/**
 * Learns the window from a runtime's "does not fit" error and says so in the error. The caller fits the request
 * to it and sends it again once; this message is what the person sees if that fails too. Any other error comes
 * back unchanged.
 */
export function explainOverflow(body: ChatRequest, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const window = windowFromError(message);
  if (!window) return error;
  learnWindow(body, window);
  return new Error(`${message}\n\nThe model's context window is ${window} tokens.`);
}
