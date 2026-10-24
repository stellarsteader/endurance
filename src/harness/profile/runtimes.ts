/**
 * What the harness knows about each runtime, in one place: how to ask it about a model and how it is told to
 * think. The list is per runtime, a small and stable set of API dialects; nothing here is per model. What a
 * model needs is read from the runtime (see ./models) or learned while it is used.
 */
import { Ollama } from "../vendor/schema/ollama";
import { endpoint, headers, runtimeUrl, serverRoot } from "../runtime";
import type { RuntimeConnection, RuntimeId } from "../../lib/models";
import { switchesByTemplate } from "../../lib/thinking-switch";

export interface RuntimeTarget {
  runtime: RuntimeId;
  connection: RuntimeConnection;
}

/** What a runtime reports about one model now. Anything it does not report stays undefined. */
export interface ModelFacts {
  /** The window the model is loaded with. */
  loaded?: number;
  /** The window it will be loaded with when it is not loaded, as configured on the runtime (Ollama num_ctx). */
  configured?: number;
  /** The window the model was trained for. */
  max?: number;
  /** The model's chat template, where the runtime shares it. */
  template?: string;
  /** Model family as the runtime names it, such as Ollama's "qwen35". */
  family?: string;
  capabilities?: string[];
  quantization?: string;
  /** The loaded model's size and how much of it sits in GPU memory, in bytes. */
  memory?: { total: number; gpu: number };
  /** The model's files in bytes (Ollama: its listed size, vision projector included). */
  weights?: number;
  /** f16 KV cache bytes per token of context, from the model's metadata. */
  kvPerToken?: number;
  /** kvPerToken counts every layer at the full window; sliding-window layers keep less, so it is at most this. */
  kvUpperBound?: boolean;
}

/**
 * How thinking is switched:
 * - native: the runtime takes the effort and applies it to the model itself (Ollama as `think`, see ../ollama-chat).
 * - template: the runtime passes chat_template_kwargs to the model's chat template, so the variable has to be
 *   the one that template reads (see ./template).
 */
export type ThinkingSwitch = "native" | "template";

export interface RuntimeProfile {
  thinking: ThinkingSwitch;
  inspect(target: RuntimeTarget, modelId: string, transport?: typeof fetch): Promise<ModelFacts>;
  /**
   * Loads a model that is not loaded before the first request uses it: at the window the person chose, for a
   * runtime that keeps none of its own (LM Studio), or at the runtime's default, to learn it (Ollama).
   */
  load?(target: RuntimeTarget, modelId: string, window?: number, transport?: typeof fetch): Promise<void>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const list = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);

