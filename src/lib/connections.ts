/**
 * Servers as connections: Ollama as the default local runtime, runtimes found at their default address, and
 * servers added by URL. Everything here is decided from addresses and HTTP answers only; no hosting
 * provider is named or special-cased. Pure, shared by the main process and the renderer.
 */
import {
  isRuntimeId,
  PRIMARY_RUNTIMES,
  RUNTIMES,
  runtimeName,
  type ConnectionSecrets,
  type RuntimeConnection,
  type RuntimeId,
  type ServerLocation,
} from "./models";

export interface Connection {
  /** Builtin connections use their runtime ID; added servers get "srv-" and a random suffix. */
  id: string;
  /** The runtime identified at the address, or "openai" when the server names none. */
  kind: RuntimeId;
  baseUrl: string;
  /** Shown instead of the default label; added servers start with their host name. */
  name?: string;
  concurrency?: number;
  /** Whether the person runs this server. Unset follows the address: this computer and the person's network are theirs. */
  owner?: ServerOwner;
  /** Set when the server last answered at this address; "Ended" needs a server that once answered. */
  lastConnectedAt?: number;
}

export type ServerOwner = "mine" | "external";
export const isOwner = (value: unknown): value is ServerOwner => value === "mine" || value === "external";
/** A server the person runs is read more fully (vLLM's development endpoints); an external one is only used. */
export const ownerOf = (connection: Pick<Connection, "owner">, location: ServerLocation): ServerOwner =>
  connection.owner ?? (location === "remote" ? "external" : "mine");
/** The runtimes this build supports fully; the others work through the shared OpenAI-compatible path. */
export const SUPPORTED_RUNTIMES: readonly RuntimeId[] = ["ollama", "vllm"];

/** What the renderer sees: never a key, header value or signed query, only that they exist. */
export interface ConnectionView extends Connection {
  builtin: boolean;
  /** A default runtime (Ollama): always listed, never removed. */
  primary: boolean;
  label: string;
  host: string;
  location: ServerLocation;
  /** `owner` as set, else as the address suggests. */
  mine: boolean;
  secrets: ConnectionSecrets;
}

export const isBuiltinId = (id: string): id is RuntimeId => isRuntimeId(id) && id !== "openai";
export const newConnectionId = () => `srv-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
export const validConnectionId = (value: unknown): value is string =>
  typeof value === "string" && (isBuiltinId(value) || /^srv-[a-z0-9]{6,32}$/.test(value));

export function hostOf(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

export function connectionLabel(connection: Pick<Connection, "id" | "kind" | "name" | "baseUrl">) {
  if (connection.name?.trim()) return connection.name.trim();
  return isBuiltinId(connection.id) ? runtimeName(connection.id) : hostOf(connection.baseUrl) || runtimeName(connection.kind);
}

function ipv4(host: string) {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return undefined;
  return parts.map(Number);
}

/**
 * Where an address points, from the address alone. Loopback is this computer; RFC 1918, link-local,
 * IPv6 unique-local, .local, single-label names and Tailscale (100.64.0.0/10, *.ts.net) are the
 * person's network; everything else is remote. When unsure, it says remote, which discloses more.
 */
export function classifyHost(hostname: string): ServerLocation {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "remote";
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") return "this-computer";
  const mapped = host.startsWith("::ffff:") ? host.slice(7) : host;
  const v4 = ipv4(mapped);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "this-computer";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "network";
    return "remote";
  }
  if (host.includes(":")) return /^(fc|fd|fe[89ab])/.test(host) ? "network" : "remote";
  if (host.endsWith(".local") || host.endsWith(".ts.net") || host.endsWith(".lan") || host.endsWith(".home.arpa") || host.endsWith(".internal")) return "network";
  if (!host.includes(".")) return "network";
  return "remote";
}

/** A name that resolves to several addresses is as far away as its farthest one. */
export function classifyAddresses(addresses: string[], fallback: ServerLocation): ServerLocation {
  if (!addresses.length) return fallback;
  const kinds = addresses.map(classifyHost);
  return kinds.includes("remote") ? "remote" : kinds.includes("network") ? "network" : "this-computer";
}

export const locationLabel = (location: ServerLocation) =>
  location === "this-computer" ? "This computer" : location === "network" ? "Your network" : "Remote";

// ---------------------------------------------------------------------------------------------------
// Pasted server input: a URL or a curl command.

export interface ParsedServer {
  baseUrl: string;
  /** Query from a signed address, kept apart so it is stored as a secret. */
  query?: string;
  apiKey?: string;
  headers: Record<string, string>;
  /** Shell variables such as $TOKEN: their values are not in the text, so the person enters them. */
  unresolved: string[];
}

const DROPPED_HEADERS = new Set(["content-type", "content-length", "accept", "host", "cookie", "connection", "user-agent", "transfer-encoding"]);
// API routes people copy from docs; the connection keeps the API base above them.
const ROUTE = /\/(?:chat\/completions|completions|responses|embeddings|models(?:\/[^/]*)?|api\/(?:tags|chat|generate|version|show|ps)|v1\/messages)\/?$/i;
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Splits a command line like a POSIX shell: quotes, backslash escapes and line continuations. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && /["\\$`\n]/.test(text[index + 1] ?? "")) {
        if (text[index + 1] !== "\n") word += text[index + 1];
        index++;
      } else word += char;
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === "\n" || (next === "\r" && text[index + 2] === "\n")) index += next === "\r" ? 2 : 1;
      else if (next !== undefined) {
        word += next;
        started = true;
        index++;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) throw new Error("A quote in the command is not closed.");
  if (started) words.push(word);
  return words;
}

