import { Ollama } from "./vendor/schema/ollama";
import { thinkingKnob } from "./profile/template";
import { controlFromValues, type Level, type ThinkingControl } from "../lib/thinking-switch";
import type { CatalogResult, ProbeReason, RuntimeProbe } from "../lib/desktop";
import { observedDefault } from "../lib/context-window";
import { classifyHost } from "../lib/connections";
import { modelIdFor, PRIMARY_RUNTIMES, RUNTIMES, runtimeName, type ModelInfo, type ModelKind, type RuntimeConnection, type RuntimeId, type ServerLocation } from "../lib/models";

export function endpoint(connection: RuntimeConnection) {
  const url = new URL(connection.baseUrl);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("Use an HTTP runtime URL without embedded credentials, query or fragment.");
  return url.href.replace(/\/+$/, "");
}
/**
 * Every runtime request URL passes through here, so a signed address's query (kept as a secret, never in
 * baseUrl) reaches every endpoint of that server and nowhere else.
 */
export function runtimeUrl(connection: Pick<RuntimeConnection, "query">, url: string) {
  if (!connection.query) return url;
  const target = new URL(url);
  for (const [key, value] of new URLSearchParams(connection.query)) target.searchParams.set(key, value);
  return target.toString();
}
/**
 * A fetch that adds the connection's signed query to requests under its own address only. Code that builds
 * many routes from one base (model management, downloads) wraps its transport once instead of each URL.
 */
export function connectionTransport(connection: Pick<RuntimeConnection, "query" | "baseUrl">, transport: typeof fetch = fetch): typeof fetch {
  if (!connection.query) return transport;
  let root: URL;
  try {
    root = new URL(connection.baseUrl);
  } catch {
    return transport;
  }
  const prefix = serverRoot(`${root.origin}${root.pathname.replace(/\/+$/, "")}`);
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    return transport(url === prefix || url.startsWith(`${prefix}/`) ? runtimeUrl(connection, url) : input, init);
  }) as typeof fetch;
}
export function headers(connection: RuntimeConnection): Record<string, string> {
  return { ...(connection.headers ?? {}), ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) };
}
/** A server reached over a network or tunnel may answer slowly; one on this computer that is slow is not there. */
const NETWORK_CHECK_MS = 10_000;
/** Milliseconds for checks and model management: `local` on this computer, longer for a server elsewhere. */
export function checkTimeout(connection: RuntimeConnection, local = 3000) {
  let host = "";
  try {
    host = new URL(connection.baseUrl).hostname;
  } catch {
    // An address that does not parse is checked as if it were elsewhere.
  }
  return classifyHost(host) === "this-computer" ? local : Math.max(local, NETWORK_CHECK_MS);
}
class HttpStatus extends Error {
  constructor(readonly status: number, readonly server?: string | null) {
    super(status === 401 || status === 403 ? "Authentication required" : `Runtime returned HTTP ${status}`);
  }
}

/** macOS AirPlay Receiver takes port 5000 and refuses every request, which reads like a missing key. */
const airplay = (error: unknown) => error instanceof HttpStatus && /^AirTunes/i.test(error.server ?? "");

/** Maps transport failures and statuses to a reason people can act on. */
export function classify(error: unknown): ProbeReason {
  if (error instanceof HttpStatus) {
    if (error.status === 401 || error.status === 403) return "auth";
    // A gateway answering for a server that is not ready yet, such as a machine still loading its model.
    if (error.status === 502 || error.status === 503 || error.status === 504) return "starting";
    return error.status === 404 || error.status === 405 ? "not-api" : "error";
  }
  if (error instanceof SyntaxError) return "not-api";
  const value = error as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (value?.name === "TimeoutError" || value?.name === "AbortError" || value?.cause?.name === "ConnectTimeoutError") return "timeout";
  const code = String(value?.cause?.code ?? value?.code ?? "");
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host";
  if (/TIMEOUT|ETIMEDOUT/.test(code)) return "timeout";
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "tls";
  if (error instanceof Error && /HTTP runtime URL|Invalid URL|configuration/.test(error.message)) return "address";
  return "error";
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** A GET whose answer is extra detail: any failure, status or non-JSON body reads as an empty record. */
const optionalRecord = (connection: RuntimeConnection, url: string) =>
  fetch(runtimeUrl(connection, url), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(checkTimeout(connection)) })
    .then((response) => {
      if (response.ok) return response.json();
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    })
    .then(record, () => ({}));

