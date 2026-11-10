/**
 * Request slots per server, and which waiting call goes next.
 *
 * Ollama queues what it cannot serve at once in arrival order, so the app keeps that queue itself, per model.
 * A model gets at most the connection's "Requests at once" (one unless set, as Ollama's own default), counting
 * chats, side chats and subagents together. Above one, how many it really serves is measured when it first
 * matters (./ollama-parallel): until then, and for models that cannot run in parallel, one at a time. Other
 * servers batch requests, so they get as many as the
 * connection's Requests at once allows, unlimited unless set. When calls wait, the next free slot goes to
 * the chat on screen first, then other chats and side chats, then subagents, in arrival order within each.
 * A summary made before a reply has that reply's place, since the reply waits on it. A call already running is
 * never interrupted; an agent gives its slot back between steps.
 *
 * vLLM batches, so nothing waits in the app; but while the server reports requests waiting, a subagent holds
 * back a little, up to HOLD_MS, so the chats being read are not queued behind subagents.
 *
 * Which chat a call belongs to and what kind it is travel with it (runAs), so no signature carries them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { parseMetrics } from "./server-info";
import { endpoint, headers, runtimeUrl, serverRoot } from "./runtime";
import { capOf, forget, identity, loadedModels, measure, remember, remembered, sameModel } from "./ollama-parallel";
import type { RuntimeConnection } from "../lib/models";

/** title: a chat's name, written by its own model after the first reply. Nothing waits on it, so it goes last. */
export type CallKind = "chat" | "subagent" | "title";
export interface CallContext {
  /** The chat the call is for; a side chat has its own. */
  chat?: string;
  kind: CallKind;
  /**
   * Told the Ollama model this call waits for while Ollama keeps memory for it (two models that do not fit
   * together take turns), and undefined once Ollama starts loading or running this call's model.
   */
  wait?: (model: string | undefined) => void;
  /** Told once per pair of Ollama models, the first time one was unloaded to run the other. */
  swapped?: (models: [string, string]) => void;
}

/** What a chat's reply stream is told while Ollama keeps its calls waiting (see watchOllamaWait). */
type WaitPart =
  | { type: "data-status"; data: { state: "loading" } | { state: "waiting"; model: string }; transient: true }
  | { type: "data-swap"; data: { models: [string, string] }; transient: true };

/**
 * A chat's reply says which model Ollama makes it wait for, and "Loading the model" once Ollama starts on its
 * own. A stream that has already ended takes nothing more.
 */
export function chatWaits(write: (part: WaitPart) => void): Pick<CallContext, "wait" | "swapped"> {
  const safely = (part: WaitPart) => {
    try {
      write(part);
    } catch {
      // The reply finished first.
    }
  };
  return {
    wait: (model) => safely({ type: "data-status", data: model ? { state: "waiting", model } : { state: "loading" }, transient: true }),
    swapped: (models) => safely({ type: "data-swap", data: { models }, transient: true }),
  };
}

const context = new AsyncLocalStorage<CallContext>();
/** Runs `work` with every model call in it counted as `call`. */
export const runAs = <T>(call: CallContext, work: () => T) => context.run(call, work);
/** The chat the current calls belong to. */
export const currentCall = () => context.getStore();

/** The chats on screen now, as the window reports them. */
let visible = new Set<string>();
export function setVisibleChats(ids: string[]) {
  visible = new Set(ids);
  // A chat that came on screen may now be first in line.
  for (const queue of queues.values()) dispatch(queue);
}

/** Lower goes first. Read when a slot frees, so a chat brought on screen moves ahead of others still waiting. */
export function rank(call: CallContext | undefined) {
  if (call?.kind === "title") return 3;
  if (call?.kind === "subagent") return 2;
  return call?.chat && visible.has(call.chat) ? 0 : 1;
}

interface Waiting {
  call: CallContext | undefined;
  order: number;
  start: () => void;
}

