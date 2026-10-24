import { applyOrder } from "./ordering";
import { decorateModel } from "../features/model-settings/preferences";
import type { ThinkingControl } from "./thinking-switch";

export type ModelCapability = "reasoning" | "vision" | "tools";
/**
 * What a model is for. Only chat models answer in a chat; the others are listed in Models settings and used by
 * the features that need them. A runtime that does not say is taken to serve chat models.
 */
export type ModelKind = "chat" | "embedding" | "speech" | "other";
export const MODEL_KINDS: { value: ModelKind; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "embedding", label: "Embedding" },
  { value: "speech", label: "Speech to text" },
  { value: "other", label: "Not a chat model" },
];

/** The connection a model is served from. */
export type ModelGroup = string;
/** Where a server runs, from its address: decides wording and the Remote label, never what is sent. */
export type ServerLocation = "this-computer" | "network" | "remote";

export interface ModelInfo {
  id: string;
  runtime?: RuntimeId;
  runtimeModelId?: string;
  name: string;
  provider: string;
  providerLabel: string;
  description: string;
  context: number;
  maxContext?: number;
  /** A runtime model's window as its runtime reports it now: loaded, and stored with the model (Ollama's num_ctx). */
  loadedContext?: number;
  configuredContext?: number;
  /** Ollama's default window as seen on this model's server; see lib/context-window. */
  runtimeDefaultContext?: number;
  capabilities: ModelCapability[];
  /** USD per 1M tokens: [input, output] */
  price: [number, number];
  group?: ModelGroup;
  /** Short muted descriptor shown after the name, e.g. quantization */
  variant?: string;
  /** The connection that serves this model; builtin connections use their runtime ID. */
  connectionId?: string;
  location?: ServerLocation;
  /** The runtime reported capabilities itself (Ollama does); otherwise the person may set them. */
  capabilitiesReported?: boolean;
  /** The thinking choices the runtime reports for this model: on/off, or named levels. */
  thinking?: ThinkingControl;
  /** What the model is for, as its runtime reports it; unset when the runtime does not say. */
  kind?: ModelKind;
}

/** The models of the connected runtimes, as their catalog reports them (registerRuntimeModels). */
export const MODELS: ModelInfo[] = [];

/** What a chat shows before any model is chosen or any runtime is connected; it cannot be sent to. */
export const NO_MODEL: ModelInfo = { id: "", name: "Choose a model", provider: "local", providerLabel: "", description: "Connect a runtime in Settings", context: 0, capabilities: [], price: [0, 0] };

export const getModel = (id: string | undefined): ModelInfo => {
  const found = id ? MODELS.find((m) => m.id === id) : undefined;
  if (found) return decorateModel(found);
  const ref = id ? parseModelId(id) : undefined;
  // A model whose server is unavailable still routes to that connection, so the request fails there with its reason.
  if (ref) {
    const runtime = isRuntimeId(ref.connectionId) ? ref.connectionId : "openai";
    return { id: id!, runtime, runtimeModelId: ref.model, name: ref.model, provider: "local", providerLabel: isRuntimeId(ref.connectionId) ? runtimeName(ref.connectionId) : "Server", description: "Runtime unavailable", context: 0, capabilities: [], price: [0, 0], group: ref.connectionId, connectionId: ref.connectionId };
  }
  return NO_MODEL;
};

/**
 * Model IDs name the connection, not its address or location: builtin connections keep the original
 * local:<runtime>:<model> form so saved chats and settings stay valid; added servers use server:<id>:<model>.
 * Model names may contain colons (Ollama tags), so only the first two separate.
 */
export const modelIdFor = (connectionId: string, model: string) => `${isRuntimeId(connectionId) ? "local" : "server"}:${connectionId}:${model}`;
export function parseModelId(id: string): { connectionId: string; model: string } | undefined {
  const match = /^(local|server):([^:]+):([\s\S]+)$/.exec(id);
  if (!match || (match[1] === "local") !== isRuntimeId(match[2])) return undefined;
  return { connectionId: match[2], model: match[3] };
}
export function registerRuntimeModels(models: ModelInfo[]) {
  MODELS.splice(0, MODELS.length, ...models);
  PROVIDERS.splice(0, PROVIDERS.length, ...new Set(MODELS.map((m) => m.providerLabel)));
}

export const PROVIDERS = [...new Set(MODELS.map((m) => m.providerLabel))];