/** What a server reports about one listed model beyond its name. Absent fields stay unknown. */
interface ReportedModel {
  context?: number;
  maxContext?: number;
  capabilities: ModelInfo["capabilities"];
  capabilitiesReported?: boolean;
  thinking?: ThinkingControl;
  kind?: ModelKind;
}

const SOME_LEVELS: Level[] = ["low", "medium", "high"];

/** A template's thinking variable as a control: a level variable (gpt-oss) offers levels, a flag on and off. */
function templateControl(template: unknown, canTurnOff: boolean): ThinkingControl | undefined {
  const knob = thinkingKnob(typeof template === "string" ? template : undefined);
  if (knob?.kind === "effort") return { kind: "levels", levels: SOME_LEVELS, off: canTurnOff };
  return knob ? { kind: "toggle", off: true } : undefined;
}

/**
 * The one native endpoint per runtime that describes the served models: LM Studio's inventory, llama.cpp's
 * /props, KoboldCpp's context and TGI's /info. Other runtimes report nothing beyond /models.
 */
function serverDetails(runtime: RuntimeId, connection: RuntimeConnection, base: string) {
  const route = ({ lmstudio: "/api/v1/models", llamacpp: "/props", koboldcpp: "/api/extra/true_max_context_length", tgi: "/info" } as Partial<Record<RuntimeId, string>>)[runtime];
  return route ? optionalRecord(connection, `${serverRoot(base)}${route}`) : Promise.resolve({} as Record<string, unknown>);
}

/** Qwen3-ASR, the speech model Ollama serves through an audio projector, as its name or architecture names it. */
const ASR_NAME = /qwen3[-_ ]?asr/i;

/**
 * Whether an Ollama model turns speech into text, from its /api/show answer. Audio in without completion is
 * a model that only listens. Qwen3-ASR also reports completion, as chat models that hear do, so only its own
 * architecture, family or name tells it apart; nothing else is taken for a speech model.
 */
export function ollamaSpeech(info: Record<string, unknown>, name: string) {
  const reported = Array.isArray(info.capabilities) ? info.capabilities : [];
  if (reported.includes("audio") && !reported.includes("completion")) return true;
  if (reported.includes("embedding")) return false;
  const details = record(info.details);
  const families = Array.isArray(details.families) ? details.families : [];
  return [name, record(info.model_info)["general.architecture"], details.family, ...families].some((value) => typeof value === "string" && ASR_NAME.test(value));
}

/** LM Studio flags count when true; a non-empty object (such as reasoning options) also says the model has it. */
const flagged = (value: unknown) => value === true || Object.keys(record(value)).length > 0;

/**
 * Reads a listed model's loaded window, maximum and capabilities from what its server reported. Only
 * explicit values count; anything missing stays unknown so the person's own settings apply.
 */