/** A call holding a slot: whether it ended, and which calls were running when it started. */
interface Running {
  ended: boolean;
  alongside: Running[];
}

/** One Ollama model's measured capacity. */
interface Measured {
  connection: RuntimeConnection;
  model: string;
  /** Server, model file, version and window the capacity holds for (ollama-parallel.identity). */
  id?: string;
  /** The connection's "Requests at once": never more than this at once, and what is measured up to. */
  cap: number;
  /** Requests it serves at once; undefined until measured, or after real requests showed it wrong. */
  capacity?: number;
  /**
   * The model was seen unloaded while measured below its cap. Ollama may have restarted with a higher
   * OLLAMA_NUM_PARALLEL since, so the saved count is measured again instead of reused.
   */
  stale?: boolean;
  checkedAt: number;
  measuring?: Promise<void>;
}

interface Queue {
  limit: number;
  active: number;
  waiting: Waiting[];
  running: Set<Running>;
  ollama?: Measured;
}

const queues = new Map<string, Queue>();
let arrivals = 0;

function dispatch(queue: Queue) {
  // Two calls for one Ollama model wait together for the first time: measure, with nothing else running on it.
  if (queue.ollama && queue.ollama.cap > 1 && queue.ollama.capacity === undefined && queue.waiting.length && !queue.active) return void measureQueue(queue);
  if (queue.ollama?.measuring) return;
  while (queue.active < queue.limit && queue.waiting.length) {
    let best = 0;
    for (let index = 1; index < queue.waiting.length; index++) {
      const item = queue.waiting[index];
      const top = queue.waiting[best];
      if (rank(item.call) < rank(top.call) || (rank(item.call) === rank(top.call) && item.order < top.order)) best = index;
    }
    const [next] = queue.waiting.splice(best, 1);
    queue.active++;
    next.start();
  }
}

/** Measures an Ollama model's capacity, or takes it from an earlier measurement of the same model file. */
function measureQueue(queue: Queue) {
  const measured = queue.ollama!;
  if (measured.measuring) return measured.measuring;
  measured.measuring = (async () => {
    const { cap } = measured;
    const id = await identity(measured.connection, measured.model);
    let capacity = id ? remembered(id, cap) : undefined;
    if (capacity !== undefined && capacity < cap && measured.stale) capacity = undefined;
    if (capacity === undefined) {
      capacity = await measure(measured.connection, measured.model, cap).catch(() => undefined);
      if (capacity && id) remember(id, cap, capacity);
    }
    // A failed measurement serves one at a time; the identity is read again later and may let it measure again.
    Object.assign(measured, { id, capacity: Math.min(cap, capacity ?? 1), checkedAt: Date.now(), stale: false });
    queue.limit = measured.capacity!;
  })().finally(() => {
    measured.measuring = undefined;
    dispatch(queue);
  });
  return measured.measuring;
}

/**
 * A changed version, model file or window means the measurement no longer holds. Read at most every 15 s.
 * A model seen unloaded while measured below its cap is measured again when next needed, not reused.
 */
async function recheck(queue: Queue) {
  const measured = queue.ollama;
  if (!measured || measured.capacity === undefined || Date.now() - measured.checkedAt < 15_000) return;
  measured.checkedAt = Date.now();
  const id = await identity(measured.connection, measured.model);
  if (id === measured.id) return;
  if (id === undefined && measured.capacity < measured.cap) measured.stale = true;
  measured.capacity = undefined;
  queue.limit = 1;
}

/**
 * A call that started beside others but sent nothing until one of them had ended was served after it, not
 * with it: the model serves fewer at once than measured (a restart with another OLLAMA_NUM_PARALLEL, less
 * memory, a reload). It goes back to one at a time and is measured again when next needed.
 */
function firstPiece(queue: Queue, running: Running) {
  const measured = queue.ollama;
  if (!measured?.capacity || measured.capacity < 2 || !running.alongside.some((other) => other.ended)) return;
  if (measured.id) forget(measured.id, measured.cap);
  measured.capacity = undefined;
  queue.limit = 1;
}