/** Local model servers people commonly run. Ollama is listed by default; others appear when detected or added. */
export const RUNTIMES = [
  { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", primary: true },
  { id: "vllm", name: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "mlx", name: "MLX LM", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "jan", name: "Jan", baseUrl: "http://127.0.0.1:1337/v1" },
  { id: "gpt4all", name: "GPT4All", baseUrl: "http://127.0.0.1:4891/v1" },
  { id: "koboldcpp", name: "KoboldCpp", baseUrl: "http://127.0.0.1:5001/v1" },
  { id: "textgen", name: "text-generation-webui", baseUrl: "http://127.0.0.1:5000/v1" },
  { id: "localai", name: "LocalAI", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "docker", name: "Docker Model Runner", baseUrl: "http://127.0.0.1:12434/engines/v1" },
  { id: "sglang", name: "SGLang", baseUrl: "http://127.0.0.1:30000/v1" },
  { id: "tgi", name: "Text Generation Inference", baseUrl: "http://127.0.0.1:8080/v1" },
  // Any server that answers the OpenAI-compatible API but names no runtime. It has no default address.
  { id: "openai", name: "OpenAI-compatible", baseUrl: "" },
] as const satisfies readonly { id: string; name: string; baseUrl: string; primary?: boolean }[];

export type RuntimeId = (typeof RUNTIMES)[number]["id"];
export const RUNTIME_IDS = RUNTIMES.map((runtime) => runtime.id) as RuntimeId[];
export const PRIMARY_RUNTIMES = RUNTIMES.filter((runtime) => "primary" in runtime && runtime.primary).map((runtime) => runtime.id) as RuntimeId[];
export const isRuntimeId = (value: unknown): value is RuntimeId => RUNTIME_IDS.includes(value as RuntimeId);
export const runtimeName = (id: string) => RUNTIMES.find((runtime) => runtime.id === id)?.name ?? id;
/** Runtimes whose own API can install models from Hugging Face. */
export const DOWNLOAD_RUNTIMES: RuntimeId[] = ["ollama", "lmstudio", "llamacpp"];

export interface ModelGroupInfo {
  id: ModelGroup;
  label: string;
  meta: string;
  local: boolean;
  location?: ServerLocation;
}
/** Model groups, one per connection, and their models in the person's saved order. Groups and models found later go last. */
export function arrangeModels(models: ModelInfo[], order: { groups: readonly string[]; models: readonly string[] }) {
  return applyOrder(modelGroups(models), order.groups, (group) => group.id).map((group) => ({
    ...group,
    models: applyOrder(
      models.filter((model) => groupOf(model) === group.id),
      order.models,
      (model) => model.id
    ),
  }));
}

export function modelGroups(models: ModelInfo[]): ModelGroupInfo[] {
  const groups = new Map<string, ModelGroupInfo>();
  for (const model of models) {
    const id = groupOf(model);
    if (groups.has(id)) continue;
    groups.set(id, { id, label: model.providerLabel, meta: id === "ollama" && !model.connectionId ? "localhost:11434" : "", local: true, location: model.location });
  }
  return [...groups.values()];
}

export interface RuntimeConnection {
  /** The API address without query or fragment. */
  baseUrl: string;
  /** Empty in the desktop renderer: the main process keeps saved keys encrypted and adds them to requests. */
  apiKey: string;
  /** Extra request headers, such as a hosting provider's access token. Main process only. */
  headers?: Record<string, string>;
  /** Requests sent to this server at once; unset lets the server decide. Not used for Ollama, which is measured. */
  concurrency?: number;
  /** Query parameters from a signed address, such as an access token. Main process only, like headers. */
  query?: string;
}

/** What the renderer may know about saved secrets: that they exist, never their values. */
export interface ConnectionSecrets {
  hasKey: boolean;
  headerNames: string[];
  /** Query parameter names from a signed address. */
  queryNames?: string[];
  /** Saved for a previous address, so they are not sent until the person moves them to this one. */
  elsewhere?: boolean;
}

export const DEFAULT_CONNECTIONS = Object.fromEntries(RUNTIMES.map((runtime) => [runtime.id, { baseUrl: runtime.baseUrl, apiKey: "" }])) as Record<RuntimeId, RuntimeConnection>;

export function endpointLabel(baseUrl: string) {
  return baseUrl.trim().replace(/\/$/, "").replace(/^http:\/\//i, "");
}

export function normalizeBaseUrl(value: string, fallback: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return fallback;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export const groupOf = (m: ModelInfo): ModelGroup => m.group ?? m.connectionId ?? m.runtime ?? "";

// Runtimes report binary sizes (32768); catalog entries use decimal ones (400_000). Show each as written.
/**
 * Share of the context window a conversation may fill before older turns are summarized: the rest is kept
 * for the answer, a quarter for a model that thinks and an eighth for one that does not, as the harness starts
 * (harness/budget). The harness follows what each model actually writes, so this is the line to expect.
 */
export const compactLine = (thinks: boolean) => 1 - (thinks ? 1 / 4 : 1 / 8);

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** A token count as the chat shows it: 999, 1.2K, 34.2K. */
export const formatTokens = (n: number) => compactNumber.format(Math.max(0, Math.round(n)));

export const formatContext = (n: number) =>
  !n
    ? "Unknown"
    : n % 1024 === 0
      ? n >= 1_048_576 ? `${n / 1_048_576}M` : `${n / 1024}K`
      : n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