const variables = (value: string) => [...value.matchAll(VARIABLE)].map((match) => match[1] ?? match[2]);

function splitAddress(input: string): { baseUrl: string; query?: string } {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // Servers on this computer or the person's network usually serve plain HTTP; others HTTPS.
    const host = text.split(/[/?#:]/)[0];
    text = `${classifyHost(host) === "remote" ? "https" : "http"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Enter a server address, such as https://example.com/v1.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Use an http:// or https:// address.");
  if (url.username || url.password) throw new Error("Remove the user name and password from the address, and put the key in the API key field.");
  const query = url.search.replace(/^\?/, "") || undefined;
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(ROUTE, "").replace(/\/+$/, "");
  return { baseUrl: `${url.origin}${path}`, ...(query ? { query } : {}) };
}

/** Reads a pasted URL or curl command into an address, key, headers and signed query. */
export function parseServerInput(input: string): ParsedServer {
  const text = input.trim();
  if (!text) throw new Error("Paste a server address or a curl command.");
  if (!/^curl(\s|$)/.test(text)) {
    if (/\s/.test(text.replace(/\s+$/, ""))) throw new Error("Paste one address, or a whole curl command.");
    const address = text.replace(/^['"]|['"]$/g, "");
    const unresolved = variables(address);
    return { ...splitAddress(address), headers: {}, unresolved };
  }
  const words = shellWords(text).slice(1);
  const headers: Record<string, string> = {};
  const unresolved = new Set<string>();
  let url: string | undefined;
  let apiKey: string | undefined;
  const header = (value: string) => {
    const match = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(value);
    if (!match) return;
    const [, name, raw] = match;
    const found = variables(raw);
    found.forEach((item) => unresolved.add(item));
    const bearer = /^Bearer\s+(.+)$/i.exec(raw.trim());
    if (name.toLowerCase() === "authorization" && bearer && !found.length) {
      apiKey = bearer[1].trim();
      return;
    }
    if (DROPPED_HEADERS.has(name.toLowerCase()) || found.length) return;
    headers[name] = raw.trim();
  };
  const valued = new Set(["-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-o", "--output", "-m", "--max-time", "--connect-timeout", "-b", "--cookie", "-A", "--user-agent", "-e", "--referer", "-F", "--form"]);
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "-H" || word === "--header") header(words[++index] ?? "");
    else if (word.startsWith("-H") && word.length > 2) header(word.slice(2));
    else if (word.startsWith("--header=")) header(word.slice(9));
    else if (word === "--url") url = words[++index];
    else if (word.startsWith("--url=")) url = word.slice(6);
    else if (word === "-u" || word === "--user") {
      const value = words[++index] ?? "";
      variables(value).forEach((item) => unresolved.add(item));
      if (!variables(value).length) headers.Authorization = `Basic ${btoa(value)}`;
    } else if (valued.has(word)) index++;
    else if (word.startsWith("-")) continue;
    else if (!url) url = word;
  }
  if (!url) throw new Error("The curl command has no address.");
  variables(url).forEach((item) => unresolved.add(item));
  return { ...splitAddress(url), ...(apiKey ? { apiKey } : {}), headers, unresolved: [...unresolved] };
}

// ---------------------------------------------------------------------------------------------------
// State from HTTP meaning.

export type ConnectionState = "connected" | "starting" | "ended" | "unavailable";

/**
 * 502/503/504 mean a gateway is up and the server behind it is not ready yet. A server that answered
 * here before and is now gone from DNS, or answers 404 where its model list was, has ended.
 */
export function connectionState(
  result: { error?: string; reason?: string; status?: number },
  connection: Pick<Connection, "lastConnectedAt">,
): ConnectionState {
  if (!result.error) return "connected";
  if (result.reason === "starting") return "starting";
  if (connection.lastConnectedAt && (result.reason === "host" || result.status === 404)) return "ended";
  return "unavailable";
}

// ---------------------------------------------------------------------------------------------------
// Migration from the renderer-owned settings (localStorage "endurance:v1").

export interface LegacySettings {
  connections?: Partial<Record<string, Partial<RuntimeConnection>>>;
  addedRuntimes?: string[];
  dismissedRuntimes?: string[];
}
export interface ConnectionFile {
  version: 1;
  connections: Connection[];
  /** Runtimes the person removed, so detection does not add them back. */
  dismissed: RuntimeId[];
}

const slots = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 64 ? value : undefined);
const address = (value: unknown, fallback: string) => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? value.trim().replace(/\/+$/, "") : fallback;
  } catch {
    return fallback;
  }
};

export function defaultConnection(id: RuntimeId): Connection {
  const runtime = RUNTIMES.find((item) => item.id === id)!;
  return { id, kind: id, baseUrl: runtime.baseUrl };
}

/**
 * Builtin connections keep their runtime as ID, so saved keychain entries, model IDs (local:<runtime>:…)
 * and model settings carry over unchanged. Keys left in old settings are not copied here.
 */
export function migrateLegacy(saved: LegacySettings | undefined): ConnectionFile {
  // Runtimes the old settings added or configured; the default runtime is always listed.
  const added = [...Object.keys(saved?.connections ?? {}), ...(saved?.addedRuntimes ?? [])].filter((id): id is RuntimeId => isBuiltinId(id) && !PRIMARY_RUNTIMES.includes(id));
  const ids = [...new Set([...PRIMARY_RUNTIMES, ...added])];
  return {
    version: 1,
    connections: ids.map((id) => {
      const base = defaultConnection(id);
      const old = saved?.connections?.[id];
      const concurrency = slots(old?.concurrency);
      return { ...base, baseUrl: address(old?.baseUrl, base.baseUrl), ...(concurrency ? { concurrency } : {}) };
    }),
    dismissed: [...new Set((saved?.dismissedRuntimes ?? []).filter((id): id is RuntimeId => isBuiltinId(id) && !PRIMARY_RUNTIMES.includes(id)))],
  };
}

/** Reads a saved file defensively: unknown fields are dropped and the default runtime is always present. */
export function normalizeFile(value: unknown): ConnectionFile {
  const input = value !== null && typeof value === "object" ? (value as Partial<ConnectionFile>) : {};
  const seen = new Set<string>();
  const connections: Connection[] = [];
  for (const raw of Array.isArray(input.connections) ? input.connections : []) {
    const item = raw as Partial<Connection>;
    if (!validConnectionId(item?.id) || seen.has(item.id) || !isRuntimeId(item.kind)) continue;
    const fallback = isBuiltinId(item.id) ? defaultConnection(item.id).baseUrl : "";
    const baseUrl = address(item.baseUrl, fallback);
    if (!baseUrl) continue;
    seen.add(item.id);
    const concurrency = slots(item.concurrency);
    connections.push({
      id: item.id,
      // A builtin connection is that runtime at its own address; added servers keep what was identified.
      kind: isBuiltinId(item.id) ? item.id : item.kind,
      baseUrl,
      ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim().slice(0, 80) } : {}),
      ...(concurrency ? { concurrency } : {}),
      ...(isOwner(item.owner) ? { owner: item.owner } : {}),
      ...(typeof item.lastConnectedAt === "number" && Number.isFinite(item.lastConnectedAt) ? { lastConnectedAt: item.lastConnectedAt } : {}),
    });
  }
  for (const id of PRIMARY_RUNTIMES) if (!seen.has(id)) connections.splice(PRIMARY_RUNTIMES.indexOf(id), 0, defaultConnection(id));
  return {
    version: 1,
    connections,
    dismissed: [...new Set((Array.isArray(input.dismissed) ? input.dismissed : []).filter((id): id is RuntimeId => isBuiltinId(id) && !PRIMARY_RUNTIMES.includes(id)))],
  };
}