function origin(connection: RuntimeConnection) {
  try {
    return new URL(connection.baseUrl).origin;
  } catch {
    return connection.baseUrl;
  }
}

export interface SlotTarget {
  connection: RuntimeConnection;
  /** The runtime, as the request names its provider. */
  runtime?: string;
  model?: string;
}

function queueFor(target: SlotTarget): Queue | undefined {
  if (target.runtime === "ollama" && target.model) {
    // Ollama serves requests in parallel per model, as many as OLLAMA_NUM_PARALLEL and the model allow, and
    // never more than the connection's cap here.
    const key = `${origin(target.connection)}|${target.model}`;
    const cap = capOf(target.connection);
    const queue = queues.get(key) ?? { limit: 1, active: 0, waiting: [], running: new Set(), ollama: { connection: target.connection, model: target.model, cap, checkedAt: 0 } };
    queue.ollama!.connection = target.connection;
    // A new cap is a new question: what was measured under the old one does not answer it.
    if (queue.ollama!.cap !== cap) {
      Object.assign(queue.ollama!, { cap, capacity: undefined, id: undefined, stale: false });
      queue.limit = 1;
      dispatch(queue);
    }
    queues.set(key, queue);
    return queue;
  }
  const set = target.connection.concurrency;
  if (!set || !Number.isInteger(set) || set < 1) return undefined;
  const key = origin(target.connection);
  const queue = queues.get(key) ?? { limit: set, active: 0, waiting: [], running: new Set() };
  queue.limit = set;
  queues.set(key, queue);
  return queue;
}

/**
 * How many calls to this model may run at once: what Ollama was measured to serve (measured now when it is
 * not known and nothing runs on the model), the connection's limit elsewhere, or unlimited.
 */
export async function concurrency(target: SlotTarget): Promise<number> {
  const queue = queueFor(target);
  if (!queue) return Number.POSITIVE_INFINITY;
  if (!queue.ollama) return queue.limit;
  if (queue.ollama.cap === 1) return 1;
  await recheck(queue);
  if (queue.ollama.capacity === undefined && !queue.active) await measureQueue(queue);
  return queue.ollama.capacity ?? 1;
}

/** The longest a subagent holds back for a busy vLLM server, and how often it looks again. */
export const HOLD_MS = 30_000;
const LOOK_MS = 1000;

/** Requests waiting for this model on the server; a server running several models labels each one's. */
async function waitingOn(connection: RuntimeConnection, model?: string) {
  try {
    const response = await fetch(runtimeUrl(connection, `${serverRoot(endpoint(connection))}/metrics`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(2000) });
    return response.ok ? (parseMetrics(await response.text(), model).waiting ?? 0) : 0;
  } catch {
    return 0;
  }
}

/** On a busy vLLM server, a subagent waits for its queue to empty, briefly. */
async function holdBack(target: SlotTarget, call: CallContext | undefined, signal: AbortSignal) {
  if (target.runtime !== "vllm" || rank(call) < 2) return;
  const until = Date.now() + HOLD_MS;
  while (Date.now() < until && !signal.aborted && (await waitingOn(target.connection, target.model)) > 0) await new Promise((resolve) => setTimeout(resolve, LOOK_MS));
}

/** Pairs of Ollama models the chats were told take turns, once each while the app runs, as "server|a|b". */
const swapsTold = new Set<string>();
/** Ollama's name for its default tag is noise in a sentence. */
const shortName = (model: string) => model.replace(/:latest$/, "");

/**
 * While Ollama has not started on this call's model, looks every second at the models it holds. Ollama lists a
 * model from the moment it starts loading it, so a listing without this model means Ollama keeps the call
 * waiting for memory, or for room among loaded models (OLLAMA_MAX_LOADED_MODELS). The call is told which model
 * it waits for: the one Endurance is running on that server if any, else the first Ollama lists (another app
 * may be using it). Stopped when the call's first piece arrives or the load ends. If the model waited for was
 * unloaded by then, the two take turns, and the chat is told once for that pair.
 */
