/**
 * The context window a request to a connected runtime runs with, decided in one place for the Models settings,
 * the model menu, the context meter and the harness. Where the window lives depends on the runtime:
 * - Ollama stores it with the model (Modelfile num_ctx) and otherwise loads at its own default, which depends on
 *   the server's memory or OLLAMA_CONTEXT_LENGTH, so only a loaded model or an earlier load on the same server
 *   tells it.
 * - LM Studio keeps no window of its own; the harness loads the model at the person's choice.
 * - vLLM and other servers serve one fixed window. The person may cap what the app fills, never raise it.
 * A window the runtime named when a request did not fit wins when it is smaller. An Ollama model with no setting
 * that is not loaded shows the default seen on its server as a guess ("default"), but a request does not run on
 * the guess: the harness loads the model first and reads its window (profile/models loadFirst). Pure, shared by
 * both processes.
 */
import type { RuntimeId } from "./models";

export type WindowSource =
  /** Stored with the model on the runtime (Ollama's Modelfile). */
  | "setting"
  /** The person's cap in Models settings. */
  | "limit"
  /** What the loaded model runs with now. */
  | "loaded"
  /** Ollama's default, as seen on this server for a model with no setting. */
  | "default"
  /** The window the server was started with (vLLM's max_model_len, llama.cpp's n_ctx). */
  | "server"
  /** The most the model takes; nothing nearer was reported. */
  | "max"
  /** Named by the runtime when a request did not fit. */
  | "reported";

export interface WindowFacts {
  /** What the model runs with now; for a fixed-window server, the window it serves. */
  loaded?: number;
  /** What the runtime stores for the model and loads it with (Ollama's num_ctx). */
  configured?: number;
  /** The most the model takes. */
  max?: number;
  /** Ollama's default window on this server, seen on a model loaded with no setting. */
  runtimeDefault?: number;
}

export interface ResolvedWindow {
  tokens?: number;
  source?: WindowSource;
}

const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

function baseWindow(runtime: RuntimeId, facts: WindowFacts, limit?: number): ResolvedWindow {
  const loaded = positive(facts.loaded);
  const max = positive(facts.max);
  const cap = positive(limit);
  if (runtime === "ollama") {
    // The next request loads at the stored setting even when another client loaded the model differently.
    const configured = positive(facts.configured);
    if (configured) return { tokens: configured, source: "setting" };
    if (loaded) return { tokens: loaded, source: "loaded" };
    // Ollama does not load a model beyond its maximum, whatever its default.
    const fallback = positive(facts.runtimeDefault);
    return fallback ? { tokens: max ? Math.min(fallback, max) : fallback, source: "default" } : {};
  }
  if (runtime === "lmstudio") {
    if (loaded) return { tokens: loaded, source: "loaded" };
    if (cap) return { tokens: max ? Math.min(cap, max) : cap, source: "limit" };
    return max ? { tokens: max, source: "max" } : {};
  }
  const served = loaded ?? max;
  if (cap && (!served || cap < served)) return { tokens: cap, source: "limit" };
  if (loaded) return { tokens: loaded, source: "server" };
  return max ? { tokens: max, source: "max" } : {};
}

export function resolveWindow(runtime: RuntimeId, facts: WindowFacts, options: { limit?: number; reported?: number } = {}): ResolvedWindow {
  const base = baseWindow(runtime, facts, options.limit);
  const reported = positive(options.reported);
  return reported && (!base.tokens || reported < base.tokens) ? { tokens: reported, source: "reported" } : base;
}

/**
 * Ollama's default window on a server, from a model it loaded with no setting. Only a window below the model's
 * maximum is the default itself; one equal to it may be the default cut down to that model.
 */
export function observedDefault(facts: WindowFacts): number | undefined {
  const loaded = positive(facts.loaded);
  const max = positive(facts.max);
  if (!loaded || positive(facts.configured)) return undefined;
  return max && loaded >= max ? undefined : loaded;
}

/** Where a runtime keeps the window the person sets in Models settings. */
export type WindowStore =
  /** Written to the runtime with the model (Ollama). */
  | "runtime"
  /** Applied by loading the model at it before the first request (LM Studio). */
  | "load"
  /** A cap on what the app fills, within the server's fixed window (vLLM and other servers). */
  | "cap";

export const windowStore = (runtime: RuntimeId): WindowStore => (runtime === "ollama" ? "runtime" : runtime === "lmstudio" ? "load" : "cap");
