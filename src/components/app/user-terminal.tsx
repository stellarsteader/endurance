"use client";

/**
 * The person's own terminal: the Shell view of the workspace Terminal tab, and the project
 * setting that lets its terminals run with the person's full permissions. Everything about what runs is decided by
 * the main process (electron/terminal-ipc); this file draws output and sends keystrokes.
 */
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ipcMessage } from "@/lib/desktop";
import { useStore, type Project } from "@/lib/store";
import { MAX_TERMINALS, MAX_WRITE, type TerminalEvent, type TerminalInfo, type TerminalMode } from "@/lib/terminal-api";
import { cn } from "@/lib/utils";
import { folderName } from "@/lib/workspace-policy";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FolderIcon, PlusIcon, ShieldCheckIcon, ShieldOffIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useSession } from "./session-context";

/** The terminal bridge; only on macOS, where the sandbox is. */
export const terminalApi = () => (typeof window === "undefined" ? undefined : window.enduranceTerminal);

/** The folder a project's terminal starts in, as the main process picks it: first Read & write, else first readable. */
const startFolder = (project: Project | undefined) => {
  const folders = project?.access?.folders ?? [];
  return (folders.find((folder) => folder.access === "write") ?? folders.find((folder) => folder.access === "read"))?.path;
};

/** A CSS color (the design tokens are oklch) as rgb, which xterm reads: drawn once on a 1×1 canvas. */
function rgb(color: string, alpha = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !color) return undefined;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Background, text and selection from the design tokens, so the terminal follows light and dark like the rest. */
function themeOf(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const background = rgb(token("--background"));
  const foreground = rgb(token("--foreground"));
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: rgb(token("--ring"), 0.35),
    selectionInactiveBackground: rgb(token("--ring"), 0.2),
  };
}

/** Text in pieces the main process accepts, never splitting a character in two. */
function pieces(text: string) {
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + MAX_WRITE);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function Note({ icon, title, hint, children }: { icon: ReactNode; title: string; hint: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <div className="font-medium text-sm">{title}</div>
      <p className="max-w-64 text-muted-foreground text-xs">{hint}</p>
      {children}
    </div>
  );
}

