/**
 * What a vLLM server says about its load and memory, for the Connections page. `/metrics` is public on every
 * vLLM server: requests running and waiting, KV cache use, and the cache's configuration as the labels of
 * `vllm:cache_config_info`. A server the person runs may also answer `/server_info`, which vLLM serves only with
 * VLLM_SERVER_DEV_MODE=1 and which carries its whole configuration; it is never asked of an external server.
 * Nothing here is used to decide requests; it is shown.
 */
import { headers, runtimeUrl, serverRoot, endpoint } from "./runtime";
import type { RuntimeConnection } from "../lib/models";

export interface ServerInfo {
  running?: number;
  waiting?: number;
  /** Share of the KV cache in use, 0 to 1. */
  kvUsage?: number;
  /** Tokens the KV cache holds across all requests: GPU blocks × block size. */
  kvTokens?: number;
  blockSize?: number;
  prefixCaching?: boolean;
  cacheDtype?: string;
  memoryUtilization?: number;
  /** From /server_info, on a server the person runs with development endpoints on. */
  maxNumSeqs?: number;
  maxNumBatchedTokens?: number;
  maxModelLen?: number;
  /** Whether /server_info answered; undefined when it was not asked. */
  development?: boolean;
}

const number = (value: unknown) => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** One Prometheus sample line: name, labels, value. Comments and malformed lines are skipped. */
function samples(text: string) {
  const result: { name: string; labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split("\n")) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line.trim());
    if (!match || line.startsWith("#")) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]] = pair[2];
    const value = Number(match[3]);
    if (Number.isFinite(value)) result.push({ name: match[1], labels, value });
  }
  return result;
}

/** Reads the figures from a /metrics page; engines of a data-parallel server are added up. */
/**
 * The server's load and cache from /metrics. With `model`, only that model's lines count: behind the Endurance
 * manager one /metrics holds every model's, each labeled with its model_name.
 */
export function parseMetrics(text: string, model?: string): ServerInfo {
  const all = samples(text).filter((item) => !model || item.labels.model_name === undefined || item.labels.model_name === model);
  const sum = (name: string) => {
    const found = all.filter((item) => item.name === name);
    return found.length ? found.reduce((total, item) => total + item.value, 0) : undefined;
  };
  const usage = all.filter((item) => item.name === "vllm:kv_cache_usage_perc" || item.name === "vllm:gpu_cache_usage_perc");
  const cache = all.filter((item) => item.name === "vllm:cache_config_info").map((item) => item.labels);
  const blockSize = number(cache[0]?.block_size);
  const blocks = cache.reduce<number | undefined>((total, labels) => (number(labels.num_gpu_blocks) === undefined ? total : (total ?? 0) + number(labels.num_gpu_blocks)!), undefined);
  const prefix = cache[0]?.enable_prefix_caching;
  return {
    running: sum("vllm:num_requests_running"),
    waiting: sum("vllm:num_requests_waiting"),
    kvUsage: usage.length ? Math.max(...usage.map((item) => item.value)) : undefined,
    kvTokens: blockSize && blocks ? blockSize * blocks : undefined,
    blockSize,
    prefixCaching: prefix === undefined ? undefined : /^true$/i.test(prefix),
    cacheDtype: cache[0]?.cache_dtype || undefined,
    memoryUtilization: number(cache[0]?.gpu_memory_utilization),
  };
}

/** Reads the scheduler and model limits from /server_info?config_format=json. */
export function parseServerInfo(value: unknown): Pick<ServerInfo, "maxNumSeqs" | "maxNumBatchedTokens" | "maxModelLen"> {
  const config = record(record(value).vllm_config);
  const scheduler = record(config.scheduler_config);
  return {
    maxNumSeqs: number(scheduler.max_num_seqs),
    maxNumBatchedTokens: number(scheduler.max_num_batched_tokens),
    maxModelLen: number(record(config.model_config).max_model_len) ?? number(scheduler.max_model_len),
  };
}

export async function vllmServerInfo(connection: RuntimeConnection, mine: boolean, transport: typeof fetch = fetch): Promise<ServerInfo> {
  const root = serverRoot(endpoint(connection));
  const get = (route: string) =>
    transport(runtimeUrl(connection, `${root}${route}`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  const [metrics, info] = await Promise.all([get("/metrics"), mine ? get("/server_info?config_format=json") : undefined]);
  const parsed = metrics?.ok ? parseMetrics(await metrics.text()) : {};
  if (!mine) return parsed;
  const development = Boolean(info?.ok);
  const config = development ? parseServerInfo(await info!.json().catch(() => ({}))) : {};
  if (!development) void info?.body?.cancel().catch(() => undefined);
  return { ...parsed, ...config, development };
}
