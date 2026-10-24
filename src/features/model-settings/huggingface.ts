/**
 * Portions derived from opencode (MIT, Copyright (c) 2025 opencode; notice: ../../harness/vendor/LICENSE).
 * Explicit public Hub search only. Published file sizes are not runtime-fit estimates.
 */
import type { RuntimeConnection } from "../../lib/models";
import { connectionTransport } from "../../harness/runtime";
import type { HFDownloadInput, HFFile, HFModel, HFProgress, Modality } from "./types";

const REPOSITORY =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_FILES = 20_000;
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const bytes = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
export function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
const validRepository = (value: string) =>
  REPOSITORY.test(value) &&
  !value.split("/").some((part) => part.includes(".."));
const validFilename = (value: string) =>
  value.length <= 512 &&
  !hasControl(value) &&
  !/[\\?#:%]/.test(value) &&
  value
    .split("/")
    .every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..");

export function fail(message: string): never {
  throw new Error(message);
}
export function cancelled(signal: AbortSignal) {
  if (signal.aborted)
    throw new DOMException("Model operation cancelled", "AbortError");
}

async function read(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  try {
    return await reader.read();
  } catch {
    cancelled(signal);
    return fail("Model service response stream was interrupted.");
  }
}

export async function request(
  url: string | URL,
  init: RequestInit,
  transport: typeof fetch,
): Promise<Response> {
  const signal = init.signal as AbortSignal;
  cancelled(signal);
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      redirect: "error",
      credentials: "omit",
    });
  } catch {
    cancelled(signal);
    return fail("Could not reach the model service.");
  }
  cancelled(signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403)
      fail("Model service requires access approval or authentication.");
    if ([404, 405, 501].includes(response.status))
      fail(
        "Model service endpoint or repository is unavailable or unsupported.",
      );
    fail(`Model service request failed (HTTP ${response.status}).`);
  }
  return response;
}

// Read with a byte limit rather than trusting Content-Length or allocating response.json() without bounds.
export async function body(
  response: Response,
  signal: AbortSignal,
  limit = MAX_JSON_BYTES,
): Promise<Uint8Array> {
  if (!response.body) fail("Model service returned an empty response.");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      cancelled(signal);
      const chunk = await read(reader, signal);
      cancelled(signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) fail("Model service response is too large.");
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export function parseJSON(data: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return fail("Model service returned invalid JSON.");
  }
}

export async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  return parseJSON(await body(response, signal));
}

function parseModel(value: unknown): HFModel | undefined {
  const model = record(value);
  if (
    typeof model.id !== "string" ||
    !validRepository(model.id) ||
    model.private === true
  )
    return;
  const siblings = Array.isArray(model.siblings) ? model.siblings : [];
  if (siblings.length > MAX_FILES)
    fail("Repository has too many files to inspect safely.");
  const files: HFFile[] = [];
  const seen = new Set<string>();
  for (const value of siblings) {
    const file = record(value);
    if (
      typeof file.rfilename !== "string" ||
      !validFilename(file.rfilename) ||
      !/\.gguf$/i.test(file.rfilename) ||
      // Importance-matrix data used for quantizing, not a model.
      /imatrix/i.test(file.rfilename)
    )
      continue;
    const name = file.rfilename;
    if (seen.has(name)) continue;
    seen.add(name);
    // Retain the real filename: collapsed shard names are not selectable Ollama downloads.
    const quantization = name
      .match(/(?:^|[._/-])((?:IQ|Q|TQ)\d[\w]*|BF16|F16|F32)(?=[._/-]|$)/i)?.[1]
      ?.toUpperCase();
    const size = bytes(file.size) ?? bytes(record(file.lfs).size);
    files.push({
      name,
      ...(size !== undefined ? { bytes: size } : {}),
      ...(quantization ? { quantization } : {}),
      ...(/-\d{5}-of-\d{5}\.gguf$/i.test(name) ? { shard: true } : {}),
      ...(/mmproj|projector/i.test(name) ? { projector: true } : {}),
    });
  }
  return {
    id: model.id,
    files,
    ...(typeof model.pipeline_tag === "string" && /^[a-z0-9-]{1,64}$/.test(model.pipeline_tag)
      ? { pipeline: model.pipeline_tag }
      : {}),
    ...(bytes(model.downloads) !== undefined
      ? { downloads: bytes(model.downloads) }
      : {}),
    ...(model.gated !== undefined ? { gated: model.gated !== false } : {}),
  };
}