/** One terminal on screen: its kept output first, then what arrives; drawn output is acknowledged so the shell runs on. */
function TerminalScreen({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    const api = terminalApi();
    const element = ref.current;
    if (!api || !element) return;
    const term = new Xterm({
      fontFamily: getComputedStyle(element).fontFamily,
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeOf(element),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const resize = () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet.
      }
    };
    resize();

    let disposed = false;
    let ready = false;
    const early: TerminalEvent[] = [];
    let acked = 0;
    let ackTimer: number | undefined;
    const sendAck = () => {
      window.clearTimeout(ackTimer);
      ackTimer = undefined;
      if (acked) api.ack(id, acked);
      acked = 0;
    };
    const drawn = (bytes: number) => {
      acked += bytes;
      if (acked >= 64 * 1024) sendAck();
      else ackTimer ??= window.setTimeout(sendAck, 30);
    };
    const ended = (code: number | null) => term.write(`\r\n\x1b[2m[Process exited${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`);
    const handle = (event: TerminalEvent) => {
      if (event.type === "data") term.write(event.data, () => !disposed && drawn(event.bytes));
      else ended(event.exitCode);
    };
    const unsubscribe = api.onEvent((event) => {
      if (event.id !== id || disposed) return;
      if (ready) handle(event);
      else early.push(event);
    });
    api.attach(id).then(
      (attached) => {
        if (disposed) return;
        if (attached.replay) term.write(attached.replay);
        if (attached.exitCode !== undefined) ended(attached.exitCode);
        ready = true;
        for (const event of early.splice(0)) handle(event);
        api.resize(id, term.cols, term.rows);
      },
      (error: Error) => !disposed && setFailed(ipcMessage(error)),
    );
    const input = term.onData((data) => {
      for (const part of pieces(data)) api.write(id, part);
    });
    const sized = term.onResize(({ cols, rows }) => api.resize(id, cols, rows));
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    // Light and dark switch by a class on the root element.
    const themes = new MutationObserver(() => {
      term.options.theme = themeOf(element);
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    term.focus();
    return () => {
      disposed = true;
      sendAck();
      unsubscribe();
      input.dispose();
      sized.dispose();
      observer.disconnect();
      themes.disconnect();
      api.detach(id);
      term.dispose();
    };
  }, [id]);
  if (failed) return <Note hint={failed} icon={<SquareTerminalIcon className="size-6" />} title="This terminal is closed" />;
  return <div className="min-h-0 flex-1 bg-background px-2 pt-1.5 font-mono" ref={ref} />;
}

function ModeLabel({ info }: { info: TerminalInfo }) {
  const full = info.mode === "full";
  const Icon = full ? ShieldOffIcon : ShieldCheckIcon;
  return (
    <span
      className={cn("flex items-center gap-1", full && "text-amber-600 dark:text-amber-400")}
      title={
        full
          ? "Runs with your full permissions: your files, ~/.ssh and the network."
          : `Writes only in Read & write folders; No access folders and secrets stay unreadable${info.network ? "" : "; no internet (Internet Access was off when it opened)"}.`
      }
    >
      <Icon className="size-3.5" />
      {full ? "Full access" : info.network ? "Sandboxed" : "Sandboxed · offline"}
    </span>
  );
}

function ProjectShells({ projectId, network, visible }: { projectId: string; network: boolean; visible: boolean }) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>();
  const [selected, setSelected] = useState<string>();
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    const api = terminalApi();
    if (!api) return;
    let current = true;
    api.list(projectId).then(
      (list) => current && setTerminals(list),
      () => current && setTerminals([]),
    );
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "exit") setTerminals((list) => list?.map((item) => (item.id === event.id ? { ...item, exitCode: event.exitCode } : item)));
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [projectId]);

  const open = async () => {
    const api = terminalApi();
    if (!api || opening) return;
    setOpening(true);
    try {
      // The size is set again once the terminal is on screen.
      const info = await api.open(projectId, { network, cols: 80, rows: 24 });
      setTerminals((list) => [...(list ?? []), info]);
      setSelected(info.id);
    } catch (error) {
      toast.error(error instanceof Error ? ipcMessage(error) : "Couldn't open a terminal");
    } finally {
      setOpening(false);
    }
  };
  const close = async (id: string) => {
    await terminalApi()?.close(id).catch(() => undefined);
    setTerminals((list) => list?.filter((item) => item.id !== id));
  };

  if (!terminals) return null;
  const current = terminals.find((item) => item.id === selected) ?? terminals[terminals.length - 1];
  const running = terminals.filter((item) => item.exitCode === undefined).length;
  if (!current) {
    return (
      <Note hint="Your login shell, in this project's folder. It runs sandboxed unless the project settings say otherwise." icon={<SquareTerminalIcon className="size-6" />} title="No terminal open">
        <Button className="mt-1 h-7 rounded-[6px] text-[12px]" disabled={opening} onClick={() => void open()} variant="outline">
          Open terminal
        </Button>
      </Note>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b px-2">
        {terminals.map((item, index) => (
          <div
            className={cn(
              "flex h-6 items-center rounded-[4px] text-[12px] leading-[1.35]",
              item.id === current.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
            key={item.id}
          >
            <button className="flex h-6 items-center gap-1 pl-2 outline-none" onClick={() => setSelected(item.id)} type="button">
              {item.title}
              {index ? ` ${index + 1}` : ""}
              {item.exitCode !== undefined && <span className="text-muted-foreground">· ended</span>}
            </button>
            <button
              aria-label="Close terminal"
              className="mx-0.5 flex size-5 items-center justify-center rounded-[3px] text-muted-foreground outline-none hover:bg-background hover:text-foreground"
              onClick={() => void close(item.id)}
              title="Close terminal"
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
        <Button
          aria-label="New terminal"
          className="size-6 rounded-[4px]"
          disabled={opening || running >= MAX_TERMINALS}
          onClick={() => void open()}
          size="icon"
          title={running >= MAX_TERMINALS ? `Up to ${MAX_TERMINALS} terminals per project` : "New terminal"}
          variant="ghost"
        >
          <PlusIcon className="size-3.5" />
        </Button>
        <div className="ml-auto flex min-w-0 items-center gap-2.5 text-[11px] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1" title={current.cwd}>
            <FolderIcon className="size-3.5 shrink-0" />
            <span className="truncate">{folderName(current.cwd)}</span>
          </span>
          <ModeLabel info={current} />
        </div>
      </div>
      {visible && <TerminalScreen id={current.id} key={current.id} />}
    </div>
  );
}

/** The Shell view: the chat's project terminals, or what is needed for one. */
export function ShellView() {
  const { thread, active } = useSession();
  const { projects, settings } = useStore();
  const project = projects.find((item) => item.id === thread.projectId);
  if (!project || !startFolder(project)) {
    return (
      <Note
        hint={project ? "Add a folder to this project in its settings to open a terminal there." : "Move this chat into a project with a folder to open a terminal there."}
        icon={<SquareTerminalIcon className="size-6" />}
        title="The terminal needs a project folder"
      />
    );
  }
  // Only the chat on screen draws the terminal; chats in the background stay mounted.
  return <ProjectShells key={project.id} network={settings.webSearch} projectId={project.id} visible={active} />;
}

/**
 * The project setting. Off (the default), terminals are sandboxed; turning it on asks in a macOS dialog shown by the
 * main process, which is the only place it can be turned on. It applies to terminals opened afterwards.
 */
export function TerminalAccessSetting({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<TerminalMode>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    terminalApi()
      ?.access(projectId)
      .then(
        (value) => current && setMode(value),
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [projectId]);
  const api = terminalApi();
  if (!api) return null;
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-[13px] leading-[1.4]">Terminal runs with your full permissions</div>
        <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">
          Off, the terminal is sandboxed like the agent&apos;s commands. On, it can reach ~/.ssh, the network and everything your
          account can. Applies right away, to terminals opened after.
        </div>
      </div>
      <Switch
        aria-label="Terminal runs with your full permissions"
        checked={mode === "full"}
        disabled={!mode || busy}
        onCheckedChange={async (value) => {
          setBusy(true);
          try {
            setMode(value ? await api.requestFullAccess(projectId) : await api.useSandbox(projectId));
          } catch (error) {
            toast.error(error instanceof Error ? ipcMessage(error) : "Couldn't change this setting");
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