export function watchOllamaWait(target: SlotTarget): () => void {
  const call = currentCall();
  const model = target.model;
  if (target.runtime !== "ollama" || !model || (!call?.wait && !call?.swapped)) return () => {};
  const server = origin(target.connection);
  let stopped = false;
  let blocker: string | undefined;
  // Told it no longer waits on another model: Ollama has started loading this one.
  let cleared = false;
  const busy = () =>
    [...queues.entries()]
      .filter(([key, queue]) => queue.ollama && queue.active > 0 && key.startsWith(`${server}|`))
      .map(([, queue]) => queue.ollama!.model)
      .filter((other) => !sameModel(other, model));
  void (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, LOOK_MS));
      if (stopped) return;
      const loaded = await loadedModels(target.connection);
      // No answer: a load is in progress (Ollama answers after it) or the server is away.
      if (stopped || !loaded?.length) continue;
      if (loaded.some((name) => sameModel(name, model))) {
        if (blocker) {
          cleared = true;
          call.wait?.(undefined);
        }
        return;
      }
      const next = busy().find((other) => loaded.some((name) => sameModel(name, other))) ?? loaded[0];
      if (blocker && sameModel(blocker, next)) continue;
      blocker = next;
      call.wait?.(shortName(next));
    }
  })();
  return () => {
    if (stopped) return;
    stopped = true;
    if (!blocker) return;
    const waited = blocker;
    if (!cleared) call.wait?.(undefined);
    const key = `${server}|${[shortName(waited), shortName(model)].sort().join("|")}`;
    if (!call.swapped || swapsTold.has(key)) return;
    void loadedModels(target.connection).then((loaded) => {
      if (!loaded || loaded.some((name) => sameModel(name, waited)) || swapsTold.has(key)) return;
      swapsTold.add(key);
      call.swapped?.([shortName(waited), shortName(model)]);
    });
  };
}

/** What a call in a slot tells the scheduler: its first piece arrived. */
export interface Slot {
  first(): void;
}

export async function withSlot<T>(target: SlotTarget, signal: AbortSignal, work: (slot: Slot) => Promise<T>): Promise<T> {
  const call = currentCall();
  const queue = queueFor(target);
  if (!queue) {
    await holdBack(target, call, signal);
    return work({ first: () => {} });
  }
  if (queue.active >= queue.limit || queue.waiting.length || queue.ollama?.measuring) {
    void recheck(queue).then(() => dispatch(queue));
    await new Promise<void>((resolve, reject) => {
      const item: Waiting = {
        call,
        order: arrivals++,
        start: () => {
          signal.removeEventListener("abort", cancel);
          resolve();
        },
      };
      const cancel = () => {
        queue.waiting = queue.waiting.filter((other) => other !== item);
        reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      queue.waiting.push(item);
      signal.addEventListener("abort", cancel, { once: true });
      dispatch(queue);
    });
  } else {
    queue.active++;
    // A model seen unloaded is noticed even when nothing waits, so a count measured below the cap is not reused.
    if (queue.ollama) void recheck(queue);
  }
  const running: Running = { ended: false, alongside: [...queue.running] };
  queue.running.add(running);
  const stopWatching = watchOllamaWait(target);
  let told = false;
  try {
    return await work({
      first: () => {
        if (told) return;
        told = true;
        stopWatching();
        firstPiece(queue, running);
      },
    });
  } finally {
    stopWatching();
    running.ended = true;
    queue.running.delete(running);
    queue.active--;
    dispatch(queue);
  }
}

/** For tests: forgets every queue and what is on screen. */
export function resetSlots() {
  queues.clear();
  swapsTold.clear();
  visible = new Set();
}
