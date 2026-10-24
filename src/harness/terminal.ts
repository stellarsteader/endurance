/**
 * The person's own terminal in a project: what the main process decides before a shell starts,
 * and what the terminal process keeps while it runs. Pure functions; nothing here starts a process.
 * - The renderer sends only a project ID, Internet Access as it is in the chat, and the window size. The shell is the
 *   person's login shell, in the project's first Read & write folder, else its first readable one.
 * - Sandboxed (the default) uses the agent's shell profile (./shell): writes only in Read & write folders and a
 *   temporary folder of the terminal's own, No access folders, secrets and credentials unreadable, network only with
 *   Internet Access. Its environment is the agent's, not the app's, and shell history goes to the temporary folder.
 * - Full access runs the shell as the person's own, with the app's environment (less Electron's own variables).
 * - Output is kept (the last megabyte) for when a window shows the terminal again, and the shell is paused while a
 *   window has more than a megabyte it has not drawn.
 */
import path from "node:path";
import { MAX_TERMINALS, MAX_WRITE, type TerminalMode } from "../lib/terminal-api";
import type { WorkspacePolicy } from "../lib/workspace-policy";
import { sandboxProfile, type SandboxPaths } from "./shell";

export { MAX_TERMINALS, MAX_WRITE };
/** Output kept per terminal and replayed when a window attaches again. */
export const KEEP_BYTES = 1024 * 1024;
/** Output a window may have outstanding before the shell is paused, and how little before it runs again. */
export const PAUSE_BYTES = 1024 * 1024;
export const RESUME_BYTES = 256 * 1024;
/** After SIGHUP, how long a shell and what it started get before SIGKILL. */
export const KILL_AFTER_MS = 2000;

// ---------------------------------------------------------------------------- requests

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const validProjectId = (value: unknown): value is string => typeof value === "string" && PROJECT_ID.test(value);
export const validTerminalId = (value: unknown): value is string => typeof value === "string" && TERMINAL_ID.test(value);

/** A window size in cells, whole and within what a screen can show; anything else is the classic 80 × 24. */
export function clampSize(cols: unknown, rows: unknown) {
  const fit = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
  return { cols: fit(cols, 2, 500, 80), rows: fit(rows, 1, 300, 24) };
}

/** The renderer's open request. Only these three fields are read; a command, arguments, environment or folder is ignored. */
export function openOptions(value: unknown) {
  const options = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { network: options.network === true, ...clampSize(options.cols, options.rows) };
}

/** Keystrokes or a pasted piece: text up to MAX_WRITE, or nothing. */
export const writeData = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length <= MAX_WRITE ? value : undefined);

/** Bytes a window drew: a whole positive number, or nothing. */
export const ackBytes = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 64 * PAUSE_BYTES ? value : undefined);

/** Whether another terminal may open in a project that has `running` open. */
export const roomFor = (running: number) => running < MAX_TERMINALS;

// ---------------------------------------------------------------------------- launch

/** The folder a terminal starts in: the first Read & write folder, else the first readable one; none without either. */
export function terminalCwd(policy: WorkspacePolicy | undefined) {
  const folders = policy?.folders ?? [];
  return (folders.find((folder) => folder.access === "write") ?? folders.find((folder) => folder.access === "read"))?.path;
}

/** The person's shell from the app's environment or account, if it is an absolute path; else zsh, macOS's default. */
export function pickShell(...candidates: (string | undefined)[]) {
  return candidates.find((item) => typeof item === "string" && path.isAbsolute(item) && !/\s/.test(item)) ?? "/bin/zsh";
}

/** Variables of the app itself (Electron, Vite, Node), which a shell of the person's should not inherit. */
const APP_VARIABLE = /^(ELECTRON_|ENDURANCE_|VITE_|NODE_OPTIONS$|NODE_ENV$|NO_COLOR$)/;

export interface LaunchInput {
  mode: TerminalMode;
  shell: string;
  cwd: string;
  network: boolean;
  home: string;
  user: string;
  /** The PATH a login shell starts from (shell.loginPath). */
  path: string;
  /** The app's environment; only full access uses it. */
  inherited: Record<string, string | undefined>;
  /** Sandboxed: the terminal's own temporary folder (a real path) and the project's access as real paths. */
  tmp?: string;
  access?: Omit<SandboxPaths, "tmp" | "home" | "network">;
}