function reportedModel(runtime: RuntimeId, name: string, item: Record<string, unknown>, server: Record<string, unknown>, props: Record<string, unknown> | undefined, single: boolean): ReportedModel {
  // vLLM, SGLang and compatible servers list the window they serve on each model.
  const result: ReportedModel = { context: positive(item.max_model_len), capabilities: [] };
  // The Endurance vLLM manager (server/) adds what each model is for, read from its files; plain vLLM says nothing.
  // Its "other" (an architecture it does not know) stays unknown, so such a model is still offered for chat.
  if (runtime === "vllm" && (item.kind === "chat" || item.kind === "embedding" || item.kind === "speech")) result.kind = item.kind;
  if (runtime === "lmstudio") {
    const inventory = Array.isArray(server.models) ? server.models.map(record) : [];
    const model = inventory.find((entry) => entry.key === name || entry.id === name || (Array.isArray(entry.loaded_instances) && entry.loaded_instances.some((instance) => record(instance).id === name)));
    if (!model) return result;
    const instances = Array.isArray(model.loaded_instances) ? model.loaded_instances.map(record) : [];
    const instance = instances.find((entry) => entry.id === name) ?? instances[0];
    result.context = positive(record(instance?.config).context_length) ?? positive(model.loaded_context_length) ?? result.context;
    result.maxContext = positive(model.max_context_length);
    const flags = record(model.capabilities);
    if (flagged(flags.vision) || model.type === "vlm") result.capabilities.push("vision");
    if (flagged(flags.reasoning)) result.capabilities.push("reasoning");
    // LM Studio names the reasoning options each model accepts, such as ["off", "on"] or ["low", "medium", "high"].
    result.thinking = controlFromValues(record(flags.reasoning).allowed_options);
    if (flagged(flags.trained_for_tool_use) || flagged(flags.tool_use) || flagged(flags.tools)) result.capabilities.push("tools");
    if (model.capabilities !== null && typeof model.capabilities === "object" && !Array.isArray(model.capabilities)) result.capabilitiesReported = true;
    // LM Studio types its models: llm and vlm chat, embedding embeds.
    if (model.type === "embedding") result.kind = "embedding";
    else if (model.type === "llm" || model.type === "vlm") result.kind = "chat";
    return result;
  }
  if (runtime === "llamacpp") {
    // n_ctx_train on the listing is the model's trained maximum; /props names the window it was loaded with.
    result.maxContext = positive(record(item.meta).n_ctx_train);
    const loaded = props ?? (single || server.model_alias === name || server.model_path === name || (typeof server.model_path === "string" && server.model_path.split("/").at(-1) === name) ? server : undefined);
    if (!loaded) return result;
    result.context = positive(record(loaded.default_generation_settings).n_ctx) ?? result.context;
    // Only vision is reported here, so the person's reasoning setting still applies.
    if (record(loaded.modalities).vision === true) result.capabilities.push("vision");
    // The template's own capabilities say whether it takes a reasoning effort; otherwise its variables say.
    result.thinking =
      record(loaded.chat_template_caps).supports_reasoning_effort === true
        ? { kind: "levels", levels: SOME_LEVELS, off: true }
        : templateControl(loaded.chat_template, false);
    return result;
  }
  // KoboldCpp and TGI serve one model, so the server's window is that model's.
  if (runtime === "koboldcpp") result.context = positive(server.value) ?? result.context;
  if (runtime === "tgi") result.context = positive(server.max_total_tokens) ?? positive(server.max_input_tokens) ?? result.context;
  return result;
}
/** How discovered models name their server. Builtin connections default to their runtime. */
export interface DiscoverySource {
  connectionId: string;
  label: string;
  location?: ServerLocation;
}
export async function discoverModels(runtime: RuntimeId, connection: RuntimeConnection, source: DiscoverySource = { connectionId: runtime, label: runtimeName(runtime) }): Promise<CatalogResult> {
  const identity = { connectionId: source.connectionId, runtime };
  try {
    const base = endpoint(connection);
    // The native detail endpoint is asked alongside the list; whatever it answers, the list stands alone.
    const details = runtime === "ollama" ? undefined : serverDetails(runtime, connection, base);
    const response = await fetch(runtimeUrl(connection, runtime === "ollama" ? `${Ollama.baseURL(base)}/api/tags` : `${base}/models`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(checkTimeout(connection)) });
    if (!response.ok) throw new HttpStatus(response.status, response.headers.get("server"));
    const data = record(await response.json());
    const items = runtime === "ollama" ? data.models : data.data;
    if (!Array.isArray(items)) throw new Error("The runtime returned an invalid model list.");
    const names = items.flatMap((item: unknown) => {
      const model = record(item); const name = runtime === "ollama" ? model.name : model.id;
      return typeof name === "string" && name.trim() ? [{ name, variant: record(model.details).quantization_level, item: model }] : [];
    });
    const listed = runtime === "ollama" ? Ollama.userModels(names) : [...new Map(names.map((model) => [model.name, model])).values()];
    const loaded = runtime === "ollama" ? await fetch(runtimeUrl(connection, `${Ollama.baseURL(base)}/api/ps`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(checkTimeout(connection)) }).then((value) => value.ok ? value.json() : undefined).catch(() => undefined) : undefined;
    const active = Array.isArray(record(loaded).models) ? record(loaded).models as unknown[] : [];
    const server = details ? await details : {};
    // A llama.cpp router lists several models with their state; each loaded one has its own /props.
    const routed = runtime === "llamacpp" && listed.some((model) => typeof record(model.item.status).value === "string");
    const props = new Map<string, Record<string, unknown>>();
    if (routed) {
      await Promise.all(listed.filter((model) => record(model.item.status).value === "loaded").map(async (model) => {
        const value = await optionalRecord(connection, `${serverRoot(base)}/props?model=${encodeURIComponent(model.name)}&autoload=false`);
        if (Object.keys(value).length) props.set(model.name, value);
      }));
    }
    const models: ModelInfo[] = await Promise.all(listed.map(async (model) => {
      const current = active.map(record).find((item) => typeof item.name === "string" && Ollama.tagKey(item.name) === Ollama.tagKey(model.name));
      let context = typeof current?.context_length === "number" ? current.context_length : 0;
      const loadedContext = context || undefined;
      let configuredContext: number | undefined;
      let maxContext = 0;
      let capabilities: ModelInfo["capabilities"] = [];
      let capabilitiesReported = false;
      let thinking: ThinkingControl | undefined;
      let kind: ModelKind | undefined;
      if (runtime === "ollama") {
        const detail = await fetch(runtimeUrl(connection, `${Ollama.baseURL(base)}/api/show`), { method: "POST", headers: { ...headers(connection), "Content-Type": "application/json" }, body: JSON.stringify({ model: model.name }), redirect: "error", signal: AbortSignal.timeout(checkTimeout(connection)) }).then((value) => value.ok ? value.json() : undefined).catch(() => undefined);
        const info = record(detail);
        const reported = Array.isArray(info.capabilities) ? info.capabilities : [];
        if (reported.includes("vision")) capabilities.push("vision");
        if (reported.includes("thinking")) capabilities.push("reasoning");
        if (reported.includes("tools")) capabilities.push("tools");
        // Ollama says what a model does: completion is chat (with audio or images besides), embedding only embeds.
        kind = ollamaSpeech(info, model.name) ? "speech" : reported.includes("completion") ? "chat" : reported.includes("embedding") ? "embedding" : undefined;
        // Ollama lists a model's thinking values when it knows them ([false, true], or level names). Without
        // them it still switches thinking on and off, and passes levels only to a template that reads them.
        if (reported.includes("thinking"))
          thinking = controlFromValues(record(info.thinking).values) ?? templateControl(info.template, false) ?? { kind: "toggle", off: true };
        maxContext = Object.entries(record(info.model_info)).find(([key, value]) => key.endsWith(".context_length") && typeof value === "number")?.[1] as number ?? 0;
        // An unloaded model still has the context it will load with when num_ctx is configured.
        const configured = typeof info.parameters === "string" ? Number(info.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1]) : 0;
        if (configured > 0) configuredContext = configured;
        if (!context && configured > 0) context = configured;
        // Only an answer that lists capabilities describes the model. A failed or timed-out /api/show leaves them
        // unknown, so the person can set them instead of the model reading as text-only.
        capabilitiesReported = Array.isArray(info.capabilities);
      } else {
        // A router's model without its own /props is not loaded, so the server-wide /props does not describe it.
        const reported = reportedModel(runtime, model.name, model.item, server, props.get(model.name), !routed && listed.length === 1);
        context = reported.context ?? 0;
        maxContext = reported.maxContext ?? 0;
        capabilities = reported.capabilities;
        capabilitiesReported = reported.capabilitiesReported === true;
        thinking = reported.thinking;
        kind = reported.kind;
      }
      return {
        id: modelIdFor(source.connectionId, model.name),
        runtime,
        runtimeModelId: model.name,
        name: model.name,
        provider: "local",
        providerLabel: source.label,
        description: "Connected runtime model",
        context,
        maxContext,
        ...(runtime === "ollama" ? { loadedContext, configuredContext } : {}),
        capabilities,
        price: [0, 0],
        group: source.connectionId,
        variant: typeof model.variant === "string" ? model.variant : undefined,
        connectionId: source.connectionId,
        ...(source.location ? { location: source.location } : {}),
        // Set only when the runtime itself said what the model can take; otherwise the person may set it.
        ...(capabilitiesReported ? { capabilitiesReported: true } : {}),
        ...(thinking ? { thinking } : {}),
        ...(kind ? { kind } : {}),
      };
    }));
    if (runtime === "ollama") {
      // One model loaded with no setting shows the server's default for the others.
      const seen = models.map((model) => observedDefault({ loaded: model.loadedContext, configured: model.configuredContext, max: model.maxContext })).find(Boolean);
      if (seen) return { ...identity, models: models.map((model) => ({ ...model, runtimeDefaultContext: seen })) };
    }
    return { ...identity, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runtime unavailable";
    if (airplay(error)) return { ...identity, models: [], error: message, reason: "other", detected: "airplay" };
    return { ...identity, models: [], error: message, reason: classify(error), ...(error instanceof HttpStatus ? { status: error.status } : {}) };
  }
}