function searchTerm(query: string): { term: string; repository?: string } {
  let repository: string | undefined;
  if (/^(?:https?:\/\/|(?:www\.)?(?:huggingface\.co|hf\.co)\/)/i.test(query)) {
    let url: URL;
    try {
      url = new URL(query.includes("://") ? query : `https://${query}`);
    } catch {
      return fail("Enter a public Hugging Face repository or search term.");
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !["huggingface.co", "hf.co", "www.huggingface.co"].includes(
        url.hostname,
      ) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(
        "Enter a public Hugging Face repository URL without credentials or query parameters.",
      );
    repository = url.pathname.split("/").slice(1, 3).join("/");
    if (!validRepository(repository)) fail("Invalid Hugging Face repository.");
    query = repository;
  }
  // Conversions often have different owners: keep the original name-based search behavior.
  const name = query.includes("/")
    ? query.slice(query.lastIndexOf("/") + 1)
    : query;
  const term = name.replace(/[-_. ]?gguf$/i, "");
  return { term: term.length >= 2 ? term : query, repository };
}

/**
 * Image input needs a vision projector next to the weights. The projector decides it: GGUF conversions often
 * inherit a text-generation pipeline tag from the base repository even when they ship one.
 */
export function modalities(model: HFModel): Modality[] {
  const vision = model.files.some((file) => file.projector);
  return vision ? ["text", "image"] : ["text"];
}

/** Files a runtime can install on their own. Shards and projectors are excluded. */
export function installable(model: HFModel) {
  return model.files.filter((file) => /\.gguf$/i.test(file.name) && !file.projector && !file.shard);
}

/** The projector Ollama adds to a vision download, so the shown size matches the transfer. */
export function projectorBytes(model: HFModel) {
  const projectors = model.files.filter((file) => file.projector && file.bytes !== undefined);
  const preferred = projectors.find((file) => file.quantization === "F16") ?? projectors[0];
  return preferred?.bytes ?? 0;
}

/** No request happens until this explicit search is called. No runtime credentials are sent to the Hub. */
export async function searchHuggingFace(
  query: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<HFModel[]> {
  query = query.trim();
  if (query.length < 2 || query.length > 120 || hasControl(query))
    fail("Search terms must contain 2–120 printable characters.");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  const { term, repository } = searchTerm(query);
  const url = new URL("https://huggingface.co/api/models");
  url.search = new URLSearchParams({
    search: term,
    limit: "12",
    // Every supported download target installs GGUF files.
    filter: "gguf",
    sort: "downloads",
    direction: "-1",
    full: "true",
    config: "true",
  }).toString();
  const listed = await json(
    await request(url, { signal: bounded }, transport),
    bounded,
  );
  if (!Array.isArray(listed)) fail("Model search returned an invalid listing.");
  const candidates = listed
    .slice(0, 12)
    .map(record)
    .filter(
      (item) =>
        typeof item.id === "string" &&
        validRepository(item.id) &&
        item.private !== true,
    );
  // A pasted repository is shown first even when it has no GGUF, so it can say why it cannot be installed.
  if (repository && candidates.length >= 12 && !candidates.some((item) => item.id === repository))
    candidates.pop();
  if (repository && !candidates.some((item) => item.id === repository))
    candidates.unshift({ id: repository });
  const results: HFModel[] = [];
  // Bounded, sequential detail lookups avoid an unbounded fan-out on a large or untrusted listing.
  for (const item of candidates) {
    cancelled(bounded);
    let merged = item;
    try {
      const detail = record(
        await json(
          await request(
            `https://huggingface.co/api/models/${item.id}?blobs=true`,
            { signal: bounded },
            transport,
          ),
          bounded,
        ),
      );
      if (detail.id !== undefined && detail.id !== item.id)
        fail("Repository detail does not match the search result.");
      merged = { ...item, ...detail };
    } catch {
      cancelled(bounded);
      // Listing metadata remains useful for a gated repository; never imply detail files were inspected.
      merged = { ...item, siblings: [] };
    }
    const model = parseModel(merged);
    if (model) results.push(repository === model.id ? { ...model, requested: true } : model);
  }
  cancelled(bounded);
  return results;
}

export function managementURL(input: { connection: RuntimeConnection }): string {
  let url: URL;
  try {
    url = new URL(input.connection.baseUrl);
  } catch {
    return fail("Invalid connected runtime URL.");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("Invalid connected runtime URL.");
  // Preserve reverse proxy prefixes, removing only a known inference API suffix.
  return url.href.replace(/\/+$/, "").replace(/\/(?:api\/)?v1$/, "");
}

export function runtimeHeaders(connection: RuntimeConnection): Record<string, string> {
  if (/[\r\n]/.test(connection.apiKey)) fail("Invalid runtime credentials.");
  return {
    ...(connection.headers ?? {}),
    "Content-Type": "application/json",
    ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
  };
}

async function pause(signal: AbortSignal) {
  cancelled(signal);
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 750);
    signal.addEventListener("abort", done, { once: true });
  });
  cancelled(signal);
}

