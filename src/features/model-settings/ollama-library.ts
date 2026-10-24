/**
 * Ollama library tags such as qwen3.5:4b-mlx. They are recognized locally, described by the
 * public Ollama registry before download, and pulled by the connected Ollama itself.
 * Hugging Face never sees these queries.
 */
import {
  body,
  bytes,
  cancelled,
  fail,
  hasControl,
  json,
  managementURL,
  parseJSON,
  pullOllamaModel,
  record,
  request,
  runtimeHeaders,
} from "./huggingface";
import { connectionTransport } from "../../harness/runtime";
import type { HFProgress, OllamaHost, OllamaLibraryModel, OllamaPullInput, RuntimeTarget } from "./types";

const REGISTRY = "https://registry.ollama.ai/v2";
const MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const PROJECTOR = "application/vnd.ollama.image.projector";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_LAYERS = 20_000;
const NAMESPACE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TAG = /^[a-z0-9_][a-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const MLX = /(?:^|[-_.])(?:mlx|nvfp4|mxfp4|mxfp8)(?=$|[-_.])/i;
// Ollama's MLX announcement: preview from 0.19 (more than 32 GB of unified memory recommended); default on Apple silicon from 0.40.
export const MLX_PREVIEW = "0.19.0";
export const MLX_DEFAULT = "0.40.0";

export interface OllamaReference {
  namespace: string;
  name: string;
  tag: string;
}

/**
 * name:tag, owner/name:tag, an ollama.com model URL, or a pasted `ollama pull|run` command.
 * A bare word or owner/repo stays a Hugging Face search: only these forms are unambiguous.
 */
export function parseOllamaReference(input: string): OllamaReference | undefined {
  let value = input.trim();
  if (!value || value.length > 240 || hasControl(value)) return;
  let explicit = false;
  const command = value.match(/^ollama\s+(?:pull|run)\s+(\S+)$/i);
  if (command) {
    value = command[1];
    explicit = true;
  }
  const page = value.match(/^(?:https?:\/\/)?(?:www\.)?ollama\.com\/([^?#\s]+)$/i);
  if (page) {
    value = page[1].replace(/\/+$/, "").replace(/\/tags$/i, "");
    explicit = true;
  }
  if (/\s|:\/\//.test(value)) return;
  value = value.toLowerCase().replace(/^registry\.ollama\.ai\//, "");
  const colon = value.lastIndexOf(":");
  if (colon < 0 && !explicit) return;
  const path = colon < 0 ? value : value.slice(0, colon);
  const tag = colon < 0 ? "latest" : value.slice(colon + 1);
  const parts = path.split("/");
  if (parts.length > 2) return;
  const [namespace, name] = parts.length === 2 ? parts : ["library", parts[0]];
  if (!NAMESPACE.test(namespace) || !NAME.test(name) || name.includes("..") || !TAG.test(tag)) return;
  return { namespace, name, tag };
}

/** The ID Ollama pulls and lists: library models drop their namespace. */
export const ollamaModelId = ({ namespace, name, tag }: OllamaReference) =>
  `${namespace === "library" ? "" : `${namespace}/`}${name}:${tag}`;

export const ollamaPage = ({ namespace, name }: OllamaReference) => `https://ollama.com/${namespace}/${name}`;

const normalized = (id: string) => {
  const key = id.toLowerCase().replace(/^registry\.ollama\.ai\//, "").replace(/^library\//, "");
  return key.slice(key.lastIndexOf("/") + 1).includes(":") ? key : `${key}:latest`;
};
export const sameOllamaModel = (a: string, b: string) => normalized(a) === normalized(b);

/**
 * Other installed builds that look like the same model, such as a GGUF of qwen3.5 4b next to
 * qwen3.5:4b-mlx. Name-based only, so the UI presents them as "also installed", never as identical.
 */
export function relatedBuilds(model: Pick<OllamaLibraryModel, "id" | "name" | "tag">, installed: string[]) {
  const size = model.tag.match(/(?:^|[-_.])(\d+(?:\.\d+)?[bm])(?=$|[-_.])/i)?.[1]?.toLowerCase();
  const name = model.name.toLowerCase();
  return installed.filter((id) => {
    if (sameOllamaModel(id, model.id)) return false;
    const base = (id.toLowerCase().replace(/^hf\.co\//, "").split("/").at(-1) ?? "").trim();
    const rest = base.slice(name.length);
    if (!base.startsWith(name) || !/^(?:$|[-_.:])/.test(rest)) return false;
    // The size must follow the name directly, so qwen3.5-coder:4b is not taken for qwen3.5 4b.
    return size ? rest.split(/[-_.:]+/).filter(Boolean)[0] === size : rest === "" || rest.startsWith(":");
  });
}

/** For an MLX tag, the same tag without its MLX suffix, which Ollama libraries usually publish as GGUF. */
export function ggufAlternative(model: Pick<OllamaLibraryModel, "namespace" | "name" | "tag">) {
  const tag = model.tag.replace(/[-_.](?:mlx|nvfp4|mxfp4|mxfp8)(?=$|[-_.]).*$/i, "");
  if (tag === model.tag) return;
  return ollamaModelId({ ...model, tag: tag || "latest" });
}

export const ollamaDisplayName = (model: Pick<OllamaLibraryModel, "name" | "tag">) =>
  `${model.name.charAt(0).toUpperCase()}${model.name.slice(1)} ${model.tag === "latest" ? "" : model.tag.toUpperCase().replace(/[-_]+/g, " ")}`.trim();

function release(value?: string) {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
/** Undefined when either version is not a release number. */
export function olderThan(value: string | undefined, minimum: string): boolean | undefined {
  const current = release(value);
  const required = release(minimum);
  if (!current || !required) return;
  for (let index = 0; index < 3; index++)
    if (current[index] !== required[index]) return current[index] < required[index];
  return false;
}

export interface OllamaPreflight {
  /** Why the download cannot work here. */
  blocked?: string;
  notes: string[];
  /** A tag to look up instead when this one cannot run here. */
  alternative?: string;
}

/** Checks that hold before a download. Unknown facts become notes, never claims or blocks. */
export function ollamaPreflight(model: OllamaLibraryModel): OllamaPreflight {
  const notes: string[] = [];
  const version = model.serverVersion;
  if (model.missing) return { blocked: "Not in the Ollama library", notes };
  if (model.requires) {
    const outdated = olderThan(version, model.requires);
    if (outdated)
      return { blocked: `Needs Ollama ${model.requires} or later`, notes: [`Connected Ollama is ${version}. Update Ollama, then check again.`] };
    if (outdated === undefined) notes.push(`Needs Ollama ${model.requires} or later.`);
  }
  if (!model.mlx) return { notes };
  // Applies even when the registry config, and so its own requirement, could not be read.
  const preview = olderThan(version, MLX_PREVIEW);
  if (preview)
    return { blocked: `Needs Ollama ${MLX_PREVIEW} or later`, notes: [`MLX builds need Ollama ${MLX_PREVIEW} or later. Connected Ollama is ${version}.`] };
  if (preview === undefined && !model.requires) notes.push(`MLX builds need Ollama ${MLX_PREVIEW} or later.`);
  const host = model.host;
  if (host?.local && host.platform === "darwin" && !host.appleSilicon)
    return {
      blocked: "MLX needs an Apple silicon Mac",
      notes: ["This Mac has an Intel processor, so Ollama cannot run MLX builds on it."],
      alternative: ggufAlternative(model),
    };
  if (host?.local && host.platform !== "darwin") notes.push("Ollama documents MLX for Apple silicon Macs.");
  if (host && !host.local) notes.push("Ollama runs on another machine, so Endurance can't check it for Apple silicon.");
  if (olderThan(version, MLX_DEFAULT) && preview === false) {
    const memory = host?.local && host.memory ? ` This Mac has ${Math.round(host.memory / 1024 ** 3)} GB.` : "";
    notes.push(`MLX is a preview in Ollama ${version}. Ollama recommends more than 32 GB of unified memory.${memory}`);
  }
  return { notes };
}

async function ollamaVersion(target: RuntimeTarget, signal: AbortSignal, transport: typeof fetch) {
  transport = connectionTransport(target.connection, transport);
  const data = record(
    await json(
      await request(`${managementURL(target)}/api/version`, { headers: runtimeHeaders(target.connection), signal }, transport),
      signal,
    ),
  );
  return typeof data.version === "string" && /^\d+\.\d+\.\d+[\w.+-]{0,40}$/.test(data.version) ? data.version : undefined;
}

/** The config blob redirects to storage on another host, so it is accepted only over HTTPS and when it matches its digest. */
async function config(base: string, digest: string, signal: AbortSignal, transport: typeof fetch) {
  let response: Response;
  try {
    response = await transport(`${base}/blobs/${digest}`, { redirect: "manual", credentials: "omit", signal });
  } catch {
    cancelled(signal);
    return fail("Could not reach the Ollama registry.");
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    let next: URL;
    try {
      next = new URL(response.headers.get("location") ?? "", `${base}/`);
    } catch {
      return fail("Ollama registry returned an invalid redirect.");
    }
    if (next.protocol !== "https:" || next.username || next.password) fail("Ollama registry redirected to an unsupported address.");
    response = await request(next, { signal }, transport);
  } else if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    fail(`Ollama registry request failed (HTTP ${response.status}).`);
  }
  const data = await body(response, signal, MAX_CONFIG_BYTES);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
  if (`sha256:${Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")}` !== digest)
    fail("Ollama registry config does not match its digest.");
  return record(parseJSON(data));
}

/**
 * Describes a library tag from the public registry without downloading weights. With a bound Ollama target,
 * it also asks that Ollama for its version so the requirement can be checked against the real server.
 */
export async function lookupOllama(
  query: string,
  signal: AbortSignal,
  options: { target?: RuntimeTarget; host?: OllamaHost } = {},
  transport: typeof fetch = fetch,
): Promise<OllamaLibraryModel> {
  const reference = parseOllamaReference(query) ?? fail("Enter an Ollama model tag, such as name:tag.");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  const base = `${REGISTRY}/${reference.namespace}/${reference.name}`;
  const version =
    options.target?.runtime === "ollama"
      ? ollamaVersion(options.target, bounded, transport).catch(() => {
          cancelled(bounded);
          return undefined;
        })
      : Promise.resolve(undefined);
  const result: OllamaLibraryModel = {
    ...reference,
    id: ollamaModelId(reference),
    capabilities: [],
    mlx: MLX.test(reference.tag),
    ...(options.host ? { host: options.host } : {}),
  };
  let response: Response;
  try {
    response = await transport(`${base}/manifests/${reference.tag}`, {
      headers: { Accept: MANIFEST },
      redirect: "error",
      credentials: "omit",
      signal: bounded,
    });
  } catch {
    cancelled(bounded);
    return fail("Could not reach the Ollama registry.");
  }
  if (response.status === 404) {
    void response.body?.cancel().catch(() => undefined);
    const reported = await version;
    return { ...result, missing: true, ...(reported ? { serverVersion: reported } : {}) };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    fail(`Ollama registry request failed (HTTP ${response.status}).`);
  }
  const manifest = record(await json(response, bounded));
  const layers = Array.isArray(manifest.layers) ? manifest.layers.map(record) : fail("Ollama registry returned an invalid manifest.");
  if (layers.length > MAX_LAYERS) fail("Ollama registry manifest has too many layers.");
  let total = 0;
  let known = true;
  for (const layer of layers) {
    const size = bytes(layer.size);
    if (size === undefined) known = false;
    else total += size;
  }
  const blob = record(manifest.config);
  let described: Record<string, unknown> = {};
  if (typeof blob.digest === "string" && DIGEST.test(blob.digest) && (bytes(blob.size) ?? 0) <= MAX_CONFIG_BYTES) {
    try {
      described = await config(base, blob.digest, bounded, transport);
    } catch {
      // The manifest alone still names the tag and its size; requirements stay unknown rather than guessed.
      cancelled(bounded);
    }
  }
  const text = (value: unknown, pattern: RegExp) => (typeof value === "string" && pattern.test(value) ? value : undefined);
  const format = text(described.model_format, /^[a-z0-9_-]{1,32}$/i);
  const quantization = text(described.file_type, /^[\w.-]{1,32}$/);
  const requires = text(described.requires, RELEASE);
  const capabilities = (Array.isArray(described.capabilities) ? described.capabilities : [])
    .filter((value): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value))
    .slice(0, 16);
  // GGUF configs omit capabilities; a projector layer is the vision encoder.
  if (!capabilities.includes("vision") && layers.some((layer) => layer.mediaType === PROJECTOR)) capabilities.push("vision");
  const reported = await version;
  return {
    ...result,
    capabilities,
    mlx: result.mlx || (format === "safetensors" && MLX.test(quantization ?? "")),
    ...(known ? { bytes: total } : {}),
    ...(format ? { format } : {}),
    ...(quantization ? { quantization } : {}),
    ...(requires ? { requires } : {}),
    ...(reported ? { serverVersion: reported } : {}),
  };
}

/** Pulls a library tag into the connected Ollama. The main-process caller binds input.connection first. */
export async function pullOllama(
  input: OllamaPullInput,
  progress: (p: HFProgress) => void,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<void> {
  cancelled(signal);
  if (input.runtime !== "ollama") fail("Ollama library models install only in Ollama.");
  const reference = typeof input.model === "string" ? parseOllamaReference(input.model) : undefined;
  if (!reference) fail("Invalid Ollama model tag.");
  transport = connectionTransport(input.connection, transport);
  return pullOllamaModel(
    managementURL(input),
    runtimeHeaders(input.connection),
    input.connection.apiKey,
    ollamaModelId(reference),
    progress,
    signal,
    transport,
  );
}
