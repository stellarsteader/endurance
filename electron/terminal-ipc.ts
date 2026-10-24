/**
 * The person's terminals. This process decides everything about a terminal: the renderer names
 * a project and sends keystrokes, sizes and acknowledgements; the shell, its folder, sandbox and environment are
 * chosen here (src/harness/terminal), and the PTY runs in the terminal process (terminal-host). Output goes only to
 * the window that opened the terminal. Whether a project's terminals run with full access is kept here and only
 * turned on after the person confirms in a macOS dialog.
 */
import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, UtilityProcess, WebContents } from "electron";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { history } from "./history-ipc";
import { projectPolicy } from "./workspace-ipc";
import { loginPath, realAccess } from "../src/harness/shell";
import {
  ackBytes,
  openOptions,
  pickShell,
  roomFor,
  terminalCwd,
  terminalLaunch,
  validProjectId,
  validTerminalId,
  writeData,
  zshStartup,
  type HostEvent,
  type HostRequest,
  type Launch,
} from "../src/harness/terminal";
import type { TerminalAttach, TerminalEvent, TerminalInfo, TerminalMode } from "../src/lib/terminal-api";

type Trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => void;

interface Open {
  info: TerminalInfo;
  owner: WebContents;
  /** Whether output goes to the window now. */
  attached: boolean;
  /** A sandboxed terminal's temporary folder, removed once its shell is gone. */
  tmp?: string;
}

const terminals = new Map<string, Open>();
/** Temporary folders of closed terminals whose shells are still ending. */
const ending = new Map<string, string>();
/** Attach requests waiting for the terminal process's kept output. */
const replays = new Map<string, (value: TerminalAttach) => void>();
/** Opens waiting to hear whether the shell started. */
const starting = new Map<string, (error?: Error) => void>();
let host: UtilityProcess | undefined;

// ---------------------------------------------------------------------------- full access, kept by this process

const settingsFile = () => path.join(app.getPath("userData"), "terminal.json");
let fullAccess: Set<string> | undefined;
async function loadAccess() {
  if (fullAccess) return fullAccess;
  try {
    const value = JSON.parse(await readFile(settingsFile(), "utf8")) as { fullAccess?: unknown };
    fullAccess = new Set(Array.isArray(value.fullAccess) ? value.fullAccess.filter(validProjectId) : []);
  } catch {
    fullAccess = new Set();
  }
  return fullAccess;
}
async function saveAccess(projects: Set<string>) {
  await writeFile(settingsFile(), JSON.stringify({ fullAccess: [...projects] }, null, 2), { mode: 0o600 });
}
/** A project's mode. A removed project's switch is forgotten, so a project restored later starts sandboxed. */
async function modeOf(projectId: string): Promise<TerminalMode> {
  const projects = await loadAccess();
  if (!projects.has(projectId)) return "sandboxed";
  if (await history("project", projectId)) return "full";
  projects.delete(projectId);
  await saveAccess(projects);
  return "sandboxed";
}

// ---------------------------------------------------------------------------- terminal process

const toOwner = (open: Open, event: TerminalEvent) => {
  if (!open.owner.isDestroyed()) open.owner.send("terminal:event", event);
};
const removeTemp = (tmp: string | undefined) => {
  if (tmp) void rm(tmp, { recursive: true, force: true });
};

function terminalHost() {
  if (host) return host;
  const child = utilityProcess.fork(path.join(import.meta.dirname, "terminal-host.js"), [], { serviceName: "Endurance terminal", stdio: "pipe" });
  child.on("message", (event: HostEvent) => {
    const open = terminals.get(event.id);
    if (event.type === "started" || event.type === "failed") {
      starting.get(event.id)?.(event.type === "failed" ? new Error(event.message) : undefined);
      starting.delete(event.id);
      return;
    }
    if (event.type === "replay") {
      replays.get(event.id)?.({ replay: event.replay, ...("exitCode" in event ? { exitCode: event.exitCode } : {}) });
      replays.delete(event.id);
      if (open) open.attached = true;
      return;
    }
    if (event.type === "exit") {
      if (open) {
        open.info.exitCode = event.exitCode;
        toOwner(open, { id: event.id, type: "exit", exitCode: event.exitCode });
        removeTemp(open.tmp);
        open.tmp = undefined;
      }
      removeTemp(ending.get(event.id));
      ending.delete(event.id);
      return;
    }
    if (open?.attached) toOwner(open, event);
  });
  child.once("exit", () => {
    host = undefined;
    for (const [id, open] of terminals) {
      if (open.info.exitCode === undefined) {
        open.info.exitCode = null;
        toOwner(open, { id, type: "exit", exitCode: null });
      }
      removeTemp(open.tmp);
      open.tmp = undefined;
    }
    for (const tmp of ending.values()) removeTemp(tmp);
    ending.clear();
    for (const settle of starting.values()) settle(new Error("The terminal process stopped."));
    starting.clear();
    for (const settle of replays.values()) settle({ replay: "", exitCode: null });
    replays.clear();
  });
  // Terminal output is the person's; it is never logged.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  host = child;
  return child;
}

