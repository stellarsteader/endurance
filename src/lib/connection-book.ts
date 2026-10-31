/**
 * The saved list of connections, owned by the main process. The renderer names a connection by ID and
 * never supplies an address or a secret for a saved one. File I/O, secrets and DNS are injected.
 */
import {
  classifyAddresses,
  classifyHost,
  connectionLabel,
  defaultConnection,
  hostOf,
  isBuiltinId,
  migrateLegacy,
  newConnectionId,
  normalizeFile,
  requireSecureAddress,
  type Connection,
  type ConnectionFile,
  type ConnectionView,
  type LegacySettings,
  type ServerOwner,
  ownerOf,
} from "./connections";
import type { ConnectionVault } from "./connection-vault";
import { PRIMARY_RUNTIMES, type RuntimeConnection, type RuntimeId, type ServerLocation } from "./models";

export interface BookIO {
  read(): string | undefined;
  write(text: string): void;
}
/** Resolves a host name to its addresses; rejects or returns [] when it cannot. */
export type HostResolver = (host: string) => Promise<string[]>;

export interface ResolvedConnection {
  connection: Connection;
  runtime: RuntimeId;
  /** The request connection with saved secrets for its saved address. Main process only. */
  value: RuntimeConnection;
  label: string;
  host: string;
  location: ServerLocation;
}

export interface ConnectionFields {
  kind: RuntimeId;
  baseUrl: string;
  name?: string;
  concurrency?: number;
  owner?: ServerOwner;
}

const LOCATION_TTL = 10 * 60_000;
// Writing on every successful check would rewrite the file each refresh; history needs minutes, not ms.
const CONNECTED_WRITE_INTERVAL = 5 * 60_000;

export class ConnectionBook {
  private file: ConnectionFile | undefined;
  private existed = false;
  private locations = new Map<string, { location: ServerLocation; at: number }>();

  constructor(
    private io: BookIO,
    private vault: ConnectionVault,
    private resolveHost: HostResolver = async () => [],
    private now = Date.now,
  ) {}

  private load(): ConnectionFile {
    if (this.file) return this.file;
    const text = this.io.read();
    this.existed = text !== undefined;
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    this.file = normalizeFile(parsed);
    return this.file;
  }

  private save() {
    this.io.write(JSON.stringify(this.load(), null, 2));
    this.existed = true;
  }

  /** On first run with this file, settings from the renderer-owned era move here once. */
  initialize(legacy?: LegacySettings) {
    this.load();
    if (this.existed) return false;
    this.file = migrateLegacy(legacy);
    this.save();
    return true;
  }

  list(): Connection[] {
    return this.load().connections.map((item) => ({ ...item }));
  }

  get(id: string): Connection | undefined {
    const found = this.load().connections.find((item) => item.id === id);
    return found ? { ...found } : undefined;
  }

  dismissed(): RuntimeId[] {
    return [...this.load().dismissed];
  }

  /** The cached location, else what the address alone says. Never blocks on DNS. */
  location(baseUrl: string): ServerLocation {
    const host = hostOf(baseUrl);
    const cached = this.locations.get(host);
    return cached ? cached.location : classifyHost(host);
  }

  /** Resolves names to addresses so a name for a private address counts as the person's network. */
  async locate(baseUrl: string): Promise<ServerLocation> {
    const host = hostOf(baseUrl);
    const literal = classifyHost(host);
    // Literal addresses and loopback names need no lookup.
    if (!host || /^[\d.]+$/.test(host) || host.includes(":") || literal === "this-computer") return literal;
    const cached = this.locations.get(host);
    if (cached && this.now() - cached.at < LOCATION_TTL) return cached.location;
    let addresses: string[] = [];
    try {
      addresses = await this.resolveHost(host);
    } catch {
      addresses = [];
    }
    // A name that does not resolve keeps the literal guess; remote is the guess for dotted public names.
    const location = classifyAddresses(addresses, literal);
    this.locations.set(host, { location, at: this.now() });
    return location;
  }

  view(connection: Connection): ConnectionView {
    const flags = this.vault.flags()[connection.id] ?? { hasKey: false, headerNames: [] };
    const location = this.location(connection.baseUrl);
    return {
      ...connection,
      builtin: isBuiltinId(connection.id),
      primary: PRIMARY_RUNTIMES.includes(connection.id as RuntimeId),
      label: connectionLabel(connection),
      host: hostOf(connection.baseUrl),
      location,
      mine: ownerOf(connection, location) === "mine",
      secrets: { ...flags, ...(this.vault.boundElsewhere(connection.id, connection.baseUrl) ? { elsewhere: true } : {}) },
    };
  }