/** Port of native.downloadLlama: subscribe before admission, correlate model, then verify inventory. */
async function downloadLlama(
  base: string,
  headers: Record<string, string>,
  model: string,
  progress: (p: HFProgress) => void,
  signal: AbortSignal,
  transport: typeof fetch,
): Promise<void> {
  const subscription = new AbortController();
  const subscribedSignal = AbortSignal.any([signal, subscription.signal]);
  const response = await request(
    `${base}/models/sse`,
    { headers, signal: subscribedSignal },
    transport,
  );
  if (!response.body) fail("llama.cpp returned an empty model event stream.");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  let admissionAttempted = false;
  let operationError: unknown;
  let cancellationFailed = false;
  const decoder = new TextDecoder();
  let pending = "";
  const line = async (text: string): Promise<boolean> => {
    if (text.length > MAX_LINE) fail("llama.cpp event line is too large.");
    if (!text.startsWith("data:")) return false;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text.slice(5).trim());
    } catch {
      return fail("llama.cpp returned invalid model event JSON.");
    }
    const event = record(decoded);
    // The router publishes every model on one SSE stream: unrelated jobs cannot complete this one.
    if (event.model !== model) return false;
    if (event.event === "download_failed")
      fail("llama.cpp could not download the selected model.");
    if (event.event === "download_finished") {
      const inventory = record(
        await json(
          await request(`${base}/models`, { headers, signal }, transport),
          signal,
        ),
      );
      if (
        !Array.isArray(inventory.data) ||
        !inventory.data.some((item) => record(item).id === model)
      )
        fail(
          "llama.cpp reported completion but the selected model is absent from its inventory.",
        );
      cancelled(signal);
      progress({ status: "completed", done: true });
      return true;
    }
    if (event.event !== "download_progress") return false;
    const parts = Object.values(record(event.data));
    if (parts.length > 1024)
      fail("llama.cpp returned too many download parts.");
    let completed = 0;
    let total = 0;
    for (const part of parts) {
      const item = record(part);
      const size = bytes(item.total) ?? 0;
      total += size;
      completed += Math.min(bytes(item.done) ?? 0, size);
    }
    progress({ status: "downloading", completed, total });
    return false;
  };
  try {
    admissionAttempted = true;
    const admitted = record(
      await json(
        await request(
          `${base}/models`,
          {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({ model }),
          },
          transport,
        ),
        signal,
      ),
    );
    if (admitted.success !== true)
      fail("llama.cpp did not accept the selected model download.");
    while (true) {
      cancelled(signal);
      const chunk = await read(reader, signal);
      cancelled(signal);
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const finished = await line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (finished) return;
      }
      if (pending.length > MAX_LINE) fail("llama.cpp event line is too large.");
      if (chunk.done) {
        if (pending && (await line(pending))) return;
        fail(
          "llama.cpp event stream ended before confirming download success.",
        );
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    signal.removeEventListener("abort", abort);
    subscription.abort();
    void reader.cancel().catch(() => undefined);
    // Native router unload also cancels an in-progress download. Use a fresh bounded signal for cleanup.
    if (signal.aborted && admissionAttempted) {
      try {
        const cleanup = await request(
          `${base}/models/unload`,
          {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({ model }),
          },
          transport,
        );
        void cleanup.body?.cancel().catch(() => undefined);
      } catch {
        cancellationFailed = true;
      }
    }
  }
  if (cancellationFailed)
    throw new DOMException(
      "Download tracking cancelled. llama.cpp cancellation failed, so its remote download may continue.",
      "AbortError",
    );
  throw operationError;
}