const post = (request: HostRequest) => host?.postMessage(request);

function close(id: string) {
  const open = terminals.get(id);
  if (!open) return;
  terminals.delete(id);
  replays.get(id)?.({ replay: "", exitCode: null });
  replays.delete(id);
  // A shell still running is ended first; its temporary folder goes when it has.
  if (open.info.exitCode === undefined && host && open.tmp) ending.set(id, open.tmp);
  else removeTemp(open.tmp);
  post({ type: "close", id });
}

/** Ends a window's terminals when it closes or its page crashes; detaches them when it reloads. */
const watched = new WeakSet<WebContents>();
function watch(owner: WebContents) {
  if (watched.has(owner)) return;
  watched.add(owner);
  const closeOwned = () => {
    for (const [id, open] of terminals) if (open.owner === owner) close(id);
  };
  owner.once("destroyed", closeOwned);
  owner.on("render-process-gone", closeOwned);
  owner.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    for (const [id, open] of terminals)
      if (open.owner === owner && open.attached) {
        open.attached = false;
        post({ type: "detach", id });
      }
  });
}

/** Whether the terminal process is running (an app quit then waits for it). */
export const terminalsRunning = () => host !== undefined;

/** The app is quitting: every shell gets SIGHUP, then SIGKILL after two seconds, then the terminal process ends. */
export function stopTerminals() {
  const child = host;
  if (!child) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      for (const open of terminals.values()) if (open.tmp) rmSync(open.tmp, { recursive: true, force: true });
      for (const tmp of ending.values()) rmSync(tmp, { recursive: true, force: true });
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 3000);
    child.once("exit", finish);
    child.postMessage({ type: "shutdown" } satisfies HostRequest);
  });
}

// ---------------------------------------------------------------------------- IPC

/** The terminal, when it belongs to the window asking. */
function owned(event: IpcMainInvokeEvent | IpcMainEvent, id: unknown) {
  const open = validTerminalId(id) ? terminals.get(id) : undefined;
  return open && open.owner === event.sender ? open : undefined;
}

async function openTerminal(event: IpcMainInvokeEvent, projectId: unknown, value: unknown): Promise<TerminalInfo> {
  if (process.platform !== "darwin") throw new Error("The terminal is available on macOS only for now.");
  if (!validProjectId(projectId)) throw new Error("Invalid project");
  const options = openOptions(value);
  const policy = await projectPolicy(projectId);
  const cwd = terminalCwd(policy);
  if (!policy || !cwd) throw new Error("Add a folder to this project to open a terminal there.");
  const full = () => !roomFor([...terminals.values()].filter((open) => open.info.projectId === projectId && open.info.exitCode === undefined).length);
  if (full()) throw new Error("Close a terminal in this project to open another.");
  const mode = await modeOf(projectId);
  const shell = pickShell(process.env.SHELL, os.userInfo().shell ?? undefined);
  const home = os.homedir();
  const base = { mode, shell, cwd, network: options.network, home, user: os.userInfo().username, path: loginPath(), inherited: process.env };
  let tmp: string | undefined;
  let launch: Launch;
  if (mode === "sandboxed") {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "endurance-terminal-")));
    if (path.basename(shell) === "zsh")
      for (const [name, text] of Object.entries(zshStartup(process.env.ZDOTDIR || home, tmp))) await writeFile(path.join(tmp, name), text, { mode: 0o600 });
    launch = terminalLaunch({ ...base, tmp, access: await realAccess(policy) });
  } else launch = terminalLaunch(base);
  // Counted again: another request may have opened one while this one was preparing.
  if (full()) {
    removeTemp(tmp);
    throw new Error("Close a terminal in this project to open another.");
  }
  const id = crypto.randomUUID();
  const info: TerminalInfo = { id, projectId, title: path.basename(shell), cwd, mode, network: mode === "full" || options.network };
  const child = terminalHost();
  watch(event.sender);
  terminals.set(id, { info, owner: event.sender, attached: false, tmp });
  try {
    // Listed once the terminal process says the shell started.
    await new Promise<void>((resolve, reject) => {
      starting.set(id, (error) => (error ? reject(error) : resolve()));
      child.postMessage({ type: "open", id, cols: options.cols, rows: options.rows, ...launch } satisfies HostRequest);
      setTimeout(() => {
        if (starting.delete(id)) reject(new Error("The terminal did not start."));
      }, 10_000);
    });
  } catch (error) {
    terminals.delete(id);
    removeTemp(tmp);
    throw error;
  }
  return info;
}

