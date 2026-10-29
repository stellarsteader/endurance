"use client";

import { DiffView } from "./diff-view";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import {
  Terminal,
  TerminalActions,
  TerminalClearButton,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { deriveWorkspace, type WorkspaceData } from "@/lib/derive";
import type { WorkspaceTab } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  BookOpenIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  FileDiffIcon,
  ListChecksIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { TestRunView } from "./message-parts";
import { useSession } from "./session-context";
import { AgentList, AgentThread } from "./subagents";
import { UndoFileEdits } from "./undo-edits";
import { ShellView, terminalApi } from "./user-terminal";

function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <div className="font-medium text-sm">{title}</div>
      <p className="max-w-64 text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}

function AgentsTab({ ws }: { ws: WorkspaceData }) {
  if (ws.subagents.length === 0) {
    return (
      <Empty
        hint="When work is split, each agent is listed here. Open one to read its thread."
        icon={<BotIcon className="size-6" />}
        title="No agents yet"
      />
    );
  }
  return (
    <div className="px-4 py-4">
      <AgentList agents={ws.subagents} />
    </div>
  );
}

function TasksTab({ ws }: { ws: WorkspaceData }) {
  if (!ws.todos && !ws.plan) {
    return (
      <Empty
        hint="Agent to-dos and plans appear here as the run progresses."
        icon={<ListChecksIcon className="size-6" />}
        title="No tasks"
      />
    );
  }
  const done = ws.todos?.items.filter((t) => t.status === "completed").length ?? 0;
  return (
    <div className="px-4 py-4">
      {ws.todos && (
        <div>
          <div className="px-2 pb-2 text-[13px] leading-[1.4] text-muted-foreground">
            To-dos · {done} of {ws.todos.items.length}
          </div>
          <ul>
            {ws.todos.items.map((t) => (
              <li className="flex h-7 items-center gap-2 px-2 text-[13px] leading-[1.4]" key={t.id}>
                {t.status === "completed" ? (
                  <CheckCircle2Icon className="size-[15px] text-emerald-500" />
                ) : t.status === "in_progress" ? (
                  <CircleDotIcon className="size-[15px] text-sky-500" />
                ) : (
                  <CircleDashedIcon className="size-[15px] text-muted-foreground" />
                )}
                <span className={cn(t.status === "completed" ? "text-muted-foreground" : "text-foreground")}>{t.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ws.plan && (
        <div>
          <div className="font-medium text-sm">{ws.plan.title}</div>
          <p className="mt-1 text-muted-foreground text-xs">{ws.plan.description}</p>
          <ol className="mt-3 space-y-2">
            {ws.plan.steps.map((s, i) => (
              <li className="flex gap-2 text-sm" key={s.title}>
                <span className="font-mono text-muted-foreground text-xs">{i + 1}.</span>
                <span>{s.title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function buildTree(paths: string[]) {
  type Node = { name: string; path: string; children: Map<string, Node>; file: boolean };
  const root: Node = { name: "", path: "", children: new Map(), file: false };
  for (const p of paths) {
    const segs = p.split("/");
    let node = root;
    segs.forEach((seg, i) => {
      const path = segs.slice(0, i + 1).join("/");
      if (!node.children.has(seg)) node.children.set(seg, { name: seg, path, children: new Map(), file: i === segs.length - 1 });
      node = node.children.get(seg) as Node;
    });
  }
  const render = (node: Node): ReactNode =>
    [...node.children.values()].map((child) =>
      child.file ? (
        <FileTreeFile key={child.path} name={child.name} path={child.path} />
      ) : (
        <FileTreeFolder key={child.path} name={child.name} path={child.path}>
          {render(child)}
        </FileTreeFolder>
      )
    );
  const folders = new Set<string>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) folders.add(segs.slice(0, i).join("/"));
  }
  return { nodes: render(root), folders };
}

function ChangesTab({ ws }: { ws: WorkspaceData }) {
  const { focus } = useSession();
  const [selected, setSelected] = useState<string | undefined>(focus);
  // A newly focused file becomes the selection; adjusted while rendering rather than in an effect.
  const [lastFocus, setLastFocus] = useState(focus);
  if (focus !== lastFocus) {
    setLastFocus(focus);
    if (focus) setSelected(focus);
  }
  const current = ws.edits.find((e) => e.path === (selected ?? focus)) ?? ws.edits[0];
  const tree = useMemo(() => buildTree(ws.edits.map((e) => e.path)), [ws.edits]);

  if (ws.edits.length === 0) {
    return (
      <Empty
        hint="Files the agent edits show up here with a reviewable diff."
        icon={<FileDiffIcon className="size-6" />}
        title="No changes"
      />
    );
  }
  const adds = ws.edits.reduce((n, e) => n + e.additions, 0);
  const dels = ws.edits.reduce((n, e) => n + e.deletions, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">{ws.edits.length} files changed</span>
        <span className="font-mono text-emerald-500">+{adds}</span>
        <span className="font-mono text-red-500">−{dels}</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr]">
        <FileTree
          className="rounded-none border-0 border-b"
          defaultExpanded={tree.folders}
          onSelect={(p) => setSelected(p)}
          selectedPath={current?.path}
        >
          {tree.nodes}
        </FileTree>
        {current && (
          <ScrollArea className="min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs">
              <span>{current.path}</span>
              <span className="text-emerald-500">+{current.additions}</span>
              <span className="text-red-500">−{current.deletions}</span>
              <UndoFileEdits changes={current.changes} key={current.path} path={current.path} />
            </div>
            <DiffView className="rounded-none" patch={current.patch} />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

/** The Terminal tab's view, kept while the tab is switched away from. */
let terminalView: "agent" | "shell" = "agent";

/** The agent's commands (Agent) beside the person's own shell (Shell, user-terminal), which is shown on macOS only. */
function TerminalTab({ ws }: { ws: WorkspaceData }) {
  const [view, setView] = useState(terminalView);
  if (!terminalApi()) return <AgentLog ws={ws} />;
  const running = ws.shell.some((e) => e.running);
  const show = (next: typeof view) => {
    terminalView = next;
    setView(next);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b px-2">
        {(["agent", "shell"] as const).map((id) => (
          <button
            aria-pressed={view === id}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-[4px] px-2 text-[12px] leading-[1.35] outline-none",
              view === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"
            )}
            key={id}
            onClick={() => show(id)}
            type="button"
          >
            {id === "agent" ? "Agent" : "Shell"}
            {id === "agent" && running && <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{view === "agent" ? <AgentLog ws={ws} /> : <ShellView />}</div>
    </div>
  );
}

function AgentLog({ ws }: { ws: WorkspaceData }) {
  const [cleared, setCleared] = useState(0);
  const entries = ws.shell.slice(cleared);
  const running = entries.some((e) => e.running);
  const output = entries
    .map((e) => `\x1b[36m❯\x1b[0m ${e.command}\n${e.stdout ?? (e.running ? "" : `\x1b[2m(${e.denied ? "denied" : "waiting for approval"})\x1b[0m`)}${e.exitCode ? `\n\x1b[2m(exit ${e.exitCode})\x1b[0m` : ""}`)
    .join("\n\n");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Terminal
        className="min-h-0 flex-1 rounded-none border-0"
        isStreaming={running}
        onClear={() => setCleared(ws.shell.length)}
        output={output || "\x1b[2mNo commands run yet.\x1b[0m"}
      >
        <TerminalHeader>
          <TerminalTitle />
          <div className="flex items-center gap-1">
            <TerminalStatus />
            <TerminalActions>
              <TerminalCopyButton />
              <TerminalClearButton />
            </TerminalActions>
          </div>
        </TerminalHeader>
        <TerminalContent className="min-h-0 max-h-none flex-1" />
      </Terminal>
      {ws.tests && (
        <div className="max-h-[45%] overflow-auto p-3">
          <TestRunView data={ws.tests} />
        </div>
      )}
    </div>
  );
}

function SourcesTab({ ws }: { ws: WorkspaceData }) {
  if (ws.sources.length === 0) {
    return (
      <Empty
        hint="Turn on Search and ask about something current — cited pages are collected here."
        icon={<BookOpenIcon className="size-6" />}
        title="No sources"
      />
    );
  }
  return (
    <div className="space-y-2 p-3">
      {ws.sources.map((s, i) => {
        const host = new URL(s.url).hostname.replace("www.", "");
        return (
          <a
            className="flex items-start gap-3 rounded-xl border bg-background p-3 hover:bg-muted/50"
            href={s.url}
            key={s.url}
            rel="noreferrer"
            target="_blank"
          >
            <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
            <img alt="" className="mt-0.5 size-4 rounded" src={`https://www.google.com/s2/favicons?domain=${host}&sz=32`} />
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">{s.title}</div>
              <div className="truncate text-muted-foreground text-xs">{host}</div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

const TABS: { id: WorkspaceTab; label: string; icon: typeof BotIcon }[] = [
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "tasks", label: "Tasks", icon: ListChecksIcon },
  { id: "changes", label: "Changes", icon: FileDiffIcon },
  { id: "terminal", label: "Terminal", icon: SquareTerminalIcon },
  { id: "sources", label: "Sources", icon: BookOpenIcon },
];

export function WorkspaceTabList() {
  const { chat } = useSession();
  const ws = useMemo(() => deriveWorkspace(chat.messages), [chat.messages]);
  const badge: Partial<Record<WorkspaceTab, ReactNode>> = {
    agents: ws.subagents.some((a) => a.status === "running") ? (
      <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
    ) : ws.subagents.length ? (
      <span className="text-[10px] text-muted-foreground">{ws.subagents.length}</span>
    ) : null,
    changes: ws.edits.length ? <span className="text-[10px] text-muted-foreground">{ws.edits.length}</span> : null,
    sources: ws.sources.length ? <span className="text-[10px] text-muted-foreground">{ws.sources.length}</span> : null,
    terminal: ws.shell.some((s) => s.running) ? <span className="size-1.5 animate-pulse rounded-full bg-amber-500" /> : null,
  };

  return (
    <TabsList className="h-7 w-max gap-0.5 bg-transparent p-0" variant="line">
      {TABS.map((t) => (
        <TabsTrigger className="h-6 flex-none gap-1.5 px-2 text-[12px] leading-[1.35]" key={t.id} title={t.label} value={t.id}>
          <t.icon className="size-3.5" />
          <span className="hidden in-data-active:inline @[38rem]/ws:inline">{t.label}</span>
          {badge[t.id]}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

export function WorkspacePanel() {
  const { agentId, chat } = useSession();
  const ws = useMemo(() => deriveWorkspace(chat.messages), [chat.messages]);

  return (
    <div className="h-full bg-muted/20">
      <TabsContent className="h-full" value="agents">
        {agentId ? (
          <AgentThread />
        ) : (
          <ScrollArea className="h-full">
            <AgentsTab ws={ws} />
          </ScrollArea>
        )}
      </TabsContent>
      <TabsContent className="h-full" value="tasks">
        <ScrollArea className="h-full">
          <TasksTab ws={ws} />
        </ScrollArea>
      </TabsContent>
      <TabsContent className="h-full" value="changes">
        <ChangesTab ws={ws} />
      </TabsContent>
      <TabsContent className="h-full" value="terminal">
        <TerminalTab ws={ws} />
      </TabsContent>
      <TabsContent className="h-full" value="sources">
        <ScrollArea className="h-full">
          <SourcesTab ws={ws} />
        </ScrollArea>
      </TabsContent>
    </div>
  );
}