/**
 * Downloads into the connected runtime. The main-process caller must bind input.connection
 * to its saved runtime connection before calling; repository/file inputs never become arbitrary URLs.
 */
export async function downloadHuggingFace(
  input: HFDownloadInput,
  progress: (p: HFProgress) => void,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<void> {
  cancelled(signal);
  if (!validRepository(input.repository) || !validFilename(input.filename))
    fail("Invalid Hugging Face repository or filename.");
  if (input.runtime === "vllm")
    fail(
      "vLLM does not expose a supported model download API. Download and configure the model on its server.",
    );
  if (
    input.runtime !== "ollama" &&
    input.runtime !== "lmstudio" &&
    input.runtime !== "llamacpp"
  )
    fail("Unsupported model runtime.");
  const base = managementURL(input);
  if (/[\r\n]/.test(input.connection.apiKey))
    fail("Invalid runtime credentials.");
  // Hub requests pass through untouched; requests to the runtime carry its signed query, if any.
  transport = connectionTransport(input.connection, transport);
  const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  const metadata = await json(
    await request(
      `https://huggingface.co/api/models/${input.repository}?blobs=true`,
      { signal: metadataSignal },
      transport,
    ),
    metadataSignal,
  );
  const model = parseModel(metadata);
  if (!model || model.id !== input.repository)
    fail("Repository detail does not match the selected repository.");
  if (model.gated !== false)
    fail(
      "Only explicitly public, ungated repositories can be downloaded here.",
    );
  const file = model.files.find(
    (candidate) => candidate.name === input.filename,
  );
  if (!file)
    fail("The selected GGUF file is no longer listed by the repository.");
  if (file.shard || file.projector)
    fail(
      "Split GGUF shards and projector files cannot be downloaded as standalone models.",
    );
  const headers = runtimeHeaders(input.connection);
  if (input.runtime === "llamacpp") {
    if (
      !file.quantization ||
      model.files.filter(
        (candidate) =>
          !candidate.projector && candidate.quantization === file.quantization,
      ).length !== 1
    )
      fail("llama.cpp cannot select this exact file by a unique quantization.");
    return downloadLlama(
      base,
      headers,
      `${input.repository}:${file.quantization}`,
      progress,
      signal,
      transport,
    );
  }
  if (input.runtime === "lmstudio") {
    if (
      !file.quantization ||
      model.files.filter(
        (candidate) =>
          !candidate.projector && candidate.quantization === file.quantization,
      ).length !== 1
    )
      fail("LM Studio cannot select this exact file by a unique quantization.");
    try {
      const admitted = record(
        await json(
          await request(
            `${base}/api/v1/models/download`,
            {
              method: "POST",
              headers,
              signal,
              body: JSON.stringify({
                model: `https://huggingface.co/${input.repository}`,
                quantization: file.quantization,
              }),
            },
            transport,
          ),
          signal,
        ),
      );
      if (
        admitted.status === "already_downloaded" ||
        admitted.status === "completed"
      ) {
        progress({ status: "completed", done: true });
        return;
      }
      if (
        typeof admitted.job_id !== "string" ||
        !admitted.job_id ||
        admitted.job_id.length > 256
      )
        fail("LM Studio returned an invalid download job.");
      // The native API has no cancellation endpoint: abort stops tracking; its remote download may continue.
      while (true) {
        const status = record(
          await json(
            await request(
              `${base}/api/v1/models/download/status/${encodeURIComponent(admitted.job_id)}`,
              { headers, signal },
              transport,
            ),
            signal,
          ),
        );
        if (status.status === "completed") {
          progress({ status: "completed", done: true });
          return;
        }
        if (status.status !== "downloading" && status.status !== "paused")
          fail("LM Studio download failed or returned an unknown status.");
        progress({
          status: status.status,
          completed: bytes(status.downloaded_bytes),
          total: bytes(status.total_size_bytes),
        });
        await pause(signal);
      }
    } catch (error) {
      if (signal.aborted)
        throw new DOMException(
          "Download tracking cancelled. LM Studio may continue its download because its API has no cancellation endpoint.",
          "AbortError",
        );
      throw error;
    }
  }
  if (!/^[\w.-]+\.gguf$/i.test(file.name))
    fail("Ollama supports a single GGUF filename at the repository root.");
  // A unique quantization is the shorter tag Ollama lists afterwards; both select the same file.
  const tag =
    file.quantization &&
    model.files.filter(
      (candidate) =>
        !candidate.projector && candidate.quantization === file.quantization,
    ).length === 1
      ? file.quantization
      : file.name;
  const pull = (reference: string) =>
    pullOllamaModel(base, headers, input.connection.apiKey, `hf.co/${input.repository}:${reference}`, progress, signal, transport);
  if (tag === file.name) return pull(file.name);
  try {
    return await pull(tag);
  } catch (error) {
    // The Hub resolves a quantization tag only for some filename layouts (not gemma-4-E4B_q4_0-it.gguf);
    // it rejects the manifest before any bytes move, and the exact filename always selects the file.
    if (signal.aborted || !(error instanceof Error) || !/tag is not available/i.test(error.message)) throw error;
    return pull(file.name);
  }
}

/** Streams Ollama's /api/pull for one model reference and resolves only once Ollama confirms success. */
export async function pullOllamaModel(
  base: string,
  headers: Record<string, string>,
  apiKey: string,
  installed: string,
  progress: (p: HFProgress) => void,
  signal: AbortSignal,
  transport: typeof fetch,
): Promise<void> {
  const response = await request(
    `${base}/api/pull`,
    {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({ model: installed, stream: true }),
    },
    transport,
  );
  if (!response.body) fail("Ollama returned an empty progress stream.");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  const layers = new Map<string, { completed: number; total: number }>();
  let pending = "";
  let success = false;
  const line = (text: string) => {
    if (!text.trim()) return;
    if (text.length > MAX_LINE) fail("Ollama progress line is too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("Ollama returned invalid progress JSON.");
    }
    const data = record(parsed);
    // A server may echo authorization credentials: show Ollama's reason only with secrets removed.
    if (data.error !== undefined) {
      // Registry errors arrive as embedded JSON; show their message rather than escaped quotes.
      const raw = typeof data.error === "string" ? data.error : "";
      const embedded = raw.match(/\{\s*"error"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/);
      let message = raw;
      if (embedded) {
        try {
          message = raw.replace(embedded[0], String(JSON.parse(embedded[1])));
        } catch {
          message = raw;
        }
      }
      const reason =
        message
          ? message
              .split(apiKey || "\u0000")
              .join("[redacted]")
              .replace(/bearer\s+\S+/gi, "[redacted]")
              .replace(/[^\x20-\x7e]/g, "")
              .slice(0, 160)
          : "";
      fail(`Ollama could not download the selected model${reason ? `: ${reason}` : "."}`);
    }
    if (typeof data.status !== "string")
      fail("Ollama returned invalid download progress.");
    if (data.status === "success") {
      success = true;
      return;
    }
    const key = typeof data.digest === "string" ? data.digest : data.status;
    const total = bytes(data.total);
    if (total && key) {
      // MLX tags ship one layer per tensor, so a pull can track hundreds of layers.
      if (!layers.has(key) && layers.size >= MAX_FILES)
        fail("Ollama returned too many download layers.");
      layers.set(key, {
        total,
        completed: Math.min(bytes(data.completed) ?? 0, total),
      });
    }
    const sizes = [...layers.values()];
    progress({
      status: total ? "downloading" : "preparing",
      completed: sizes.reduce((sum, item) => sum + item.completed, 0),
      total: sizes.reduce((sum, item) => sum + item.total, 0),
    });
  };
  try {
    while (true) {
      cancelled(signal);
      const chunk = await read(reader, signal);
      cancelled(signal);
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > MAX_LINE) fail("Ollama progress line is too large.");
      if (chunk.done) break;
    }
    line(pending);
    cancelled(signal);
    if (!success)
      fail("Ollama stream ended before confirming download success.");
    progress({ status: "completed", done: true, model: installed });
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
  }
}
