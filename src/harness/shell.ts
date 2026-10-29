/**
 * Shell commands for the agent, run under macOS's sandbox (sandbox-exec) with a profile made from
 * the project's folder access:
 * - files are written only inside Read & write folders and a temporary folder of the command's own;
 * - nothing is read or written in No access folders, in secrets files (the patterns the file tools refuse) or in the
 *   person's credentials and app data (~/.ssh, ~/.aws, ~/.gnupg, keychains, browser and Endurance profiles);
 * - there is no network unless Internet Access is on;
 * - a command runs for at most TIMEOUT_MS, then its whole process group is stopped.
 * Which commands ask first follows the chat's approval mode (needsApproval). Commands run in a login shell, so the
 * person's PATH (Homebrew, toolchains) applies as in their terminal.
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SECRET_PATTERNS } from "./workspace-tools";
import { coveredBy } from "../lib/command-key";
import type { Approval } from "../lib/types";
import type { WorkspacePolicy } from "../lib/workspace-policy";

export const TIMEOUT_MS = 120_000;
/** Output kept for the chat; the model gets as much of its end as its room allows. */
const KEEP = 1_000_000;

/** Whether shell commands can run here: the sandbox they need is macOS's. */
export const shellAvailable = () => process.platform === "darwin";

// ---------------------------------------------------------------------------- approval

/** Commands that only read or check, which Approve for me runs without asking. Anything that chains, redirects or substitutes asks. */
const CHECKS: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|grep|rg|file|stat|du|tree|which|echo|date|whoami|uname)(\s|$)/,
  /^find(?!.*\s-(exec|execdir|delete|ok|okdir|fprint|fls|fprintf)\b)(\s|$)/,
  /^git\s+(status|diff|log|show|rev-parse|ls-files|blame|describe)(\s|$)/,
  /^git\s+branch(?!.*\s-[dDmMcC]\b)(\s|$)/,
  /^(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|typecheck|check|build))(\s|$)/,
  /^npx\s+tsc\s+--noEmit(\s|$)/,
  /^node\s+--test(\s|$)/,
  /^(python3?\s+-m\s+)?pytest(\s|$)/,
  /^go\s+(test|build|vet)(\s|$)/,
  /^cargo\s+(test|build|check|clippy)(\s|$)/,
  /^make\s+(test|check)(\s|$)/,
  /^swift\s+(test|build)(\s|$)/,
];