/**
 * Reads what the runtime reports about itself for the connection test. Only documented read-only
 * endpoints are used; a value the runtime does not report is left out rather than guessed.
 */
export async function probeRuntime(runtime: RuntimeId, connection: RuntimeConnection, transport: typeof fetch = fetch): Promise<RuntimeProbe> {
  let base: string;
  try {
    base = endpoint(connection);
  } catch {
    return { ok: false, reason: "address" };
  }
  const root = runtime === "ollama" ? Ollama.baseURL(base) : serverRoot(base);
  const get = async (url: string) => {
    const response = await transport(runtimeUrl(connection, url), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(checkTimeout(connection, 5000)) });
    if (!response.ok) throw new HttpStatus(response.status, response.headers.get("server"));
    return record(await response.json());
  };
  const optional = (url: string) => get(url).catch(() => undefined);
  // Sub-millisecond loopback answers still show a measured value rather than "0 ms".
  const started = performance.now();
  const elapsed = () => Math.max(1, Math.round(performance.now() - started));
  try {
    if (runtime === "ollama") {
      const version = await get(`${root}/api/version`);
      const latencyMs = elapsed();
      const [tags, ps] = await Promise.all([get(`${root}/api/tags`), optional(`${root}/api/ps`)]);
      const listed = Array.isArray(tags.models) ? Ollama.userModels(tags.models.map(record).filter((item): item is Record<string, unknown> & { name: string } => typeof item.name === "string")) : [];
      const loaded = Array.isArray(ps?.models)
        ? ps.models.map(record).map((item) => ({ name: String(item.name ?? ""), bytes: positive(item.size_vram) ?? positive(item.size), context: positive(item.context_length) }))
        : undefined;
      return { ok: true, latencyMs, version: typeof version.version === "string" ? version.version : undefined, models: listed.length, loaded };
    }
    const models = await get(`${base}/models`);
    const latencyMs = elapsed();
    const data = Array.isArray(models.data) ? models.data.map(record) : [];
    const found = await identify(root, connection, transport, data);
    if (found && found !== runtime) return { ok: false, latencyMs, reason: "other", detected: found };
    if (!Array.isArray(models.data)) return { ok: false, latencyMs, reason: "not-api" };
    if (runtime === "vllm") {
      const version = await optional(`${root}/version`);
      return {
        ok: true,
        latencyMs,
        version: typeof version?.version === "string" ? version.version : undefined,
        models: data.length,
        maxContext: Math.max(0, ...data.map((item) => positive(item.max_model_len) ?? 0)) || undefined,
      };
    }
    if (runtime === "lmstudio") {
      const native = await optional(`${root}/api/v1/models`);
      const inventory = Array.isArray(native?.models) ? native.models.map(record) : [];
      const loaded = inventory.flatMap((model) =>
        (Array.isArray(model.loaded_instances) ? model.loaded_instances.map(record) : []).map((instance) => ({
          name: String(model.display_name ?? model.key ?? instance.id ?? ""),
          context: positive(record(instance.config).context_length),
        }))
      );
      return { ok: true, latencyMs, models: native ? inventory.length : data.length, loaded: native ? loaded : undefined };
    }
    if (runtime === "koboldcpp") {
      const [version, context, model] = await Promise.all([optional(`${root}/api/extra/version`), optional(`${root}/api/extra/true_max_context_length`), optional(`${root}/api/v1/model`)]);
      const name = typeof model?.result === "string" ? model.result.replace(/^koboldcpp\//, "") : undefined;
      return { ok: true, latencyMs, version: typeof version?.version === "string" ? version.version : undefined, models: data.length, loaded: name ? [{ name, context: positive(context?.value) }] : undefined };
    }
    if (runtime === "tgi") {
      const info = await optional(`${root}/info`);
      return { ok: true, latencyMs, version: typeof info?.version === "string" ? info.version : undefined, models: data.length, maxContext: positive(info?.max_total_tokens) ?? positive(info?.max_input_tokens) };
    }
    if (runtime === "sglang") {
      const info = await optional(`${root}/get_server_info`);
      return { ok: true, latencyMs, version: typeof info?.version === "string" ? info.version : undefined, models: data.length, maxContext: Math.max(0, ...data.map((item) => positive(item.max_model_len) ?? 0)) || undefined };
    }
    if (runtime === "localai") {
      const version = await optional(`${root}/version`);
      return { ok: true, latencyMs, version: typeof version?.version === "string" ? version.version.replace(/^LocalAI\s+/i, "") : undefined, models: data.length };
    }
    if (runtime !== "llamacpp") return { ok: true, latencyMs, models: data.length };
    const props = await optional(`${root}/props`);
    const context = positive(record(props?.default_generation_settings).n_ctx);
    const model = typeof props?.model_alias === "string" ? props.model_alias : typeof props?.model_path === "string" ? props.model_path.split("/").at(-1) : undefined;
    return {
      ok: true,
      latencyMs,
      version: typeof props?.build_info === "string" ? props.build_info.replace(/^b(\d+).*$/, "b$1") : undefined,
      models: data.length,
      loaded: model ? [{ name: model, context }] : undefined,
    };
  } catch (error) {
    if (airplay(error)) return { ok: false, reason: "other", detected: "airplay" };
    const reason = classify(error);
    // A server that answers but not as expected is often a different runtime on the same port.
    const found = reason === "not-api" ? await identify(root, connection, transport).catch(() => undefined) : undefined;
    if (found && found !== runtime) return { ok: false, reason: "other", detected: found };
    return { ok: false, reason, status: error instanceof HttpStatus ? error.status : undefined };
  }
}