export interface Launch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** What starts: the login shell, under sandbox-exec when sandboxed, with its environment. */
export function terminalLaunch(input: LaunchInput): Launch {
  const terminal = { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Endurance" };
  if (input.mode === "full") {
    const env = Object.fromEntries(Object.entries(input.inherited).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !APP_VARIABLE.test(entry[0])));
    return { file: input.shell, args: ["-l"], cwd: input.cwd, env: { ...env, HOME: input.home, USER: input.user, LOGNAME: input.user, SHELL: input.shell, LANG: env.LANG ?? "en_US.UTF-8", PATH: input.path, ...terminal } };
  }
  if (!input.tmp || !input.access) throw new Error("A sandboxed terminal needs its temporary folder and the project's access.");
  const tmp = input.tmp;
  const profile = sandboxProfile({ ...input.access, tmp, home: input.home, network: input.network });
  const env: Record<string, string> = {
    HOME: input.home,
    USER: input.user,
    LOGNAME: input.user,
    SHELL: input.shell,
    LANG: input.inherited.LANG ?? "en_US.UTF-8",
    PATH: input.path,
    TMPDIR: tmp,
    // As for the agent's commands: caches go to the terminal's own temporary folder, the only place outside the project it may write.
    XDG_CACHE_HOME: path.join(tmp, "cache"),
    npm_config_cache: path.join(tmp, "npm"),
    PIP_CACHE_DIR: path.join(tmp, "pip"),
    // History stays in the temporary folder: the sandbox cannot write ~/.zsh_history. bash reads HISTFILE; zsh needs ZDOTDIR (zshStartup).
    HISTFILE: path.join(tmp, path.basename(input.shell) === "zsh" ? ".zsh_history" : ".history"),
    ...(path.basename(input.shell) === "zsh" ? { ZDOTDIR: tmp } : {}),
    ...terminal,
  };
  return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, input.shell, "-l"], cwd: input.cwd, env };
}

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * zsh startup files for a sandboxed terminal, written to its temporary folder (ZDOTDIR). macOS's /etc/zshrc sets
 * HISTFILE to $ZDOTDIR/.zsh_history, so history and the completion cache land in the temporary folder; each file
 * runs the person's own file of the same name from `userDir` (their ZDOTDIR, else home), and HISTFILE is set
 * again after their .zshrc in case it names ~/.zsh_history, which the sandbox cannot write.
 */
export function zshStartup(userDir: string, tmp: string): Record<string, string> {
  const run = (name: string) => `[[ -r ${shQuote(path.join(userDir, name))} ]] && source ${shQuote(path.join(userDir, name))}`;
  return {
    ".zshenv": `${run(".zshenv")}\n`,
    ".zprofile": `${run(".zprofile")}\n`,
    ".zshrc": `${run(".zshrc")}\nHISTFILE=${shQuote(path.join(tmp, ".zsh_history"))}\n`,
    ".zlogin": `${run(".zlogin")}\n`,
  };
}

// ---------------------------------------------------------------------------- output

/** The last `limit` bytes of output, kept in the pieces it arrived in. */
export class OutputRing {
  private chunks: { text: string; bytes: number }[] = [];
  bytes = 0;
  constructor(readonly limit = KEEP_BYTES) {}

  push(text: string, bytes = Buffer.byteLength(text)) {
    if (bytes >= this.limit) {
      // One piece larger than everything kept: its end, cut on a character boundary.
      const tail = Buffer.from(text).subarray(-this.limit).toString("utf8").replace(/^�+/, "");
      this.chunks = [{ text: tail, bytes: Buffer.byteLength(tail) }];
      this.bytes = this.chunks[0].bytes;
      return;
    }
    this.chunks.push({ text, bytes });
    this.bytes += bytes;
    let drop = 0;
    while (this.bytes > this.limit) this.bytes -= this.chunks[drop++].bytes;
    if (drop) this.chunks = this.chunks.slice(drop);
  }

  text() {
    return this.chunks.map((chunk) => chunk.text).join("");
  }
}

/**
 * Byte-based flow control between a terminal and the window showing it. While no window is attached nothing is
 * counted (output only goes to the kept ring), so a terminal nobody is looking at keeps running.
 */
export class Flow {
  unacked = 0;
  paused = false;
  attached = false;
  constructor(
    readonly pauseAt = PAUSE_BYTES,
    readonly resumeAt = RESUME_BYTES,
  ) {}

  /** Output sent to the window; "pause" when the shell should wait for the window to catch up. */
  sent(bytes: number): "pause" | undefined {
    if (!this.attached) return undefined;
    this.unacked += bytes;
    if (this.paused || this.unacked < this.pauseAt) return undefined;
    this.paused = true;
    return "pause";
  }

  /** Output the window drew; "resume" once little enough is waiting. */
  acked(bytes: number): "resume" | undefined {
    this.unacked = Math.max(0, this.unacked - bytes);
    return this.release();
  }

  /** A window starts showing the terminal after drawing the kept output; nothing is outstanding. */
  attach() {
    this.attached = true;
    this.unacked = 0;
    return this.release();
  }

  detach() {
    this.attached = false;
    this.unacked = 0;
    return this.release();
  }

  private release(): "resume" | undefined {
    if (!this.paused || this.unacked > this.resumeAt) return undefined;
    this.paused = false;
    return "resume";
  }
}

// ---------------------------------------------------------------------------- terminal process messages

export type HostRequest =
  | ({ type: "open"; id: string; cols: number; rows: number } & Launch)
  | { type: "write"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "attach"; id: string }
  | { type: "detach"; id: string }
  | { type: "ack"; id: string; bytes: number }
  | { type: "close"; id: string }
  | { type: "shutdown" };

export type HostEvent =
  | { type: "started"; id: string }
  | { type: "data"; id: string; data: string; bytes: number }
  | { type: "replay"; id: string; replay: string; exitCode?: number | null }
  /** The shell ended. */
  | { type: "exit"; id: string; exitCode: number | null }
  | { type: "failed"; id: string; message: string };