export function checkOnly(command: string) {
  const text = command.trim();
  if (!text || /[;&|<>`\n]|\$\(/.test(text)) return false;
  return CHECKS.some((pattern) => pattern.test(text));
}

/**
 * Ask asks for every command, Approve for me for all but checks, Full access never. `allowed` holds the command keys
 * the person chose Always allow for in this chat (lib/command-key); a command whose every part has one of them runs.
 */
export function needsApproval(mode: Approval | undefined, command: string, allowed: ReadonlySet<string>) {
  if (mode === "full" || coveredBy(command, allowed)) return false;
  if (mode === "auto") return !checkOnly(command);
  return true;
}

// ---------------------------------------------------------------------------- sandbox

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const escapeRegex = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * A gitignore-style secrets pattern as a path regex: a name, or a folder, anywhere inside a project folder. Only there:
 * the system's own certificates (/etc/ssl/cert.pem) must stay readable for HTTPS to work.
 */
function patternRegex(root: string, pattern: string) {
  const folder = pattern.endsWith("/");
  const body = escapeRegex(folder ? pattern.slice(0, -1) : pattern).replace(/\*/g, "[^/]*");
  return `^${escapeRegex(root)}/(.*/)?${body}${folder ? "/" : "$"}`;
}

/** The person's credentials and other apps' data, which no command reads. */
const PRIVATE = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".kube",
  ".docker",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/Endurance",
  "Library/Application Support/Endurance Dev",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Safari",
];

export interface SandboxPaths {
  /** The project's folders, whatever their access (real paths); secrets files inside them are not read. */
  projects: string[];
  /** Folders a command may write in. */
  writable: string[];
  /** Folders inside writable ones that are only read. */
  readOnly: string[];
  /** Folders nothing may read or write. */
  blocked: string[];
  tmp: string;
  home: string;
  network: boolean;
}

/** The sandbox profile. Later rules win, so each narrower rule comes after the wider one it limits. */
export function sandboxProfile(paths: SandboxPaths) {
  const subpaths = (list: string[]) => list.map((item) => `(subpath ${quote(item)})`).join(" ");
  const regexes = (patterns: string[]) => paths.projects.flatMap((root) => patterns.map((item) => `(regex ${quote(patternRegex(root, item))})`)).join(" ");
  const secrets = regexes(SECRET_PATTERNS.filter((item) => !item.startsWith("!")));
  const exceptions = regexes(SECRET_PATTERNS.filter((item) => item.startsWith("!")).map((item) => item.slice(1)));
  const privateDirs = PRIVATE.map((item) => path.join(paths.home, item));
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${subpaths([...paths.writable, paths.tmp])} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/(tty|ttys[0-9]+|fd/|ptmx|dtracehelper)"))`,
    paths.readOnly.length ? `(deny file-write* ${subpaths(paths.readOnly)})` : "",
    `(deny file-read* file-write* ${secrets} ${subpaths([...paths.blocked, ...privateDirs])})`,
    exceptions ? `(allow file-read* ${exceptions})` : "",
    paths.network ? "" : '(deny network-outbound (remote ip "*:*"))',
  ]
    .filter(Boolean)
    .join("\n");
}

/** The sandbox's folders from the project's access: Read & write folders, read-only rules inside them, No access ones. */
export function pathsOf(policy: WorkspacePolicy) {
  const writable = policy.folders.filter((folder) => folder.access === "write").map((folder) => folder.path);
  const readOnly = policy.rules.filter((rule) => rule.access === "read").map((rule) => rule.path);
  const blocked = [...policy.folders.filter((folder) => folder.access === "none").map((folder) => folder.path), ...policy.rules.filter((rule) => rule.access === "none").map((rule) => rule.path)];
  const projects = policy.folders.map((folder) => folder.path);
  return { projects, writable, readOnly, blocked };
}

// ---------------------------------------------------------------------------- running

export interface ShellResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  command: string;
  cwd: string;
  policy: WorkspacePolicy;
  network: boolean;
  signal: AbortSignal;
  /** The output so far, as it arrives. */
  onOutput?: (output: string) => void;
  timeoutMs?: number;
}

const real = (value: string) => realpath(value).catch(() => value);

/** The project's folder access as real paths, which is what the sandbox matches. Also used by the person's terminal. */
export async function realAccess(policy: WorkspacePolicy) {
  const access = pathsOf(policy);
  return {
    projects: await Promise.all(access.projects.map(real)),
    writable: await Promise.all(access.writable.map(real)),
    readOnly: await Promise.all(access.readOnly.map(real)),
    blocked: await Promise.all(access.blocked.map(real)),
  };
}

/** Apps started from the Dock get a minimal PATH; the login shell adds the person's, and Homebrew is added here. */
export const loginPath = () => ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");

/** Each running command's process group. Commands are detached, so without this they would outlive the chat process. */
const groups = new Set<number>();
/** Ends every running command at once, for when the chat process is about to end (an app quit). */
export function stopAllShells() {
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  groups.clear();
}

export async function runShell(options: RunOptions): Promise<ShellResult> {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "endurance-shell-")));
  const profile = sandboxProfile({ ...(await realAccess(options.policy)), tmp, home: os.homedir(), network: options.network });
  const env: NodeJS.ProcessEnv = {
    HOME: os.homedir(),
    USER: os.userInfo().username,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    PATH: loginPath(),
    TMPDIR: tmp,
    // Caches go to the command's own temporary folder, the only place outside the project it may write.
    XDG_CACHE_HOME: path.join(tmp, "cache"),
    npm_config_cache: path.join(tmp, "npm"),
    PIP_CACHE_DIR: path.join(tmp, "pip"),
    NO_COLOR: "1",
  };
  let output = "";
  let timedOut = false;
  try {
    return await new Promise<ShellResult>((resolve, reject) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-lc", options.command], { cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const group = child.pid;
      if (group !== undefined) groups.add(group);
      const stop = () => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          process.kill(-child.pid, "SIGTERM");
          setTimeout(() => child.exitCode === null && process.kill(-child.pid!, "SIGKILL"), 2000).unref();
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs ?? TIMEOUT_MS);
      const abort = () => stop();
      options.signal.addEventListener("abort", abort, { once: true });
      const take = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-KEEP);
        options.onOutput?.(output);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (group !== undefined) groups.delete(group);
        options.signal.removeEventListener("abort", abort);
        resolve({ output, exitCode: code, timedOut });
      });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
