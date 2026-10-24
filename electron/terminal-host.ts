/**
 * The person's terminals, in a process of their own so a native PTY never runs in the main
 * process. The main process decides what starts (src/harness/terminal); this process only runs it, keeps the last
 * megabyte of output, pauses a shell while the window is behind, and ends shells with everything they started.
 */
import * as nodePty from "@lydell/node-pty";
import { spawnSync } from "node:child_process";
import { Flow, KILL_AFTER_MS, OutputRing, type HostEvent, type HostRequest } from "../src/harness/terminal";

interface Session {
  pty: nodePty.IPty;
  ring: OutputRing;
  flow: Flow;
  /** Output waiting to go to the window in one message. */
  pending: string;
  pendingBytes: number;
  timer?: ReturnType<typeof setTimeout>;
  exitCode?: number | null;
  exited: boolean;
}

const sessions = new Map<string, Session>();
const send = (event: HostEvent) => process.parentPort.postMessage(event);

function flush(id: string, session: Session) {
  clearTimeout(session.timer);
  session.timer = undefined;
  if (!session.pending) return;
  send({ type: "data", id, data: session.pending, bytes: session.pendingBytes });
  session.pending = "";
  session.pendingBytes = 0;
}

/** Drops output waiting to be sent; it is in the kept output already. */
function drop(session: Session) {
  clearTimeout(session.timer);
  session.timer = undefined;
  session.pending = "";
  session.pendingBytes = 0;
}

/** Every process on the shell's terminal, its jobs in their own process groups included, and the shell's group. */
function members(session: Session) {
  const pids = new Set<number>([session.pty.pid]);
  const tty = (session.pty as unknown as { ptsName?: string }).ptsName;
  if (tty) {
    const found = spawnSync("/usr/bin/pgrep", ["-t", tty.replace(/^\/dev\//, "")], { encoding: "utf8" });
    for (const line of (found.stdout ?? "").split("\n")) if (/^\d+$/.test(line.trim())) pids.add(Number(line));
  }
  return [...pids].filter((pid) => pid > 1 && pid !== process.pid);
}

function signal(pids: number[], group: number, name: NodeJS.Signals) {
  for (const target of [-group, ...pids]) {
    try {
      process.kill(target, name);
    } catch {
      // Already gone.
    }
  }
}

/**
 * SIGHUP to the shell and everything on its terminal, then SIGKILL to what is left after KILL_AFTER_MS. The processes
 * are listed now, while the terminal is still open, so a terminal name used again later is never signalled.
 */
function end(session: Session) {
  const pids = members(session);
  const group = session.pty.pid;
  drop(session);
  signal(pids, group, "SIGHUP");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      signal(pids, group, "SIGKILL");
      resolve();
    }, KILL_AFTER_MS);
  });
}

function open(request: Extract<HostRequest, { type: "open" }>) {
  if (sessions.has(request.id)) return;
  let pty: nodePty.IPty;
  try {
    pty = nodePty.spawn(request.file, request.args, { name: "xterm-256color", cols: request.cols, rows: request.rows, cwd: request.cwd, env: request.env });
  } catch (error) {
    send({ type: "failed", id: request.id, message: error instanceof Error ? error.message : "The shell did not start." });
    return;
  }
  const session: Session = { pty, ring: new OutputRing(), flow: new Flow(), pending: "", pendingBytes: 0, exited: false };
  sessions.set(request.id, session);
  send({ type: "started", id: request.id });
  pty.onData((data) => {
    const bytes = Buffer.byteLength(data);
    session.ring.push(data, bytes);
    // Nobody is looking: output is only kept, and the shell runs on.
    if (!session.flow.attached) return;
    session.pending += data;
    session.pendingBytes += bytes;
    if (session.flow.sent(bytes) === "pause") pty.pause();
    // Small pieces go together, a few milliseconds apart; a large backlog goes at once.
    if (session.pendingBytes >= 64 * 1024) flush(request.id, session);
    else session.timer ??= setTimeout(() => flush(request.id, session), 4);
  });
  pty.onExit(({ exitCode, signal: killed }) => {
    flush(request.id, session);
    session.exited = true;
    session.exitCode = killed ? null : exitCode;
    send({ type: "exit", id: request.id, exitCode: session.exitCode });
  });
}

process.parentPort.on("message", ({ data }: { data: HostRequest }) => {
  if (data.type === "shutdown") {
    // The app is quitting: every shell ends (SIGHUP, then SIGKILL), then this process.
    const running = [...sessions].filter(([, session]) => !session.exited);
    void Promise.all(running.map(([, session]) => end(session))).then(() => process.exit(0));
    if (!running.length) process.exit(0);
    return;
  }
  if (data.type === "open") return open(data);
  const session = sessions.get(data.id);
  if (!session) return;
  switch (data.type) {
    case "write":
      if (!session.exited) session.pty.write(data.data);
      return;
    case "resize":
      if (!session.exited) session.pty.resize(data.cols, data.rows);
      return;
    case "attach": {
      // What was waiting is in the kept output, which the window draws first.
      drop(session);
      if (session.flow.attach() === "resume") session.pty.resume();
      send({ type: "replay", id: data.id, replay: session.ring.text(), ...(session.exited ? { exitCode: session.exitCode } : {}) });
      return;
    }
    case "detach":
      drop(session);
      if (session.flow.detach() === "resume") session.pty.resume();
      return;
    case "ack":
      if (session.flow.acked(data.bytes) === "resume") session.pty.resume();
      return;
    case "close":
      sessions.delete(data.id);
      if (!session.exited) void end(session);
      return;
  }
});
