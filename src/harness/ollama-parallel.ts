/**
 * How many requests one Ollama model serves at once, measured when it first matters instead of set by hand.
 * OLLAMA_NUM_PARALLEL is only an upper bound: Ollama serves one at a time for architectures that cannot run in
 * parallel (it logs "model architecture does not currently support parallel requests"), for the MLX engine, or
 * when memory is short. Checked on Ollama 0.40.5: Qwen3.5 (qwen35) and gemma4 (MLX) served one at a time at
 * OLLAMA_NUM_PARALLEL 1, 2 and 4 alike.
 *
 * - Measured only when two requests for the same model wait at once (see ./limit), with the model loaded and
 *   nothing else running on it, so loading costs nothing and nothing else skews it. A chat used alone never is.
 * - PROBES tiny requests go at once; the number that start before the first one ends is the answer. About a
 *   second on a loaded model.
 * - Kept per server, model file (digest), Ollama version and window, in memory and in the app's data folder
 *   when the worker is given one (ENDURANCE_STATE_DIR). Any of them changing means measuring again.
 * - Forgotten as soon as real requests show it wrong (see ./limit), and measured again when next needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Ollama } from "./vendor/schema/ollama";
import { endpoint, headers, runtimeUrl } from "./runtime";
import type { RuntimeConnection } from "../lib/models";

/** Requests sent together to measure; more than the most that ever wait together (three subagents and a chat). */
const PROBES = 4;
/** How long the identity of a model (version, digest, window) is reused before it is read again. */
const FRESH_MS = 15_000;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const api = (connection: RuntimeConnection) => Ollama.baseURL(endpoint(connection));
const origin = (connection: RuntimeConnection) => {
  try {
    return new URL(connection.baseUrl).origin;
  } catch {
    return connection.baseUrl;
  }
};

async function ask(connection: RuntimeConnection, route: string) {
  try {
    const response = await fetch(runtimeUrl(connection, `${api(connection)}${route}`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(3000) });
    return response.ok ? record(await response.json()) : {};
  } catch {
    return {};
  }
}

const identities = new Map<string, { at: number; value: Promise<string | undefined> }>();

/**
 * What a measurement holds for: the server, the model file, Ollama's version and the window the model is
 * loaded with. Undefined when Ollama does not say them, as when the model is not loaded.
 */
export function identity(connection: RuntimeConnection, model: string): Promise<string | undefined> {
  const key = `${origin(connection)}|${model}`;
  const cached = identities.get(key);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
  const value = (async () => {
    const [version, tags, ps] = await Promise.all([ask(connection, "/api/version"), ask(connection, "/api/tags"), ask(connection, "/api/ps")]);
    const named = (list: unknown) =>
      (Array.isArray(list) ? list : []).map(record).find((item) => typeof item.name === "string" && Ollama.tagKey(item.name) === Ollama.tagKey(model));
    const digest = named(tags.models)?.digest;
    const window = named(ps.models)?.context_length;
    if (typeof version.version !== "string" || typeof digest !== "string" || typeof window !== "number") return undefined;
    return `${origin(connection)}|${model}|${digest}|${version.version}|${window}`;
  })();
  identities.set(key, { at: Date.now(), value });
  return value;
}

const file = () => (process.env.ENDURANCE_STATE_DIR ? path.join(process.env.ENDURANCE_STATE_DIR, "ollama-parallel.json") : undefined);
let known: Map<string, number> | undefined;

function memory() {
  if (known) return known;
  known = new Map();
  const where = file();
  if (!where) return known;
  try {
    const saved = record(JSON.parse(readFileSync(where, "utf8")));
    for (const [key, value] of Object.entries(saved)) if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= PROBES) known.set(key, value);
  } catch {
    // Nothing saved yet.
  }
  return known;
}

function save() {
  const where = file();
  if (!where) return;
  try {
    mkdirSync(path.dirname(where), { recursive: true });
    writeFileSync(where, JSON.stringify(Object.fromEntries(memory())));
  } catch {
    // Measuring again later is the only cost.
  }
}

export const remembered = (id: string) => memory().get(id);

export function remember(id: string, count: number) {
  memory().set(id, count);
  save();
}

export function forget(id: string) {
  if (memory().delete(id)) save();
}

/** For tests: forgets every measurement and identity, and reads the saved ones again. */
export function resetParallel() {
  known = undefined;
  identities.clear();
}

/** Sends PROBES short requests at once and counts how many start before the first one ends. */
export async function measure(connection: RuntimeConnection, model: string, signal?: AbortSignal): Promise<number> {
  const started: number[] = [];
  const ended: number[] = [];
  const one = async () => {
    const response = await fetch(runtimeUrl(connection, `${api(connection)}/api/chat`), {
      method: "POST",
      headers: { ...headers(connection), "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true, options: { num_predict: 24 }, messages: [{ role: "user", content: "Count from 1 to 20." }] }),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama answered ${response.status}`);
    const reader = response.body.getReader();
    for (let first = true; ; first = false) {
      const part = await reader.read();
      if (part.done) break;
      if (first) started.push(Date.now());
    }
    ended.push(Date.now());
  };
  await Promise.all(Array.from({ length: PROBES }, one));
  const firstEnd = Math.min(...ended);
  return Math.max(1, started.filter((time) => time < firstEnd).length);
}
