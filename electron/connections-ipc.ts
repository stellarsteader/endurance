/**
 * Connections IPC. The main process owns every saved connection: the renderer names one by ID, sees only
 * whether secrets exist, and receives the list and catalog as pushed snapshots.
 */
import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { discoverModels, inspectServer, probeRuntime } from "../src/harness/runtime";
import { DEFAULT_ADDRESSES, findServers, identifyServer } from "../src/harness/server-identity";
import {
  connectionState,
  HTTPS_REQUIRED,
  InsecureAddressError,
  isBuiltinId,
  isHosting,
  parseServerInput,
  plainHttpRefusal,
  requireSecureAddress,
  validConnectionId,
  type LegacySettings,
} from "../src/lib/connections";
import { sameAddress } from "../src/lib/connection-vault";
import { isRuntimeId, PRIMARY_RUNTIMES, RUNTIMES, type RuntimeConnection, type RuntimeId } from "../src/lib/models";
import type { CatalogResult, ConnectionEdit, ConnectionTest, FoundServer, RuntimeProbe, ServerCheck, ServerDraft } from "../src/lib/desktop";
import type { Connection } from "../src/lib/connections";
import { validHeaders, validQuery, vault } from "./connection-secrets";
import { book } from "./connection-store";
import { vllmServerInfo, type ServerInfo } from "../src/harness/server-info";

type Trust = (event: IpcMainInvokeEvent | IpcMainEvent) => void;

const catalog = new Map<string, CatalogResult>();
// A starting server is checked again on its own, slower each time, until it answers or fails otherwise.
const RECHECK_SECONDS = [5, 10, 20, 30, 60];
const rechecks = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();
/** What each server named itself as, and at which address. Asked again only when that may have changed. */
const identities = new Map<string, { baseUrl: string; identified: RuntimeId | "unknown" }>();

/**
 * The runtime the server's own endpoints name. Asked when it answers at a new address or answers again after
 * being away, since another runtime may have taken the port in between; otherwise the last answer stands.
 */
async function identityOf(id: string, resolved: NonNullable<ReturnType<typeof book.resolve>>, answeredBefore: boolean) {
  const known = identities.get(id);
  if (known && answeredBefore && sameAddress(known.baseUrl, resolved.connection.baseUrl)) return known.identified;
  const identified = (await identifyServer(resolved.value)) ?? "unknown";
  identities.set(id, { baseUrl: resolved.connection.baseUrl, identified });
  return identified;
}

/** A found address only if it is one of the default addresses Endurance scans, never one the renderer made up. */
function foundAddress(value: unknown) {
  const address = typeof value === "string" ? DEFAULT_ADDRESSES.find((item) => sameAddress(item, value)) : undefined;
  if (!address) throw new Error("Unknown address");
  return address;
}

function broadcast(channel: string, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
}

/** The catalog in the person's order of servers. */
function ordered(): CatalogResult[] {
  const ids = book.list().map((item) => item.id);
  for (const id of catalog.keys()) if (!ids.includes(id)) catalog.delete(id);
  return ids.flatMap((id) => catalog.get(id) ?? []);
}

async function pushConnections() {
  broadcast("connections:changed", await book.views());
}

function schedule(id: string, starting: boolean) {
  const current = rechecks.get(id);
  if (!starting) {
    if (current) clearTimeout(current.timer);
    rechecks.delete(id);
    return;
  }
  if (current) return;
  const run = (step: number) => {
    const timer = setTimeout(async () => {
      await check(id, false);
      broadcast("catalog:changed", ordered());
      const result = catalog.get(id);
      if (result?.state === "starting" && book.get(id)) run(step + 1);
      else rechecks.delete(id);
    }, RECHECK_SECONDS[Math.min(step, RECHECK_SECONDS.length - 1)] * 1000);
    rechecks.set(id, { timer, attempt: step });
  };
  run(0);
}

async function check(id: string, rescheduling = true) {
  const saved = book.get(id);
  // A saved address that breaks the HTTPS rule is not asked at all; its row says why instead.
  if (saved && plainHttpRefusal(saved.baseUrl)) {
    catalog.set(id, { connectionId: id, runtime: saved.kind, models: [], error: HTTPS_REQUIRED, reason: "insecure", state: "unavailable" });
    schedule(id, false);
    return;
  }
  const resolved = book.resolve(id);
  if (!resolved) {
    catalog.delete(id);
    schedule(id, false);
    return;
  }
  const location = await book.locate(resolved.connection.baseUrl);
  const answeredBefore = catalog.get(id)?.state === "connected";
  const result = await discoverModels(resolved.runtime, resolved.value, { connectionId: id, label: resolved.label, location });
  // Ended compares with history from before this answer.
  const state = connectionState(result, resolved.connection);
  if (state === "connected") book.markConnected(id);
  const identified = state === "connected" ? await identityOf(id, resolved, answeredBefore) : undefined;
  catalog.set(id, { ...result, state, ...(identified ? { identified } : {}) });
  if (rescheduling) schedule(id, state === "starting");
}

