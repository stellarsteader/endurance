/** Model details, context settings and deletion on a connected runtime. Portions derived from opencode (MIT; notice: ../../harness/vendor/LICENSE). */
import { checkTimeout, endpoint, headers, runtimeUrl } from "../../harness/runtime";
import { isRuntimeId } from "../../lib/models";
import { Ollama } from "../../harness/vendor/schema/ollama";
import { runtimeProfile, type ModelFacts } from "../../harness/profile/runtimes";
import type { RuntimeModelDetails, RuntimeTarget } from "./types";
import { OLLAMA_DEFAULTS, ollamaSampling, type SamplingField } from "../../lib/sampling";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function management(target: RuntimeTarget) {
  const base = endpoint(target.connection);
  return target.runtime === "ollama"
    ? Ollama.baseURL(base)
    : base.replace(/\/(?:api\/)?v1$/, "");
}
async function request(
  target: RuntimeTarget,
  route: string,
  body?: unknown,
  transport: typeof fetch = fetch,
) {
  if (!isRuntimeId(target.runtime))
    throw new Error("Unknown runtime");
  const url = new URL(runtimeUrl(target.connection, management(target) + route));
  const response = await transport(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...headers(target.connection),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(checkTimeout(target.connection, 0), body === undefined ? 10000 : 120000)),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Authentication required"
        : `Runtime returned HTTP ${response.status}`,
    );
  const data = record(await response.json());
  if (data.error)
    throw new Error("The runtime could not complete the model operation.");
  return data;
}
/**
 * One details read can ask the same route twice: once for what the model is (runtimeProfile().inspect) and once
 * for what can be managed. Identical requests share one response, so the runtime sees each route once.
 */
function shared(transport: typeof fetch): typeof fetch {
  const pending = new Map<string, Promise<Response>>();
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const key = JSON.stringify([init?.method ?? "GET", new URL(url).href, typeof init?.body === "string" ? init.body : null]);
    let response = pending.get(key);
    if (!response) {
      response = transport(input, init);
      pending.set(key, response);
    }
    return response.then((value) => value.clone());
  }) as typeof fetch;
}
const unmanaged = (runtime: RuntimeTarget["runtime"]) => !["ollama", "lmstudio", "llamacpp"].includes(runtime);
/** What Ollama samples the model with when nothing is sent: its Modelfile's values, else Ollama's defaults. */
function ollamaSamplingOf(show: unknown): Pick<RuntimeModelDetails, "sampling"> {
  const parameters = show && typeof show === "object" ? (show as { parameters?: unknown }).parameters : undefined;
  const values = ollamaSampling(typeof parameters === "string" ? parameters : undefined);
  return { sampling: { values: { ...OLLAMA_DEFAULTS, ...values }, own: Object.keys(values) as SamplingField[] } };
}

