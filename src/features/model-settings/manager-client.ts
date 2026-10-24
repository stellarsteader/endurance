/**
 * The Endurance vLLM manager on a server the person runs (server/): it starts each model in its own vLLM
 * container at the window chosen here, downloads and deletes models, and says what each model's files hold.
 * Called from the main process with the connection's saved address and token (the connection's API key);
 * the renderer only names the connection. A vLLM connection that answers /manager/info is managed.
 */
import { endpoint, headers, runtimeUrl, serverRoot } from "../../harness/runtime";
import type { Sampling } from "../../lib/sampling";
import type { ModelKind, RuntimeConnection } from "../../lib/models";

export interface ManagerInfo {
  version: string;
  /** The image models start with unless one is named for them. */
  image: string;
  gpu: { name: string; memoryBytes: number };
}

export interface ManagedModel {
  /** The Hugging Face repository, owner/name; also the name the model is served under. */
  id: string;
  sizeBytes: number;
  kind: ModelKind;
  /** The sampling the model's generation_config.json recommends, which vLLM applies when nothing is sent. */
  sampling: Sampling;
  /** The longest window the model takes, from its config. */
  maxWindow?: number;
  kvBytesPerToken?: number;
  weightsBytes: number;
  status: "stopped" | "starting" | "ready";
  /** While it runs: its window, memory share and image. */
  window?: number;
  share?: number;
  image?: string;
  /** What the next start uses when nothing new is chosen: unset window is the most that fits. */
  saved: { window?: number | null; image?: string | null; args?: string[] };
}

export interface ManagerPlan {
  window: number;
  share: number;
  needBytes: number;
  fits: boolean;
  largestWindow?: number;
  stop: string[];
  message: string;
}

export interface ManagerDownload {
  id: string;
  state: "downloading" | "done" | "failed";
  doneBytes: number;
  totalBytes: number;
  error: string;
}

/** The manager's answer, or its own words when it refused: "does not fit", "still starting", "not downloaded". */
async function call<T>(connection: RuntimeConnection, route: string, init: { method?: string; body?: unknown; text?: boolean; timeout?: number } = {}, transport: typeof fetch = fetch): Promise<T> {
  const response = await transport(runtimeUrl(connection, `${serverRoot(endpoint(connection))}/manager${route}`), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...headers(connection), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "error",
    signal: AbortSignal.timeout(init.timeout ?? 15_000),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as { error?: { message?: string }; detail?: string };
    throw new Error(value.error?.message ?? value.detail ?? `The manager answered ${response.status}.`);
  }
  return (init.text ? await response.text() : await response.json()) as T;
}

const repo = (id: string) => {
  if (!/^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(id) || id.includes("..")) throw new Error("Name a model as owner/name, as on Hugging Face.");
  return id;
};

/** The manager's version and the server's GPU, or undefined when the connection is not a manager. */
export async function managerInfo(connection: RuntimeConnection, transport: typeof fetch = fetch): Promise<ManagerInfo | undefined> {
  try {
    const info = await call<ManagerInfo>(connection, "/info", { timeout: 4000 }, transport);
    return typeof info?.version === "string" ? info : undefined;
  } catch {
    return undefined;
  }
}

export const managerModels = async (connection: RuntimeConnection, transport?: typeof fetch) =>
  call<{ models: ManagedModel[] }>(connection, "/models", {}, transport).then((value) => value.models);

export const managerPlan = async (connection: RuntimeConnection, model: string, window?: number, transport?: typeof fetch) =>
  call<ManagerPlan>(connection, `/plan?model=${encodeURIComponent(repo(model))}${window ? `&window=${window}` : ""}`, {}, transport);

/** Starts the model, or restarts it with a new window or image; unset keeps what it last ran with. */
export const managerStart = async (connection: RuntimeConnection, model: string, options: { window?: number; image?: string }, transport?: typeof fetch) =>
  call<{ status: string; window: number; share: number }>(connection, `/models/${repo(model)}/start`, { body: options }, transport);

export const managerStop = async (connection: RuntimeConnection, model: string, transport?: typeof fetch) =>
  call<{ stopped: boolean }>(connection, `/models/${repo(model)}/stop`, { body: {} }, transport);

export const managerDelete = async (connection: RuntimeConnection, model: string, transport?: typeof fetch) =>
  call<{ deleted: boolean }>(connection, `/models/${repo(model)}`, { method: "DELETE" }, transport);

export const managerLogs = async (connection: RuntimeConnection, model: string, transport?: typeof fetch) =>
  call<string>(connection, `/models/${repo(model)}/logs?tail=300`, { text: true }, transport);

/** Starts a download on the server; the Hugging Face token, when there is one, goes with this request only. */
export const managerDownload = async (connection: RuntimeConnection, model: string, token: string | undefined, transport?: typeof fetch) =>
  call<{ state: string; totalBytes: number }>(connection, "/downloads", { body: { model: repo(model), ...(token ? { token } : {}) }, timeout: 60_000 }, transport);

export const managerDownloads = async (connection: RuntimeConnection, transport?: typeof fetch) =>
  call<{ downloads: ManagerDownload[] }>(connection, "/downloads", {}, transport).then((value) => value.downloads);