async function refresh(ids = book.list().map((item) => item.id)) {
  await Promise.all(ids.map((id) => check(id)));
  const result = ordered();
  broadcast("catalog:changed", result);
  return result;
}

function validAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid address");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Invalid address");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use an http:// or https:// address without a user name, query or fragment.");
  return value.trim().replace(/\/+$/, "");
}
const optionalNumber = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** Reads a draft from the renderer: the pasted text is parsed again here, typed values are validated. */
function readDraft(draft: ServerDraft) {
  if (!draft || typeof draft.input !== "string" || draft.input.length > 16_000) throw new Error("Paste a server address or a curl command.");
  const parsed = parseServerInput(draft.input);
  const typed = typeof draft.apiKey === "string" ? draft.apiKey.trim() : "";
  if (typed.length > 4000 || /[\r\n]/.test(typed)) throw new Error("Invalid API key.");
  const headers = validHeaders({ ...parsed.headers, ...(draft.headers ? validHeaders(draft.headers) : {}) });
  const query = parsed.query ? validQuery(parsed.query) : undefined;
  const connection: RuntimeConnection = {
    baseUrl: parsed.baseUrl,
    apiKey: typed || parsed.apiKey || "",
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(query ? { query } : {}),
  };
  const runtime = isRuntimeId(draft.runtime) && isBuiltinId(draft.runtime) ? draft.runtime : undefined;
  return { connection, runtime, name: typeof draft.name === "string" ? draft.name.trim().slice(0, 80) : "", concurrency: optionalNumber(draft.concurrency, 1, 64) };
}

