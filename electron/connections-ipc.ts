/**
 * Connections IPC. The main process owns every saved connection: the renderer names one by ID, sees only
 * whether secrets exist, and receives the list and catalog as pushed snapshots.
 */
import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { detectRuntimes, discoverModels, inspectServer, probeRuntime } from "../src/harness/runtime";
import { connectionState, isBuiltinId, isOwner, parseServerInput, validConnectionId, type LegacySettings } from "../src/lib/connections";
import { sameAddress } from "../src/lib/connection-vault";
import { isRuntimeId, type RuntimeConnection } from "../src/lib/models";
import type { CatalogResult, ConnectionEdit, ConnectionTest, RuntimeProbe, ServerCheck, ServerDraft } from "../src/lib/desktop";
import { validHeaders, validQuery, vault } from "./connection-secrets";
import { book } from "./connection-store";
import { vllmServerInfo, type ServerInfo } from "../src/harness/server-info";

type Trust = (event: IpcMainInvokeEvent | IpcMainEvent) => void;

const catalog = new Map<string, CatalogResult>();
// A starting server is checked again on its own, slower each time, until it answers or fails otherwise.
const RECHECK_SECONDS = [5, 10, 20, 30, 60];
const rechecks = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();

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
  const resolved = book.resolve(id);
  if (!resolved) {
    catalog.delete(id);
    schedule(id, false);
    return;
  }
  const location = await book.locate(resolved.connection.baseUrl);
  const result = await discoverModels(resolved.runtime, resolved.value, { connectionId: id, label: resolved.label, location });
  // Ended compares with history from before this answer.
  const state = connectionState(result, resolved.connection);
  if (state === "connected") book.markConnected(id);
  catalog.set(id, { ...result, state });
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
  return { connection, name: typeof draft.name === "string" ? draft.name.trim().slice(0, 80) : "", concurrency: optionalNumber(draft.concurrency, 1, 64) };
}

async function checkServer(draft: ServerDraft, save: boolean): Promise<ServerCheck> {
  const { connection, name, concurrency } = readDraft(draft);
  const inspection = await inspectServer(connection);
  const listed = book.list().find((item) => sameAddress(item.baseUrl, inspection.baseUrl));
  if (listed) return { ...inspection, duplicate: book.view(listed).label };
  if (!save || !(inspection.probe.ok || inspection.probe.reason === "starting")) return inspection;
  const added = book.add({ kind: inspection.kind, baseUrl: inspection.baseUrl, name, concurrency });
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
  ipcMain.handle("connections:detect", async (event) => {
    trusted(event);
    const listed = [...book.list().map((item) => item.id).filter(isBuiltinId), ...book.dismissed()];
    const found = await detectRuntimes(listed);
    const added = found.map((id) => book.addBuiltin(id, false)).filter((item) => item !== undefined);
    if (!added.length) return;
    await pushConnections();
    await refresh(added.map((item) => item.id));
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
    let kind = current.kind;
    // An added server at a new address is identified again; a builtin connection stays its runtime.
    if (moved && !isBuiltinId(id)) {
      const secrets = edit.moveSecrets ? vault.unbound(id) : vault.apply(id, { baseUrl, apiKey: "" });
      const typed = edit.apiKey && "replace" in edit.apiKey ? edit.apiKey.replace : undefined;
      const inspection = await inspectServer({ baseUrl, ...secrets, apiKey: typed ?? secrets.apiKey ?? "" });
      if (inspection.probe.ok) kind = inspection.kind;
    }
    const patch: Parameters<typeof book.update>[1] = { baseUrl, kind };
    if ("name" in edit) patch.name = typeof edit.name === "string" ? edit.name : undefined;
    if ("concurrency" in edit) patch.concurrency = optionalNumber(edit.concurrency, 1, 64);
    if ("owner" in edit) patch.owner = isOwner(edit.owner) ? edit.owner : undefined;
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
    const resolved = validConnectionId(id) ? book.resolve(id) : undefined;
    if (!resolved || resolved.runtime !== "vllm") return undefined;
    return vllmServerInfo(resolved.value, book.view(resolved.connection).mine);
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
    } catch {
      return { ok: false, reason: "address" };
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

/** The saved connection for a request, with its secrets, location and label. Main process only. */
export function resolveConnection(id: string) {
  const resolved = book.resolve(id);
  return resolved ? { ...resolved, location: book.location(resolved.connection.baseUrl) } : undefined;
}
