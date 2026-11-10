/**
 * How many requests one Ollama model serves at once, up to the cap set on the connection ("Requests at once").
 * Ollama reads OLLAMA_NUM_PARALLEL (default 1) for the whole server when it starts, and the API cannot set it,
 * so the cap is what the person asked for and the measurement is what Ollama does. OLLAMA_NUM_PARALLEL is only
 * an upper bound: Ollama serves one at a time for embedding models, for architectures that cannot run in
 * parallel (it logs "model architecture does not currently support parallel requests"), for the MLX engine, or when memory is short.
 * Checked on Ollama 0.40.5: Qwen3.5 (qwen35) and gemma4 (MLX) served one at a time at OLLAMA_NUM_PARALLEL 1, 2 and 4 alike.
 *
 * - Measured only when the cap is above one and two requests for the same model wait at once (see ./limit),
 *   with the model loaded and nothing else running on it, so loading costs nothing and nothing else skews it.
 * - As many tiny requests as the cap go at once; the number that start before the first one ends is the answer.
 *   Endurance never sends more than the cap, so more probes could not change what it does. About a second on a
 *   loaded model.
 * - Kept per server, model file (digest), Ollama version, window and cap, in memory and in the app's data folder
 *   when the worker is given one (ENDURANCE_STATE_DIR). Any of them changing means measuring again. Only the
 *   latest measurement of each model on a server is kept.
 * - Forgotten as soon as real requests show it wrong (see ./limit), and measured again when next needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Ollama } from "./vendor/schema/ollama";
import { endpoint, headers, runtimeUrl } from "./runtime";
import type { RuntimeConnection } from "../lib/models";

/** How long the identity of a model (version, digest, window) is reused before it is read again. */
const FRESH_MS = 15_000;
/** The file in the app's data folder that keeps measurements. */
export const MEASUREMENTS_FILE = "ollama-parallel.json";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const api = (connection: RuntimeConnection) =>
  Ollama.baseURL(endpoint(connection));
const originOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
};
const origin = (connection: RuntimeConnection) => originOf(connection.baseUrl);

/** The cap set on an Ollama connection; unset is Ollama's own default of one. */
export const capOf = (connection: RuntimeConnection) =>
  connection.concurrency && Number.isInteger(connection.concurrency) && connection.concurrency > 1
    ? connection.concurrency
    : 1;