/** A typed address without a path gets the runtime's API path, such as /v1, so a server not running yet is saved where it will answer. */
function withRuntimePath(baseUrl: string, runtime: RuntimeId) {
  const fallback = RUNTIMES.find((item) => item.id === runtime)?.baseUrl;
  try {
    const url = new URL(baseUrl);
    if (url.pathname.replace(/\/+$/, "") || !fallback) return baseUrl.replace(/\/+$/, "");
    return `${url.origin}${new URL(fallback).pathname}`.replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

async function checkServer(draft: ServerDraft, save: boolean): Promise<ServerCheck> {
  const { connection, runtime, name, concurrency } = readDraft(draft);
  const asked = await inspectServer(connection);
  // A chosen runtime is the person's call: it is saved as that runtime, also before the server runs, so its
  // setup steps can show. Its row then offers the runtime the server names, if that differs.
  const inspection = runtime ? { ...asked, kind: runtime, baseUrl: asked.probe.ok || asked.probe.reason === "starting" ? asked.baseUrl : withRuntimePath(connection.baseUrl, runtime) } : asked;
  const listed = book.list().find((item) => sameAddress(item.baseUrl, inspection.baseUrl));
  if (listed) return { ...inspection, duplicate: book.view(listed).label };
  const answered = inspection.probe.ok || inspection.probe.reason === "starting";
  // A refused address, an invalid one or a missing key is never saved, chosen runtime or not.
  const blocked = inspection.probe.reason === "insecure" || inspection.probe.reason === "address" || inspection.probe.reason === "auth";
  if (!save || (runtime ? blocked : !answered)) return inspection;
  const builtin = runtime ? book.addBuiltin(runtime, true, inspection.baseUrl) : undefined;
  // A builtin row starts with the runtime's defaults, so a typed name is set on it after.
  const added = builtin ? (name ? book.update(builtin.id, { name }) : builtin) : book.add({ kind: inspection.kind, baseUrl: inspection.baseUrl, name, concurrency });
  vault.save(
    added.id,
    added.baseUrl,
    connection.apiKey ? { replace: connection.apiKey } : { keep: true },
    connection.headers ? { replace: connection.headers } : { keep: true },
    connection.query ? { replace: connection.query } : { keep: true },
  );
  await pushConnections();
  void refresh([added.id]);
  return { ...inspection, connection: book.view(added) };
}

export function registerConnectionsIPC(trusted: Trust) {
  ipcMain.handle("connections:list", async (event, legacy?: LegacySettings) => {
    trusted(event);
    book.initialize(legacy && typeof legacy === "object" ? legacy : undefined);
    return book.views();
  });
  // With a saved connection's ID, only that connection is checked again; the result still lists them all.
  ipcMain.handle("connections:catalog", (event, connectionId?: unknown) => {
    trusted(event);
    return refresh(typeof connectionId === "string" && book.get(connectionId) ? [connectionId] : undefined);
  });
  // A server whose own endpoints confirm a runtime is listed as that runtime, unless the person removed it
  // before. Every other one is only suggested: the port alone does not say what it is.
  ipcMain.handle("connections:detect", async (event): Promise<FoundServer[]> => {
    trusted(event);
    const listed = book.list();
    const ignored = book.ignored();
    const found = await findServers((baseUrl) => listed.some((item) => sameAddress(item.baseUrl, baseUrl)) || ignored.some((item) => sameAddress(item, baseUrl)));
    const added: Connection[] = [];
    const suggested: FoundServer[] = [];
    for (const server of found) {
      const connection = server.confirmed && isBuiltinId(server.kind) ? book.addBuiltin(server.kind, false, server.baseUrl) : undefined;
      if (connection) added.push(connection);
      else suggested.push(server);
    }
    if (added.length) {
      await pushConnections();
      await refresh(added.map((item) => item.id));
    }
    return suggested;
  });
  ipcMain.handle("connections:add-found", async (event, baseUrl: unknown) => {
    trusted(event);
    const address = foundAddress(baseUrl);
    if (book.list().some((item) => sameAddress(item.baseUrl, address))) return undefined;
    // Asked again here: the suggestion may be stale, and only this process decides what a server is.
    const [server] = await findServers((item) => item !== address);
    if (!server) throw new Error("The server at this address is no longer answering.");
    const builtin = server.confirmed && isBuiltinId(server.kind) ? book.addBuiltin(server.kind, true, address) : undefined;
    const added = builtin ?? book.add({ kind: server.kind, baseUrl: address });
    await pushConnections();
    void refresh([added.id]);
    return book.view(added);
  });
  ipcMain.handle("connections:ignore-found", (event, baseUrl: unknown) => {
    trusted(event);
    book.ignore(foundAddress(baseUrl));
  });
  // The person's choice of runtime stands until they switch: a fingerprint can be shared by related servers,
  // so the identified runtime is offered, never applied on its own.
  ipcMain.handle("connections:switch-identified", async (event, id: unknown) => {
    trusted(event);
    const current = validConnectionId(id) ? book.get(id) : undefined;
    const identified = current ? identities.get(current.id)?.identified : undefined;
    if (!current || !identified || identified === "unknown" || identified === current.kind || PRIMARY_RUNTIMES.includes(current.id as RuntimeId))
      throw new Error("This server has no other runtime to switch to.");
    const next = book.retype(current.id, identified);
    if (next.id !== current.id) {
      // The key, headers and signed query saved for this address go with it.
      const secrets = vault.apply(current.id, { baseUrl: current.baseUrl, apiKey: "" });
      vault.save(
        next.id,
        next.baseUrl,
        secrets.apiKey ? { replace: secrets.apiKey } : { keep: true },
        secrets.headers ? { replace: secrets.headers } : { keep: true },
        secrets.query ? { replace: secrets.query } : { keep: true },
      );
      vault.remove(current.id);
      catalog.delete(current.id);
      schedule(current.id, false);
    }
    identities.delete(current.id);
    await pushConnections();
    await refresh([next.id]);
    return book.view(book.get(next.id)!);
  });
  ipcMain.handle("connections:keep-runtime", async (event, id: unknown) => {
    trusted(event);
    const current = validConnectionId(id) ? book.get(id) : undefined;
    const identified = current ? identities.get(current.id)?.identified : undefined;
    if (!current || !identified || identified === "unknown") return;
    book.update(current.id, { declined: identified });
    await pushConnections();
  });
  ipcMain.handle("connections:add-runtime", async (event, id: unknown) => {
    trusted(event);
    if (!isRuntimeId(id) || !isBuiltinId(id)) throw new Error("Unknown runtime");
    const added = book.addBuiltin(id, true);
    await pushConnections();
    if (added) await refresh([added.id]);
  });
  ipcMain.handle("connections:check-server", (event, draft: ServerDraft) => {
    trusted(event);
    return checkServer(draft, false);
  });
  ipcMain.handle("connections:add-server", (event, draft: ServerDraft) => {
    trusted(event);
    return checkServer(draft, true);
  });
  ipcMain.handle("connections:update", async (event, id: unknown, edit: ConnectionEdit) => {
    trusted(event);
    if (!validConnectionId(id) || !book.get(id) || !edit || typeof edit !== "object") throw new Error("This server is no longer listed.");
    const current = book.get(id)!;
    const baseUrl = edit.baseUrl === undefined ? current.baseUrl : validAddress(edit.baseUrl);
    const moved = !sameAddress(baseUrl, current.baseUrl);
    // Checked before the new address is asked what it serves; an unchanged one is refused when used.
    if (moved) requireSecureAddress(baseUrl);
    let kind = current.kind;
    // An added server at a new address is identified again; a builtin connection stays its runtime.
    if (moved && !isBuiltinId(id)) {
      const secrets = edit.moveSecrets ? vault.unbound(id) : vault.apply(id, { baseUrl, apiKey: "" });
      const typed = edit.apiKey && "replace" in edit.apiKey ? edit.apiKey.replace : undefined;
      const inspection = await inspectServer({ baseUrl, ...secrets, apiKey: typed ?? secrets.apiKey ?? "" });
      if (inspection.probe.ok) kind = inspection.kind;
    }
    const patch: Parameters<typeof book.update>[1] = { baseUrl, kind };
    // A choice not to switch was about the server at the old address.
    if (moved) patch.declined = undefined;
    if ("name" in edit) patch.name = typeof edit.name === "string" ? edit.name : undefined;
    if ("concurrency" in edit) patch.concurrency = optionalNumber(edit.concurrency, 1, 64);
    if ("hosting" in edit) patch.hosting = isHosting(edit.hosting) && edit.hosting !== "self-hosted" ? edit.hosting : undefined;
    const updated = book.update(id, patch);
    if (moved && edit.moveSecrets) vault.rebind(id, updated.baseUrl);
    if (edit.apiKey || edit.headers) vault.save(id, updated.baseUrl, edit.apiKey ?? { keep: true }, edit.headers ?? { keep: true });
    await pushConnections();
    void refresh([id]);
    return book.view(book.get(id)!);
  });
  // Shown on the Connections page; development endpoints are asked only of a server the person runs.
  ipcMain.handle("connections:server-info", async (event, id: unknown): Promise<ServerInfo | undefined> => {
    trusted(event);
    // A refused address has no details to show; its row already says why.
    const resolved = validConnectionId(id) && !plainHttpRefusal(book.get(id)?.baseUrl ?? "") ? book.resolve(id) : undefined;
    if (!resolved || resolved.runtime !== "vllm") return undefined;
    return vllmServerInfo(resolved.value, book.view(resolved.connection).selfHosted);
  });
  ipcMain.handle("connections:reorder", async (event, ids: unknown) => {
    trusted(event);
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every(validConnectionId)) throw new Error("Invalid server order");
    book.reorder(ids);
    await pushConnections();
    broadcast("catalog:changed", ordered());
  });
  ipcMain.handle("connections:remove", async (event, id: unknown) => {
    trusted(event);
    if (!validConnectionId(id)) throw new Error("Unknown server");
    book.remove(id);
    catalog.delete(id);
    identities.delete(id);
    schedule(id, false);
    await pushConnections();
    broadcast("catalog:changed", ordered());
  });
  // Tests the values being edited. Saved secrets go only to their saved address, or to a new one the
  // person chose to move them to.
  ipcMain.handle("connections:test", async (event, id: unknown, test: ConnectionTest): Promise<RuntimeProbe> => {
    trusted(event);
    if (!validConnectionId(id) || !book.get(id) || !test) throw new Error("This server is no longer listed.");
    const current = book.get(id)!;
    let baseUrl: string;
    try {
      baseUrl = validAddress(test.baseUrl);
      requireSecureAddress(baseUrl);
    } catch (error) {
      return { ok: false, reason: error instanceof InsecureAddressError ? "insecure" : "address" };
    }
    // Without consent, only secrets bound to exactly this address are used.
    const saved = test.moveSecrets ? vault.unbound(id) : vault.apply(id, { baseUrl, apiKey: "" });
    const connection: RuntimeConnection = {
      baseUrl,
      apiKey: typeof test.apiKey === "string" ? test.apiKey.trim() : saved.apiKey,
      headers: test.headers ? validHeaders(test.headers) : saved.headers,
      query: saved.query,
    };
    if (isBuiltinId(id)) return probeRuntime(current.kind, connection);
    return (await inspectServer(connection)).probe;
  });
}

/**
 * The saved connection for a request, with its secrets, location and label. Main process only. Throws
 * InsecureAddressError for a saved plain http:// address to another computer, so no request is sent.
 */
export function resolveConnection(id: string) {
  const resolved = book.resolve(id);
  return resolved ? { ...resolved, location: book.location(resolved.connection.baseUrl) } : undefined;
}