export async function modelDetails(
  target: RuntimeTarget,
  modelId: string,
  transport: typeof fetch = fetch,
): Promise<RuntimeModelDetails> {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 512)
    throw new Error("Invalid model ID");
  if (!isRuntimeId(target.runtime)) throw new Error("Unknown runtime");
  const result: RuntimeModelDetails = {
    modelId,
    capabilities: [],
    canSetContext: false,
    canDelete: false,
  };
  const once = shared(transport);
  const inspect = () => runtimeProfile(target.runtime).inspect(target, modelId, once);
  // What the model is comes from the runtime profile; this file reads only what management needs.
  const facts = (value: ModelFacts) => ({
    context: value.loaded ?? value.configured,
    loadedContext: value.loaded,
    configured: value.configured,
    // A runtime that serves one fixed window reports no separate maximum; the window it serves is the most it takes.
    maxContext: value.max ?? (unmanaged(target.runtime) ? value.loaded : undefined),
    capabilities: value.capabilities ?? [],
    quantization: value.quantization,
    memory: value.memory,
    weights: value.weights,
    kvPerToken: value.kvPerToken,
    kvUpperBound: value.kvUpperBound,
  });
  if (target.runtime === "ollama") {
    // Management reads first, in the order inspect asks, so they set the timeouts the shared requests use.
    const show = request(target, "/api/show", { model: modelId }, once);
    const ps = request(target, "/api/ps", undefined, once).catch(() => ({}));
    const [shown, loaded, value] = await Promise.all([show, ps, inspect()]);
    const listed = record(loaded).models;
    const active = Array.isArray(listed)
      ? listed
          .map(record)
          .some(
            (item) =>
              typeof item.name === "string" &&
              Ollama.tagKey(item.name) === Ollama.tagKey(modelId),
          )
      : undefined;
    return {
      ...result,
      ...facts(value),
      loaded: active,
      canSetContext: true,
      canDelete: true,
      ...ollamaSamplingOf(shown),
    };
  }
  if (target.runtime === "lmstudio") {
    const [inventory, value] = await Promise.all([
      request(target, "/api/v1/models", undefined, once),
      inspect(),
    ]);
    const model = Array.isArray(inventory.models)
      ? inventory.models
          .map(record)
          .find(
            (item) =>
              item.key === modelId ||
              (Array.isArray(item.loaded_instances) &&
                item.loaded_instances.some(
                  (instance) => record(instance).id === modelId,
                )),
          )
      : undefined;
    if (!model) return result;
    const instances = Array.isArray(model.loaded_instances)
      ? model.loaded_instances.map(record)
      : [];
    const instance =
      instances.find((item) => item.id === modelId) ?? instances[0];
    return {
      ...result,
      ...facts(value),
      modelId: typeof model.key === "string" ? model.key : modelId,
      loaded: instances.length > 0,
      loadId: typeof instance?.id === "string" ? instance.id : undefined,
      canSetContext: true,
    };
  }
  // The model list is the one route every OpenAI-compatible server answers; a failure there is a real failure.
  const base = endpoint(target.connection);
  const listed = once(runtimeUrl(target.connection, `${base}/models`), {
    headers: headers(target.connection),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const [response, value] = await Promise.all([listed, inspect()]);
  void response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`Runtime returned HTTP ${response.status}`);
  return { ...result, ...facts(value) };
}
/**
 * Sets the window a model loads with, where the runtime keeps one: Ollama writes it to the model's Modelfile
 * (the next request reloads a model running at another window, see server/sched.go needsReload); LM Studio keeps
 * none, so a loaded model is loaded again at it. Other runtimes serve a fixed window and refuse.
 */
export async function mutateModel(
  target: RuntimeTarget,
  modelId: string,
  action: "context",
  context: number,
  transport: typeof fetch = fetch,
) {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 512 || action !== "context")
    throw new Error("Invalid model operation");
  if (!Number.isSafeInteger(context) || context < 512 || context > 1048576)
    throw new Error("Context must be a whole number between 512 and 1048576 tokens.");
  if (target.runtime === "ollama") {
    if (!Ollama.validTag(modelId)) throw new Error("Invalid Ollama model tag");
    const result = await request(
      target,
      "/api/create",
      { from: modelId, model: modelId, parameters: { num_ctx: context }, stream: false },
      transport,
    );
    if (result.status !== "success")
      throw new Error("The runtime did not confirm the context setting.");
    return;
  }
  if (target.runtime !== "lmstudio")
    throw new Error("This runtime does not expose this model setting through the connected API.");
  const detail = await modelDetails(target, modelId, transport);
  if (!detail.loaded) return;
  if (!detail.loadId) throw new Error("The runtime did not report a loaded instance ID.");
  const unloaded = await request(target, "/api/v1/models/unload", { instance_id: detail.loadId }, transport);
  if (unloaded.instance_id !== detail.loadId) throw new Error("The runtime did not confirm unload.");
  const loaded = await request(target, "/api/v1/models/load", { model: detail.modelId, context_length: context }, transport);
  if (loaded.status !== "loaded" || typeof loaded.instance_id !== "string")
    throw new Error("The runtime did not confirm load.");
}

/** Removes an Ollama model and its files. Other connected APIs expose no deletion, so they refuse. */
export async function deleteModel(
  target: RuntimeTarget,
  modelId: string,
  transport: typeof fetch = fetch,
) {
  if (target.runtime !== "ollama")
    throw new Error(
      "This runtime does not expose model deletion through the connected API.",
    );
  if (typeof modelId !== "string" || !Ollama.validTag(modelId))
    throw new Error("Invalid Ollama model tag");
  // Release it from memory first; a model that is not loaded simply confirms.
  await request(
    target,
    "/api/generate",
    { model: modelId, keep_alive: 0, stream: false },
    transport,
  ).catch(() => undefined);
  const response = await transport(
    new URL(runtimeUrl(target.connection, management(target) + "/api/delete")),
    {
      method: "DELETE",
      headers: { ...headers(target.connection), "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  void response.body?.cancel().catch(() => undefined);
  if (response.status === 404)
    throw new Error("This model is no longer installed. Refresh the list.");
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Authentication required"
        : `Runtime returned HTTP ${response.status}`,
    );
}