async function ask(connection: RuntimeConnection, route: string, timeout = 3000) {
  try {
    const response = await fetch(
      runtimeUrl(connection, `${api(connection)}${route}`),
      {
        headers: headers(connection),
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      },
    );
    return response.ok ? record(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

const named = (list: unknown, model: string) =>
  (Array.isArray(list) ? list : [])
    .map(record)
    .find(
      (item) =>
        typeof item.name === "string" &&
        Ollama.tagKey(item.name) === Ollama.tagKey(model),
    );

/**
 * The models Ollama holds, by name. Ollama lists a model from the moment it starts loading it, and answers
 * /api/ps only after any load in progress is done (it waits on each model's lock). So an answer without a
 * model means Ollama has not started loading it, and no answer within `timeout` means a load is in progress
 * or the server is away.
 */
export async function loadedModels(
  connection: RuntimeConnection,
  timeout = 1500,
): Promise<string[] | undefined> {
  const ps = await ask(connection, "/api/ps", timeout);
  if (!ps) return undefined;
  return (Array.isArray(ps.models) ? ps.models : [])
    .map(record)
    .map((item) => item.name)
    .filter((name): name is string => typeof name === "string");
}

/** Whether two Ollama names are the same model ("gemma4" and "gemma4:latest" are). */
export const sameModel = (one: string, other: string) =>
  Ollama.tagKey(one) === Ollama.tagKey(other);

const identities = new Map<
  string,
  { at: number; value: Promise<string | undefined> }
>();

/**
 * What a measurement holds for: the server, the model file, Ollama's version and the window the model is
 * loaded with. Undefined when Ollama does not say them, as when the model is not loaded.
 */
export function identity(
  connection: RuntimeConnection,
  model: string,
): Promise<string | undefined> {
  const key = `${origin(connection)}|${model}`;
  const cached = identities.get(key);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
  const value = (async () => {
    const [version, tags, ps] = await Promise.all([
      ask(connection, "/api/version"),
      ask(connection, "/api/tags"),
      ask(connection, "/api/ps"),
    ]);
    const release = version?.version;
    const digest = named(tags?.models, model)?.digest;
    const window = named(ps?.models, model)?.context_length;
    if (
      typeof release !== "string" ||
      typeof digest !== "string" ||
      typeof window !== "number"
    )
      return undefined;
    return `${origin(connection)}|${model}|${digest}|${release}|${window}`;
  })();
  identities.set(key, { at: Date.now(), value });
  return value;
}

/** A saved key: the identity and the cap, as origin|model|digest|version|window|cap. */
interface Saved {
  origin: string;
  model: string;
  cap: number;
}
function parseKey(key: string): Saved | undefined {
  const parts = key.split("|");
  const cap = Number(parts[5]);
  if (parts.length !== 6 || !Number.isInteger(cap) || cap < 1) return undefined;
  return { origin: parts[0], model: parts[1], cap };
}

/** Saved measurements that still read as one: a count from one to the cap they were taken at. */
function readSaved(where: string) {
  const result = new Map<string, number>();
  try {
    const saved = record(JSON.parse(readFileSync(where, "utf8")));
    for (const [key, value] of Object.entries(saved)) {
      const cap = parseKey(key)?.cap;
      if (cap && typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= cap)
        result.set(key, value);
    }
  } catch {
    // Nothing saved yet, or saved before the cap was part of the key.
  }
  return result;
}

const file = () =>
  process.env.ENDURANCE_STATE_DIR
    ? path.join(process.env.ENDURANCE_STATE_DIR, MEASUREMENTS_FILE)
    : undefined;
let known: Map<string, number> | undefined;

function memory() {
  if (known) return known;
  const where = file();
  known = where ? readSaved(where) : new Map();
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

export const remembered = (id: string, cap: number) => memory().get(`${id}|${cap}`);

/** Keeps a measurement, and drops older ones of the same model on the same server. */
export function remember(id: string, cap: number, count: number) {
  const [server, model] = id.split("|");
  for (const key of [...memory().keys()]) {
    const saved = parseKey(key);
    if (saved?.origin === server && saved.model === model) memory().delete(key);
  }
  memory().set(`${id}|${cap}`, count);
  save();
}

export function forget(id: string, cap: number) {
  if (memory().delete(`${id}|${cap}`)) save();
}

/**
 * For the settings: what was last measured for each model on the server at `baseUrl`, read from the data
 * folder the worker keeps it in.
 */
export function measuredOn(stateDir: string, baseUrl: string) {
  const server = originOf(baseUrl);
  return [...readSaved(path.join(stateDir, MEASUREMENTS_FILE))]
    .map(([key, served]) => ({ ...parseKey(key)!, served }))
    .filter((item) => item.origin === server)
    .map(({ model, cap, served }) => ({ model, cap, served }));
}

/** For tests: forgets every measurement and identity, and reads the saved ones again. */
export function resetParallel() {
  known = undefined;
  identities.clear();
}

/** Sends `cap` short requests at once and counts how many start before the first one ends. */
export async function measure(
  connection: RuntimeConnection,
  model: string,
  cap: number,
  signal?: AbortSignal,
): Promise<number> {
  const started: number[] = [];
  const ended: number[] = [];
  const one = async () => {
    const response = await fetch(
      runtimeUrl(connection, `${api(connection)}/api/chat`),
      {
        method: "POST",
        headers: { ...headers(connection), "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          options: { num_predict: 24 },
          messages: [{ role: "user", content: "Count from 1 to 20." }],
        }),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`Ollama answered ${response.status}`);
    const reader = response.body.getReader();
    for (let first = true; ; first = false) {
      const part = await reader.read();
      if (part.done) break;
      if (first) started.push(Date.now());
    }
    ended.push(Date.now());
  };
  await Promise.all(Array.from({ length: cap }, one));
  const firstEnd = Math.min(...ended);
  return Math.max(1, Math.min(cap, started.filter((time) => time < firstEnd).length));
}