/** Detail requests are best effort: a slow, failing or unexpected answer reads as nothing reported. */
async function ask(target: RuntimeTarget, url: string, body: unknown, transport: typeof fetch) {
  try {
    const response = await transport(runtimeUrl(target.connection, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers(target.connection), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return {};
    }
    return record(await response.json());
  } catch {
    return {};
  }
}

const base = (target: RuntimeTarget) => endpoint(target.connection);
const root = (target: RuntimeTarget) => serverRoot(base(target));

/**
 * KV cache bytes per token at f16 (2 bytes per value), from GGUF metadata as Ollama's /api/show reports it:
 * (key_length + value_length) × KV heads × 2, summed over the layers that keep KV. A per-layer head_count_kv
 * array (LFM2) marks conv layers with 0; a hybrid model's full_attention_interval N keeps KV in every Nth layer
 * (Qwen3.5). Missing keys mean no figure; sliding-window layers make it an upper bound.
 */
function kvCache(info: Record<string, unknown>): { kvPerToken?: number; kvUpperBound?: boolean } {
  const arch = text(info["general.architecture"]);
  if (!arch) return {};
  const key = (name: string) => info[`${arch}.${name}`];
  const first = (value: unknown) => (Array.isArray(value) ? positive(value.find((item) => positive(item))) : positive(value));
  const blocks = positive(key("block_count"));
  const heads = first(key("attention.head_count"));
  const embedding = positive(key("embedding_length"));
  const width = heads && embedding ? embedding / heads : undefined;
  const keyLength = positive(key("attention.key_length")) ?? width;
  const valueLength = positive(key("attention.value_length")) ?? width;
  if (!blocks || !keyLength || !valueLength) return {};
  const headsKv = key("attention.head_count_kv") ?? key("attention.head_count");
  let total: number | undefined;
  if (Array.isArray(headsKv)) total = headsKv.reduce<number>((sum, item) => sum + (positive(item) ?? 0), 0);
  else {
    const perLayer = positive(headsKv);
    const interval = positive(key("full_attention_interval"));
    total = perLayer ? perLayer * (interval ? Math.floor(blocks / interval) : blocks) : undefined;
  }
  if (!total) return {};
  return { kvPerToken: (keyLength + valueLength) * total * 2, kvUpperBound: key("attention.sliding_window") !== undefined || undefined };
}

/** Ollama's own limit on a stalled load is five minutes (OLLAMA_LOAD_TIMEOUT); a slow disk can take most of it. */
const LOAD_TIMEOUT = 300_000;

const ollama: RuntimeProfile = {
  thinking: "native",
  async load(target, modelId, _window, transport = fetch) {
    // A generate request without a prompt only loads the model. Loading reads the weights, so allow for it.
    const response = await transport(runtimeUrl(target.connection, `${Ollama.baseURL(base(target))}/api/generate`), {
      method: "POST",
      headers: { ...headers(target.connection), "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, stream: false }),
      redirect: "error",
      signal: AbortSignal.timeout(LOAD_TIMEOUT),
    });
    if (response.ok) return void response.body?.cancel().catch(() => undefined);
    const reason = text(record(await response.json().catch(() => ({}))).error);
    throw new Error(`Ollama could not load ${modelId}${reason ? `: ${reason}` : ` (HTTP ${response.status})`}.`);
  },
  async inspect(target, modelId, transport = fetch) {
    const api = Ollama.baseURL(base(target));
    const [show, ps, tags] = await Promise.all([
      ask(target, `${api}/api/show`, { model: modelId }, transport),
      ask(target, `${api}/api/ps`, undefined, transport),
      ask(target, `${api}/api/tags`, undefined, transport),
    ]);
    const listed = list(tags.models).find((item) => typeof item.name === "string" && Ollama.tagKey(item.name) === Ollama.tagKey(modelId));
    const parameters = text(show.parameters) ?? "";
    const active = list(ps.models).find((item) => typeof item.name === "string" && Ollama.tagKey(item.name) === Ollama.tagKey(modelId));
    const size = positive(active?.size);
    return {
      loaded: positive(active?.context_length),
      configured: positive(Number(parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1])),
      max: positive(Object.entries(record(show.model_info)).find(([key]) => key.endsWith(".context_length"))?.[1]),
      template: text(show.template),
      family: text(record(show.details).family),
      capabilities: Array.isArray(show.capabilities) ? show.capabilities.filter((item): item is string => typeof item === "string") : undefined,
      quantization: text(record(show.details).quantization_level),
      memory: size ? { total: size, gpu: typeof active?.size_vram === "number" ? active.size_vram : 0 } : undefined,
      weights: positive(listed?.size),
      ...kvCache(record(show.model_info)),
    };
  },
};

const lmstudio: RuntimeProfile = {
  thinking: "template",
  async load(target, modelId, window, transport = fetch) {
    if (!window) return;
    // Loading takes as long as reading the weights; a failure leaves LM Studio to load it with its default.
    await transport(runtimeUrl(target.connection, `${root(target)}/api/v1/models/load`), {
      method: "POST",
      headers: { ...headers(target.connection), "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, context_length: window }),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    })
      .then((response) => void response.body?.cancel().catch(() => undefined))
      .catch(() => undefined);
  },
  async inspect(target, modelId, transport = fetch) {
    const inventory = await ask(target, `${root(target)}/api/v1/models`, undefined, transport);
    const model = list(inventory.models).find(
      (item) => item.key === modelId || item.id === modelId || list(item.loaded_instances).some((instance) => instance.id === modelId)
    );
    if (!model) return {};
    const instances = list(model.loaded_instances);
    const instance = instances.find((item) => item.id === modelId) ?? instances[0];
    const flags = record(model.capabilities);
    return {
      loaded: positive(record(instance?.config).context_length) ?? positive(model.loaded_context_length),
      max: positive(model.max_context_length),
      capabilities: Object.entries(flags)
        .filter(([, value]) => value === true || Object.keys(record(value)).length > 0)
        .map(([key]) => key),
      quantization: text(record(model.quantization).name) ?? text(model.quantization),
    };
  },
};

const llamacpp: RuntimeProfile = {
  thinking: "template",
  async inspect(target, modelId, transport = fetch) {
    const [props, models] = await Promise.all([
      ask(target, `${root(target)}/props?model=${encodeURIComponent(modelId)}&autoload=false`, undefined, transport),
      ask(target, `${base(target)}/models`, undefined, transport),
    ]);
    const listed = list(models.data);
    // A server with one model answers /props for it whatever the name.
    const item = listed.find((entry) => entry.id === modelId) ?? (listed.length === 1 ? listed[0] : undefined);
    return {
      loaded: positive(record(props.default_generation_settings).n_ctx),
      max: positive(record(item?.meta).n_ctx_train),
      template: text(props.chat_template),
    };
  },
};

/** OpenAI-compatible servers that report a window on /models: vLLM and SGLang as max_model_len, others by other names. */
const compatible = (): RuntimeProfile => ({
  thinking: "native",
  async inspect(target, modelId, transport = fetch) {
    const models = await ask(target, `${base(target)}/models`, undefined, transport);
    const item = list(models.data).find((entry) => entry.id === modelId);
    return { loaded: positive(item?.max_model_len) ?? positive(item?.context_length) ?? positive(item?.context_window) };
  },
});

/** Servers that run one model and report its window on their own route. */
const single = (route: string, read: (value: Record<string, unknown>) => number | undefined): RuntimeProfile => ({
  thinking: "native",
  async inspect(target, _modelId, transport = fetch) {
    return { loaded: read(await ask(target, `${root(target)}${route}`, undefined, transport)) };
  },
});

const PROFILES: Record<RuntimeId, RuntimeProfile> = {
  ollama,
  lmstudio,
  llamacpp,
  vllm: compatible(),
  sglang: compatible(),
  mlx: compatible(),
  jan: compatible(),
  docker: compatible(),
  localai: compatible(),
  gpt4all: compatible(),
  textgen: compatible(),
  openai: compatible(),
  koboldcpp: single("/api/extra/true_max_context_length", (value) => positive(value.value)),
  tgi: single("/info", (value) => positive(value.max_total_tokens) ?? positive(value.max_input_tokens)),
};

/** A runtime's profile; how it switches thinking comes from the shared list in lib/thinking-switch. */
export function runtimeProfile(runtime: RuntimeId): RuntimeProfile {
  const profile = PROFILES[runtime] ?? PROFILES.openai;
  return { ...profile, thinking: switchesByTemplate(runtime) ? "template" : "native" };
}