/** The server address without its OpenAI-compatible path, where native endpoints live. */
export const serverRoot = (base: string) => base.replace(/\/(?:api\/|engines\/)?v1$/, "");

/**
 * Names the runtime behind an address from endpoints only that runtime serves. Several runtimes share
 * default ports, so the address alone is not enough. Returns undefined when nothing identifies it.
 */
export async function identify(root: string, connection: RuntimeConnection, transport: typeof fetch = fetch, models?: Record<string, unknown>[]): Promise<RuntimeId | undefined> {
  const look = (route: string) =>
    transport(runtimeUrl(connection, `${root}${route}`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(Math.min(2000, checkTimeout(connection))) })
      .then(async (response) => (response.ok && /json/.test(response.headers.get("content-type") ?? "") ? record(await response.json()) : undefined))
      .catch(() => undefined);
  const [kobold, ollama, lmstudio, textgen, tgi, sglang, localai, llama, manager] = await Promise.all(
    ["/api/extra/version", "/api/version", "/api/v1/models", "/v1/internal/model/info", "/info", "/get_server_info", "/system", "/props", "/manager/info"].map(look)
  );
  if (kobold?.result === "KoboldCpp") return "koboldcpp";
  if (typeof ollama?.version === "string" && Object.keys(ollama).length === 1) return "ollama";
  if (Array.isArray(lmstudio?.models) && lmstudio.models.map(record).every((model) => typeof model.key === "string")) return "lmstudio";
  if (typeof textgen?.model_name === "string") return "textgen";
  if (typeof tgi?.model_id === "string" && typeof tgi.version === "string") return "tgi";
  if (sglang && ("tp_size" in sglang || "model_path" in sglang)) return "sglang";
  if (Array.isArray(localai?.backends)) return "localai";
  if (llama && ("default_generation_settings" in llama || typeof llama.build_info === "string")) return "llamacpp";
  if (models?.some((model) => model.owned_by === "vllm")) return "vllm";
  // The Endurance vLLM manager (server/) serves vLLM, also while all its models are stopped and none is listed.
  if (typeof manager?.version === "string" && typeof manager.image === "string") return "vllm";
  return undefined;
}

