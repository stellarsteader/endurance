/**
 * API keys, custom headers and signed-address queries per connection ID. Each secret is bound to the address
 * it was saved for and is only added to requests for that address, so two servers of the same kind never
 * share a key and a changed address never receives the old one unless the person moves it there.
 * Storage and encryption are supplied by the main process (safeStorage); this module holds the rules.
 */
import type { SecretChange } from "./desktop";
import type { ConnectionSecrets, RuntimeConnection } from "./models";

export interface VaultIO {
  read(): string | undefined;
  write(text: string): void;
  encrypt(value: string): string;
  decrypt(value: string): string | undefined;
}
interface Stored {
  /** The address the secrets were saved for; they are only sent there. */
  baseUrl: string;
  apiKey?: string;
  headers?: string;
  query?: string;
}

const RESERVED = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie"]);

export function validHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid headers");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 20) throw new Error("Use at most 20 headers.");
  return Object.fromEntries(
    entries.map(([name, value]) => {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || RESERVED.has(name.toLowerCase())) throw new Error(`${name} cannot be set as a header.`);
      if (typeof value !== "string" || value.length > 4000 || /[\r\n]/.test(value)) throw new Error(`Invalid value for ${name}.`);
      return [name, value];
    }),
  );
}

/** A signed address's query, normalized; at most 20 parameters. */
export function validQuery(input: unknown): string {
  if (typeof input !== "string" || input.length > 4000 || /[\r\n]/.test(input)) throw new Error("Invalid address query.");
  const params = new URLSearchParams(input.replace(/^\?/, ""));
  if ([...params.keys()].length > 20) throw new Error("Use at most 20 query parameters.");
  return params.toString();
}

export const sameAddress = (a: string, b: string) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

export class ConnectionVault {
  private cache: Record<string, Stored> | undefined;

  constructor(private io: VaultIO) {}

  private load(): Record<string, Stored> {
    if (this.cache) return this.cache;
    try {
      const parsed: unknown = JSON.parse(this.io.read() ?? "{}");
      this.cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Stored>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private persist(next: Record<string, Stored>) {
    this.cache = next;
    this.io.write(JSON.stringify(next, null, 2));
  }

  flags(): Record<string, ConnectionSecrets> {
    return Object.fromEntries(
      Object.entries(this.load()).map(([id, value]) => {
        let headerNames: string[] = [];
        try {
          const headers = value.headers ? this.io.decrypt(value.headers) : undefined;
          headerNames = headers ? Object.keys(JSON.parse(headers)) : [];
        } catch {
          headerNames = [];
        }
        const query = value.query ? this.io.decrypt(value.query) : undefined;
        return [id, { hasKey: Boolean(value.apiKey), headerNames, queryNames: query ? [...new URLSearchParams(query).keys()] : [] }];
      }),
    );
  }

  /** Keep, replace or remove each secret, bound to `baseUrl`. */
  save(
    id: string,
    baseUrl: string,
    apiKey: SecretChange<string>,
    headers: SecretChange<Record<string, string>>,
    query: SecretChange<string> = { keep: true },
  ) {
    const current = this.load()[id];
    // Kept secrets stay bound to the address they were saved for; only replaced ones take the new address.
    const kept = current && sameAddress(current.baseUrl, baseUrl) ? current : undefined;
    const next: Stored = { baseUrl, apiKey: kept?.apiKey, headers: kept?.headers, query: kept?.query };
    if ("replace" in apiKey) {
      if (typeof apiKey.replace !== "string" || apiKey.replace.length > 4000 || /[\r\n]/.test(apiKey.replace)) throw new Error("Invalid API key.");
      next.apiKey = apiKey.replace.trim() ? this.io.encrypt(apiKey.replace.trim()) : undefined;
    }
    if ("remove" in apiKey) next.apiKey = undefined;
    if ("replace" in headers) {
      const clean = validHeaders(headers.replace);
      next.headers = Object.keys(clean).length ? this.io.encrypt(JSON.stringify(clean)) : undefined;
    }
    if ("remove" in headers) next.headers = undefined;
    if ("replace" in query) {
      const clean = validQuery(query.replace);
      next.query = clean ? this.io.encrypt(clean) : undefined;
    }
    if ("remove" in query) next.query = undefined;
    const all = { ...this.load() };
    if (next.apiKey || next.headers || next.query) all[id] = next;
    else if (!kept && current) all[id] = current;
    else delete all[id];
    this.persist(all);
    return this.flags();
  }

  /** The person chose to send the saved secrets to a new address. */
  rebind(id: string, baseUrl: string) {
    const current = this.load()[id];
    if (!current) return this.flags();
    this.persist({ ...this.load(), [id]: { ...current, baseUrl } });
    return this.flags();
  }

  remove(id: string) {
    if (!this.load()[id]) return this.flags();
    const all = { ...this.load() };
    delete all[id];
    this.persist(all);
    return this.flags();
  }

  /**
   * The saved secrets whatever address they are bound to. Only for a request the person explicitly
   * approved for a new address (testing or saving with "use the saved key here").
   */
  unbound(id: string): Pick<RuntimeConnection, "apiKey" | "headers" | "query"> {
    const saved = this.load()[id];
    return saved ? this.apply(id, { baseUrl: saved.baseUrl, apiKey: "" }) : { apiKey: "" };
  }

  /** True when secrets exist but were saved for another address. */
  boundElsewhere(id: string, baseUrl: string) {
    const current = this.load()[id];
    return Boolean(current && !sameAddress(current.baseUrl, baseUrl));
  }

  /**
   * Adds the saved secrets to a connection. Values from the renderer are always discarded, and nothing is
   * added for an address other than the one the secrets were saved with.
   */
  apply(id: string, connection: RuntimeConnection): RuntimeConnection {
    const base: RuntimeConnection = { ...connection, apiKey: "", headers: undefined, query: undefined };
    const saved = this.load()[id];
    if (!saved || !sameAddress(saved.baseUrl, connection.baseUrl)) return base;
    let headers: Record<string, string> | undefined;
    try {
      const text = saved.headers ? this.io.decrypt(saved.headers) : undefined;
      headers = text ? validHeaders(JSON.parse(text)) : undefined;
    } catch {
      headers = undefined;
    }
    const query = saved.query ? this.io.decrypt(saved.query) : undefined;
    return { ...base, apiKey: (saved.apiKey && this.io.decrypt(saved.apiKey)) || "", ...(headers ? { headers } : {}), ...(query ? { query } : {}) };
  }
}
