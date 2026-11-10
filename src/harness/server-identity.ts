/**
 * Which runtime is behind an address, from the server's own answers. A default port only says where to look:
 * unrelated programs use the same ports (8000 is also the default of FastAPI and Django, 5000 of Flask and
 * AirPlay), so a server is named only when an endpoint that runtime alone serves confirms it (identify()).
 * Anything else that answers like the OpenAI API is "OpenAI-compatible". Used by the main process.
 */
import type { FoundServer } from "../lib/desktop";
import { RUNTIMES, type RuntimeConnection, type RuntimeId } from "../lib/models";
import { checkTimeout, endpoint, headers, identify, runtimeUrl, serverRoot } from "./runtime";

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});

/**
 * The runtime a saved connection's own endpoints name, or undefined when none does. The model list is read
 * first because vLLM names itself there (owned_by "vllm").
 */
export async function identifyServer(connection: RuntimeConnection, transport: typeof fetch = fetch): Promise<RuntimeId | undefined> {
  let base: string;
  try {
    base = endpoint(connection);
  } catch {
    return undefined;
  }
  const list = await transport(runtimeUrl(connection, `${base}/models`), { headers: headers(connection), redirect: "error", signal: AbortSignal.timeout(checkTimeout(connection)) })
    .then(async (response) => (response.ok ? record(await response.json()) : {}))
    .catch(() => ({}) as Record<string, unknown>);
  const models = Array.isArray(list.data) ? list.data.map(record) : undefined;
  return identify(serverRoot(base), connection, transport, models).catch(() => undefined);
}

/** The runtimes' default addresses. Only these are scanned, and all are on localhost, never the network. */
export const DEFAULT_ADDRESSES: readonly string[] = [...new Set(RUNTIMES.flatMap((runtime) => (runtime.baseUrl ? [runtime.baseUrl] : [])))];

/**
 * Servers answering at the default addresses that `skip` does not exclude. Each is named only when its own
 * endpoints confirm the runtime; the port alone never names it.
 */
export async function findServers(skip: (baseUrl: string) => boolean, transport: typeof fetch = fetch): Promise<FoundServer[]> {
  const found = await Promise.all(
    DEFAULT_ADDRESSES.filter((baseUrl) => !skip(baseUrl)).map(async (baseUrl): Promise<FoundServer | undefined> => {
      const response = await transport(`${baseUrl}/models`, { redirect: "error", signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      if (!response) return undefined;
      // 401 is an API asking for its key. A 403 is as likely another service, such as AirPlay on port 5000.
      if (response.status === 401) return { baseUrl, kind: "openai", confirmed: false, models: 0, needsKey: true };
      if (!response.ok) return undefined;
      const body = record(await response.json().catch(() => undefined));
      if (!Array.isArray(body.data)) return undefined;
      const models = body.data.map(record);
      const kind = await identify(serverRoot(baseUrl), { baseUrl, apiKey: "" }, transport, models).catch(() => undefined);
      return { baseUrl, kind: kind ?? "openai", confirmed: Boolean(kind), models: models.length };
    }),
  );
  return found.filter((server): server is FoundServer => server !== undefined);
}