/**
 * Finds runtimes running at their default addresses that are not listed yet. A runtime that shares its
 * port with another is only reported when its own endpoints identify it.
 */
export async function detectRuntimes(listed: RuntimeId[], transport: typeof fetch = fetch): Promise<RuntimeId[]> {
  const candidates = RUNTIMES.filter((runtime) => runtime.baseUrl && !listed.includes(runtime.id));
  const addresses = [...new Set(candidates.map((runtime) => runtime.baseUrl))];
  const found = await Promise.all(
    addresses.map(async (baseUrl): Promise<RuntimeId | undefined> => {
      const connection = { baseUrl, apiKey: "" };
      const response = await transport(`${baseUrl}/models`, { redirect: "error", signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      if (!response) return undefined;
      const body = response.ok ? record(await response.json().catch(() => undefined)) : {};
      // 401 is a server asking for its API key; a 403 is as likely another service, such as AirPlay on 5000.
      const answers = Array.isArray(body.data) || response.status === 401;
      if (!answers) return undefined;
      const known = await identify(serverRoot(baseUrl), connection, transport, Array.isArray(body.data) ? body.data.map(record) : []);
      if (known) return RUNTIMES.find((runtime) => runtime.id === known)?.baseUrl === baseUrl ? known : undefined;
      const sharing = RUNTIMES.filter((runtime) => runtime.baseUrl === baseUrl);
      return sharing.length === 1 ? sharing[0].id : undefined;
    })
  );
  return found.filter((id): id is RuntimeId => Boolean(id) && !listed.includes(id!) && !PRIMARY_RUNTIMES.includes(id!));
}

export interface ServerInspection {
  /** The API base that answered: as given, or with /v1 when only that path serves /models. */
  baseUrl: string;
  /** The runtime its own endpoints name, else "openai" for a plain OpenAI-compatible server. */
  kind: RuntimeId;
  probe: RuntimeProbe;
}

/**
 * Reads a server added by address. Decisions come from HTTP answers only: /models with a data list marks
 * the API base, 401/403 asks for a key, 502/503/504 is a server still starting, and the runtime is named
 * by endpoints only it serves. Nothing here knows hosting providers.
 */
export async function inspectServer(draft: RuntimeConnection, transport: typeof fetch = fetch): Promise<ServerInspection> {
  let base: string;
  try {
    base = endpoint(draft);
  } catch {
    return { baseUrl: draft.baseUrl, kind: "openai", probe: { ok: false, reason: "address" } };
  }
  const candidates = /\/v1$/.test(base) ? [base] : [base, `${base}/v1`];
  let lastStatus: number | undefined;
  for (const candidate of candidates) {
    const connection = { ...draft, baseUrl: candidate };
    const started = performance.now();
    let response: Response;
    try {
      response = await transport(runtimeUrl(connection, `${candidate}/models`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(checkTimeout(connection, 5000)) });
    } catch (error) {
      return { baseUrl: base, kind: "openai", probe: { ok: false, reason: classify(error) } };
    }
    const failure = new HttpStatus(response.status, response.headers.get("server"));
    if (airplay(failure) && !response.ok) return { baseUrl: base, kind: "openai", probe: { ok: false, reason: "other", detected: "airplay" } };
    if (response.status === 401 || response.status === 403) return { baseUrl: candidate, kind: "openai", probe: { ok: false, reason: "auth", status: response.status } };
    if (classify(failure) === "starting") return { baseUrl: candidate, kind: "openai", probe: { ok: false, reason: "starting", status: response.status } };
    lastStatus = response.status;
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      continue;
    }
    const body = record(await response.json().catch(() => undefined));
    if (!Array.isArray(body.data)) continue;
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    const kind = (await identify(serverRoot(candidate), connection, transport, body.data.map(record))) ?? "openai";
    const probe = await probeRuntime(kind, connection, transport);
    return { baseUrl: candidate, kind, probe: probe.ok ? { ...probe, latencyMs: probe.latencyMs ?? latencyMs } : probe };
  }
  return { baseUrl: base, kind: "openai", probe: { ok: false, reason: "not-api", ...(lastStatus ? { status: lastStatus } : {}) } };
}