async function confirmFullAccess(event: IpcMainInvokeEvent, projectId: string) {
  const project = await history("project", projectId);
  if (!project) throw new Error("Invalid project");
  const window = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Cancel", "Run With My Permissions"],
    defaultId: 0,
    cancelId: 0,
    message: `Let terminals in “${project.name}” run with your full permissions?`,
    detail:
      "New terminals in this project will run outside the sandbox, like Terminal does: they can read ~/.ssh and your other files, change anything your account can, and use the network. Terminals already open keep running as they started.",
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return response === 1;
}

export function registerTerminalIPC(trusted: Trusted) {
  ipcMain.handle("terminal:access", async (event, projectId: unknown) => {
    trusted(event);
    if (!validProjectId(projectId)) throw new Error("Invalid project");
    return modeOf(projectId);
  });
  // Only this process turns full access on, and only after the person confirms in the dialog it shows.
  ipcMain.handle("terminal:request-full-access", async (event, projectId: unknown) => {
    trusted(event);
    if (!validProjectId(projectId)) throw new Error("Invalid project");
    if ((await modeOf(projectId)) === "full") return "full";
    if (!(await confirmFullAccess(event, projectId))) return "sandboxed";
    const projects = await loadAccess();
    projects.add(projectId);
    await saveAccess(projects);
    return "full";
  });
  ipcMain.handle("terminal:use-sandbox", async (event, projectId: unknown) => {
    trusted(event);
    if (!validProjectId(projectId)) throw new Error("Invalid project");
    const projects = await loadAccess();
    if (projects.delete(projectId)) await saveAccess(projects);
    return "sandboxed";
  });
  ipcMain.handle("terminal:list", (event, projectId: unknown) => {
    trusted(event);
    if (!validProjectId(projectId)) throw new Error("Invalid project");
    return [...terminals.values()].filter((open) => open.owner === event.sender && open.info.projectId === projectId).map((open) => open.info);
  });
  ipcMain.handle("terminal:open", (event, projectId: unknown, options: unknown) => {
    trusted(event);
    return openTerminal(event, projectId, options);
  });
  ipcMain.handle("terminal:attach", (event, id: unknown) => {
    trusted(event);
    const open = owned(event, id);
    if (!open || !host) throw new Error("This terminal is closed.");
    return new Promise<TerminalAttach>((resolve) => {
      replays.get(open.info.id)?.({ replay: "", exitCode: open.info.exitCode });
      replays.set(open.info.id, resolve);
      post({ type: "attach", id: open.info.id });
    });
  });
  ipcMain.handle("terminal:close", (event, id: unknown) => {
    trusted(event);
    if (owned(event, id)) close(id as string);
  });
  ipcMain.on("terminal:detach", (event, id: unknown) => {
    trusted(event);
    const open = owned(event, id);
    if (!open) return;
    open.attached = false;
    post({ type: "detach", id: open.info.id });
  });
  ipcMain.on("terminal:write", (event, id: unknown, data: unknown) => {
    trusted(event);
    const open = owned(event, id);
    const text = writeData(data);
    if (open && text !== undefined && open.info.exitCode === undefined) post({ type: "write", id: open.info.id, data: text });
  });
  ipcMain.on("terminal:resize", (event, id: unknown, cols: unknown, rows: unknown) => {
    trusted(event);
    const open = owned(event, id);
    if (open && open.info.exitCode === undefined && typeof cols === "number" && typeof rows === "number") {
      const size = openOptions({ cols, rows });
      post({ type: "resize", id: open.info.id, cols: size.cols, rows: size.rows });
    }
  });
  ipcMain.on("terminal:ack", (event, id: unknown, bytes: unknown) => {
    trusted(event);
    const open = owned(event, id);
    const count = ackBytes(bytes);
    if (open && count !== undefined) post({ type: "ack", id: open.info.id, bytes: count });
  });
}