  async views(): Promise<ConnectionView[]> {
    const list = this.list();
    await Promise.all(list.map((item) => this.locate(item.baseUrl)));
    return list.map((item) => this.view(item));
  }

  /**
   * Every request to a saved connection starts here, so a saved address that would send plain HTTP to
   * another computer (saved before the rule, or edited in the file) throws InsecureAddressError and its
   * secrets are never read out.
   */
  resolve(id: string): ResolvedConnection | undefined {
    const connection = this.get(id);
    if (!connection) return undefined;
    requireSecureAddress(connection.baseUrl);
    const base: RuntimeConnection = {
      baseUrl: connection.baseUrl,
      apiKey: "",
      ...(connection.concurrency ? { concurrency: connection.concurrency } : {}),
    };
    return {
      connection,
      runtime: connection.kind,
      value: this.vault.apply(connection.id, base),
      label: connectionLabel(connection),
      host: hostOf(connection.baseUrl),
      location: this.location(connection.baseUrl),
    };
  }

  add(fields: ConnectionFields): Connection {
    requireSecureAddress(fields.baseUrl);
    const connection: Connection = { id: newConnectionId(), ...clean(fields) };
    this.load().connections.push(connection);
    this.save();
    return { ...connection };
  }

  /** Lists a runtime at its default address: detected, or added by the person from the menu. */
  addBuiltin(id: RuntimeId, manual: boolean): Connection | undefined {
    const file = this.load();
    if (!isBuiltinId(id) || file.connections.some((item) => item.id === id)) return undefined;
    if (!manual && file.dismissed.includes(id)) return undefined;
    const connection = defaultConnection(id);
    file.connections.push(connection);
    file.dismissed = file.dismissed.filter((item) => item !== id);
    this.save();
    return { ...connection };
  }

  update(id: string, patch: Partial<Omit<ConnectionFields, "kind">> & { kind?: RuntimeId }): Connection {
    const file = this.load();
    const index = file.connections.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("This server is no longer listed.");
    const current = file.connections[index];
    const pick = <K extends keyof ConnectionFields>(key: K) => (key in patch ? patch[key] : current[key]) as ConnectionFields[K];
    const next: Connection = {
      id,
      ...clean({
        // A builtin connection is that runtime; an added server keeps what its address identified as.
        kind: isBuiltinId(id) ? current.kind : (patch.kind ?? current.kind),
        baseUrl: pick("baseUrl"),
        name: pick("name"),
        concurrency: pick("concurrency"),
        owner: pick("owner"),
      }),
    };
    // A new address must meet the HTTPS rule. A saved one that does not can still be renamed or marked,
    // since it is refused whenever it is used.
    if (next.baseUrl !== current.baseUrl) requireSecureAddress(next.baseUrl);
    // History belongs to the address: a new address has not answered yet.
    if (next.baseUrl === current.baseUrl && current.lastConnectedAt) next.lastConnectedAt = current.lastConnectedAt;
    file.connections[index] = next;
    this.save();
    return { ...next };
  }

  /** Puts the servers in the person's order. Ids it does not name keep their place after the named ones. */
  reorder(ids: readonly string[]) {
    const file = this.load();
    const rank = new Map(ids.map((id, index) => [id, index]));
    const named = file.connections.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    file.connections = [...named, ...file.connections.filter((item) => !rank.has(item.id))];
    this.save();
  }

  /** Removes a server and its secrets. The default runtime stays; other runtimes are remembered as removed. */
  remove(id: string) {
    const file = this.load();
    if (PRIMARY_RUNTIMES.includes(id as RuntimeId)) throw new Error("Default runtimes stay in the list.");
    if (!file.connections.some((item) => item.id === id)) return;
    file.connections = file.connections.filter((item) => item.id !== id);
    if (isBuiltinId(id)) file.dismissed = [...new Set([...file.dismissed, id])];
    this.save();
    this.vault.remove(id);
  }

  markConnected(id: string) {
    const file = this.load();
    const item = file.connections.find((entry) => entry.id === id);
    if (!item) return;
    const now = this.now();
    const write = !item.lastConnectedAt || now - item.lastConnectedAt > CONNECTED_WRITE_INTERVAL;
    item.lastConnectedAt = write ? now : item.lastConnectedAt;
    if (write) this.save();
  }
}

function clean(fields: ConnectionFields): Omit<Connection, "id"> {
  const name = fields.name?.trim().slice(0, 80);
  return {
    kind: fields.kind,
    baseUrl: fields.baseUrl.trim().replace(/\/+$/, ""),
    ...(name ? { name } : {}),
    ...(fields.concurrency && fields.concurrency >= 1 && fields.concurrency <= 64 ? { concurrency: Math.round(fields.concurrency) } : {}),
    ...(fields.owner ? { owner: fields.owner } : {}),
  };
}
