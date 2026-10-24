"use client";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hasPendingApproval, messageText } from "@/lib/derive";
import { approvalExpired, declineApprovals, settleResumed, skippedNote, unansweredApprovals } from "@/lib/interrupted";
import { resolveEffort, thinkingControl } from "@/lib/thinking-switch";
import { currentSettings, currentWorkspace, useStore, type Thread, type WorkspaceTab } from "@/lib/store";
import { showChat } from "@/lib/visible-chats";
import type { AppUIMessage, ChatChoice, Effort } from "@/lib/types";
import { chatModelId, nextChoice } from "@/lib/chat-choice";
import { cn } from "@/lib/utils";
import { chatFetch, ipcMessage } from "@/lib/desktop";
import { getModel, MODELS, type ModelInfo } from "@/lib/models";
import { defaultEffort, effectiveCapabilities, modelPreferences, runtimeContext } from "@/features/model-settings/preferences";
import { readingModelFor } from "@/features/model-settings/feature-models";
import { useChat } from "@ai-sdk/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider, WebSpeechSynthesisAdapter } from "@assistant-ui/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import {
  Maximize2Icon,
  MessageCirclePlusIcon,
  Minimize2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Composer } from "./composer";
import { SessionContext, type QueuedMessage, type SessionValue } from "./session-context";
import { ChatTitleBar, WindowControls, WorkspaceToggle } from "./title-bar";
import { ThreadView } from "./thread";
import { WorkspacePanel, WorkspaceTabList } from "./workspace-panel";

/** The project a chat belongs to now, from the store as of the last render. */
function projectOf(threadId: string) {
  const projectId = currentWorkspace.threads.find((item) => item.id === threadId)?.projectId;
  return projectId ? currentWorkspace.projects.find((item) => item.id === projectId) : undefined;
}

/** The chat's model and the effort it runs with, as sent on each request. */
interface ChatRun {
  model: string;
  effort: Effort;
}
/** Each open chat's run as of its last render, read by its transport at send time. */
const chatRuns = new Map<string, ChatRun>();

/** The model that reads scanned pages for this chat, by name; the main process adds its connection. */
function readerFor(model: ModelInfo) {
  const reader = readingModelFor(model);
  if (!reader?.runtime || !reader.runtimeModelId) return undefined;
  return {
    connectionId: reader.connectionId ?? reader.runtime,
    runtimeModelId: reader.runtimeModelId,
    model: reader.id,
    modelName: reader.name,
    reasoningSupported: effectiveCapabilities(reader).includes("reasoning"),
    sampling: modelPreferences(reader).sampling,
    contextWindow: runtimeContext(reader).tokens,
  };
}

function currentRuntime(run: ChatRun, project?: { id: string; name: string }) {
  const model = getModel(run.model);
  if (!model.runtime) return {};
  // The decorated model hides reasoning when thinking is off; the runtime still needs to be told.
  const raw = MODELS.find((item) => item.id === model.id) ?? model;
  const capabilities = effectiveCapabilities(raw);
  return {
    // The main process looks up the connection's address, secrets and location from this ID.
    connectionId: raw.connectionId ?? model.runtime,
    runtime: model.runtime,
    runtimeModelId: model.runtimeModelId,
    reasoningSupported: capabilities.includes("reasoning"),
    visionSupported: capabilities.includes("vision"),
    modelName: model.name,
    thinkingSwitch: modelPreferences(model).thinkingSwitch,
    sampling: modelPreferences(model).sampling,
    reader: readerFor(raw),
    contextWindow: runtimeContext(raw).tokens,
    // Ollama stores its window with the model; other runtimes take the person's window from here.
    contextLimit: raw.runtime === "ollama" ? undefined : modelPreferences(raw).contextLimit,
    // The main process replaces this ID with the folder access it saved for the project.
    ...(project ? { projectId: project.id, projectName: project.name } : {}),
  };
}

/** A chat's name from its first message, until the person or the model names it. */
function firstMessageTitle(messages: AppUIMessage[]) {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;
  const title = messageText(firstUser).replace(/\s+/g, " ").trim();
  return title.length > 42 ? `${title.slice(0, 42)}…` : title || "Untitled";
}

/**
 * Settings → General "Written by the chat's model": after the first reply the chat's own model names it (harness/title).
 * The name is kept only if the chat still has its first-message name, so a chat the person renamed meanwhile stays.
 */
async function nameWithModel(threadId: string, messages: AppUIMessage[], update: (id: string, patch: Partial<Thread>) => void) {
  const run = chatRuns.get(threadId);
  const desktop = window.endurance;
  const runtime = run ? currentRuntime(run) : {};
  if (!desktop || !run || !("runtime" in runtime)) return;
  const exchange = [messages.find((m) => m.role === "user"), messages.find((m) => m.role === "assistant")].filter((m): m is AppUIMessage => Boolean(m));
  const title = await desktop.titleChat(JSON.stringify({ id: threadId, messages: exchange, ...run, ...runtime })).catch(() => undefined);
  const now = currentWorkspace.threads.find((item) => item.id === threadId)?.title;
  if (title && (now === firstMessageTitle(messages) || now === "New chat")) update(threadId, { title });
}

interface CoreOptions {
  thread: Thread;
  active: boolean;
  ephemeral?: boolean;
  extraBody?: Record<string, unknown>;
  workspaceTab: WorkspaceTab;
  openWorkspace: SessionValue["openWorkspace"];
  focus: string | undefined;
  agentId: string | undefined;
  openAgent: (id: string | null) => void;
  openSideChat: () => void;
}

function useSessionCore({
  thread,
  active,
  ephemeral = false,
  extraBody,
  workspaceTab,
  openWorkspace,
  focus,
  agentId,
  openAgent,
  openSideChat,
}: CoreOptions) {
  const { updateThread, setStatus, projects, settings, setSettings, chooseForChat, refreshModels, general } = useStore();
  // Read when a reply ends; the chat's callbacks are made once, so they look here for the current values.
  const latestRef = useRef({ title: thread.title, temporary: thread.temporary, active, general, updateThread });
  useEffect(() => {
    latestRef.current = { title: thread.title, temporary: thread.temporary, active, general, updateThread };
  });
  const project = ephemeral ? undefined : projects.find((item) => item.id === thread.projectId);
  // A side chat is not in the store, so it keeps its choice here; it starts from its parent's.
  const [sideChoice, setSideChoice] = useState<ChatChoice | undefined>(thread.choice);
  const choice = ephemeral ? sideChoice : thread.choice;
  const [transport] = useState(
    () =>
      new DefaultChatTransport<AppUIMessage>({
        api: "/api/chat",
        fetch: chatFetch,
        // Read at send time: the chat may have been moved into or out of a project since this was created.
        prepareSendMessagesRequest: ({ messages, id, body }) => {
          const run = chatRuns.get(id) ?? { model: currentSettings.value?.model ?? "", effort: "high" };
          return { body: { ...currentSettings.value, ...extraBody, ...body, id, messages, ...run, ...currentRuntime(run, ephemeral ? undefined : projectOf(id)) } };
        },
      })
  );

  const chat = useChat<AppUIMessage>({
    id: thread.id,
    messages: thread.messages,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: (part) => {
      if (part.type === "data-status")
        setWaitStatus(
          part.data.state === "loading"
            ? "Loading the model"
            : `Reading ${part.data.file}${part.data.total > 1 ? ` · ${Math.min(part.data.done + 1, part.data.total)} of ${part.data.total}` : ""}`
        );
      // A refused request taught a window: the runtime was asked again, so the model list reads it again too.
      if (part.type === "data-fit") refreshModels();
      // The runtime loaded the model at a window the list did not have: that connection is read again.
      if (part.type === "data-window") {
        const run = chatRuns.get(thread.id);
        refreshModels(run ? getModel(run.model).connectionId : undefined);
      }
      if (part.type === "data-toast" && active) {
        if (part.data.tone === "success") toast.success(part.data.message);
        else toast(part.data.message);
      }
    },
    onError: (error) => {
      const now = latestRef.current;
      if (!now.active && !ephemeral) toast.error(`“${now.title}” failed`, { description: error.message });
    },
    onFinish: ({ message, messages, isAbort, isDisconnect, isError }) => {
      const now = latestRef.current;
      const failed = isDisconnect || isError;
      // A reply that did not finish says how it ended, so it can be continued honestly (lib/interrupted).
      if (message.role === "assistant" && (isAbort || failed)) {
        const interrupted = isAbort ? "stopped" : "error";
        chat.setMessages((current) =>
          current.map((item) => (item.id === message.id ? { ...item, metadata: { ...item.metadata, interrupted } } : item))
        );
      }
      // A reply continued in place finished: it reads as one whole reply again (lib/interrupted).
      if (message.role === "assistant" && !isAbort && !failed && message.metadata?.interrupted)
        chat.setMessages((current) => current.map((item) => (item.id === message.id ? settleResumed(item) : item)));
      if (ephemeral || isAbort) return;
      // A reply that paused on a plan, a command or a question waits for the person rather than finishing.
      const waiting = !failed && hasPendingApproval(messages);
      if (!now.active && !failed && !waiting) toast.success(`“${now.title}” finished`);
      const kind = failed ? "notifyFailed" : waiting ? "notifyWaiting" : "notifyFinished";
      if (now.general[kind])
        window.endurance?.notify({
          chatId: thread.id,
          title: failed ? "Response failed" : waiting ? "Action required" : "Response complete",
          body: now.title,
          sound: now.general.notifySound,
        });
      // The first finished reply: the chat's model may name it.
      if (!failed && !waiting && now.general.chatTitles === "model" && !now.temporary && messages.filter((m) => m.role === "assistant").length === 1)
        void nameWithModel(thread.id, messages, now.updateThread);
    },
  });

  // The open chat and an open side chat are on screen; their requests go first when a runtime is busy.
  useEffect(() => (active || ephemeral ? showChat(thread.id) : undefined), [active, ephemeral, thread.id]);

  const adapters = useMemo(
    () => ({
      speech: new WebSpeechSynthesisAdapter(),
      feedback: {
        submit: ({ type }: { type: "positive" | "negative" }) =>
          toast(type === "positive" ? "Thanks for the feedback!" : "Thanks — we'll use this to improve."),
      },
    }),
    []
  );
  const runtime = useAISDKRuntime(chat, { adapters, joinStrategy: "none" });

  const busy = chat.status === "submitted" || chat.status === "streaming";
  // An approval the worker no longer holds (the app restarted, or it waited too long) can't be answered: the chat isn't waiting.
  const lastMessage = chat.messages.at(-1);
  const pendingApproval = hasPendingApproval(chat.messages) && !(lastMessage && approvalExpired(lastMessage));
  // Shown while the reply waits on the model loading or a document being read; it ends with the reply.
  const [waitStatus, setWaitStatus] = useState<string>();
  if (waitStatus && !busy) setWaitStatus(undefined);

  const model = getModel(chatModelId({ choice, messages: chat.messages }, settings.model));
  // The effort chosen in this chat, else the model's default, fitted to what the model can take.
  const effort = resolveEffort(thinkingControl(model), choice?.effort ?? defaultEffort(model));
  useEffect(() => {
    chatRuns.set(thread.id, { model: model.id, effort });
  }, [thread.id, model.id, effort]);
  useEffect(() => () => void chatRuns.delete(thread.id), [thread.id]);
  const choose = useCallback(
    (patch: ChatChoice) => {
      if (!ephemeral) return chooseForChat(thread.id, patch);
      setSideChoice((current) => nextChoice(current ?? { model: model.id }, patch));
      if (patch.model) setSettings({ model: patch.model });
    },
    [ephemeral, chooseForChat, thread.id, model.id, setSettings]
  );

  /**
   * /compact. A runtime model summarizes everything before the latest turn in the chat worker; the summary is
   * stored on the conversation like an automatic one, so later requests send it instead of those messages.
   */
  const compacting = useRef(false);
  const compact = useCallback(async () => {
    if (!model.runtime) return void toast("Choose a model first.");
    const desktop = window.endurance;
    if (!desktop) return void toast.error("Compaction needs the desktop app.");
    if (busy || pendingApproval) return void toast("Compact after the current reply finishes.");
    if (compacting.current) return;
    compacting.current = true;
    const messages = chat.messages;
    const id = toast.loading("Compacting conversation…");
    try {
      const result = await desktop.compactChat(
        JSON.stringify({ model: model.id, id: thread.id, messages, ...currentRuntime({ model: model.id, effort }, project) })
      );
      if ("skipped" in result) {
        toast(result.skipped === "short" ? "Nothing to compact yet" : "Couldn't compact", {
          id,
          description:
            result.skipped === "short"
              ? "There are fewer than three messages since the last summary, or only the latest turn."
              : "The model's summary was unusable, so the conversation was left as it was.",
        });
        return;
      }
      const { data } = result;
      let stored = false;
      chat.setMessages((current) => {
        // The conversation changed meanwhile (cleared or edited): the summary no longer matches it.
        if (!current.some((message) => message.id === data.upTo)) return current;
        const at = current.findLastIndex((message) => message.role === "assistant");
        if (at < 0) return current;
        stored = true;
        return current.map((message, index) =>
          index === at ? { ...message, parts: [...message.parts, { type: "data-compaction", id: `compaction-${data.upTo}`, data }] } : message
        );
      });
      if (!stored) return void toast("Conversation changed while compacting", { id, description: "Nothing was stored. Try /compact again." });
      const tokens = (n: number) => `~${n.toLocaleString()}`;
      toast.success("Conversation compacted", {
        id,
        description: `Summarized ${data.compacted} earlier ${data.compacted === 1 ? "message" : "messages"} · estimated ${tokens(data.before)} → ${tokens(data.after)} tokens`,
      });
    } catch (error) {
      toast.error("Couldn't compact", { id, description: error instanceof Error ? ipcMessage(error) : String(error) });
    } finally {
      compacting.current = false;
    }
  }, [busy, pendingApproval, chat, thread.id, project, model.runtime, model.id, effort]);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);

  const send = useCallback<SessionValue["send"]>(
    (message, overrides) => {
      chat.sendMessage(
        { text: message.text, files: message.files },
        overrides ? { body: overrides } : undefined
      );
    },
    [chat]
  );

  const enqueue = useCallback<SessionValue["enqueue"]>((message, front) => {
    // Put at the front, a message is sent now (⌘↵ in the composer): it steers instead of waiting its turn.
    const item = { ...message, id: nanoid(8), ...(front ? { steer: true } : {}) };
    setQueue((q) => (front ? [item, ...q] : [...q, item]));
    if (!front) toast("Message queued", { description: "It will send when the current run finishes." });
  }, []);

  const removeQueued = useCallback((id: string) => setQueue((q) => q.filter((m) => m.id !== id)), []);

  const moveQueued = useCallback((id: string, dir: -1 | 1) => {
    setQueue((q) => {
      const i = q.findIndex((m) => m.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= q.length) return q;
      const next = [...q];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const sendNow = useCallback(
    (id: string) => {
      setQueue((q) => {
        const item = q.find((m) => m.id === id);
        return item ? [{ ...item, steer: true }, ...q.filter((m) => m.id !== id)] : q;
      });
      if (busy) chat.stop();
    },
    [busy, chat]
  );

  useEffect(() => {
    if (busy || queue.length === 0) return;
    const [next, ...rest] = queue;
    // A queued message waits for an approval to be answered and does not go out after a failure; one sent now does.
    if ((pendingApproval || chat.status === "error") && !next.steer) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueue(rest);
    if (!pendingApproval) return void chat.sendMessage({ text: next.text, files: next.files });
    // Sent past an approval: the card is closed as not run, and the model is told what was left unanswered.
    const skipped = unansweredApprovals(chat.messages);
    chat.setMessages((current) => current.map((message, index) => (index === current.length - 1 ? declineApprovals(message) : message)));
    chat.sendMessage({ text: next.text, files: next.files, metadata: { note: skippedNote(skipped) } });
  }, [busy, pendingApproval, chat, queue]);

  const latest = useRef(chat.messages);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (ephemeral) return;
    latest.current = chat.messages;
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const messages = latest.current;
      const patch: Partial<Thread> = { messages, updatedAt: Date.now() };
      const named = firstMessageTitle(messages);
      if (named && (thread.title === "New chat" || thread.title === "Temporary chat") && !thread.temporary) patch.title = named;
      updateThread(thread.id, patch);
    }, busy ? 900 : 50);
  }, [ephemeral, chat.messages, busy, thread.id, thread.title, thread.temporary, updateThread]);

  useEffect(() => {
    if (ephemeral) return;
    setStatus(
      thread.id,
      busy ? "streaming" : pendingApproval ? "awaiting" : chat.status === "error" ? "error" : "idle"
    );
  }, [ephemeral, busy, pendingApproval, chat.status, thread.id, setStatus]);

  const value = useMemo<SessionValue>(
    () => ({
      thread,
      chat,
      busy,
      pendingApproval,
      queue,
      enqueue,
      removeQueued,
      sendNow,
      moveQueued,
      send,
      workspaceTab,
      openWorkspace,
      focus,
      agentId,
      openAgent,
      openSideChat,
      isSide: ephemeral,
      active,
      waitStatus,
      model,
      effort,
      choose,
    }),
    [thread, chat, busy, pendingApproval, queue, enqueue, removeQueued, sendNow, moveQueued, send, workspaceTab, openWorkspace, focus, agentId, openAgent, openSideChat, ephemeral, active, waitStatus, model, effort, choose]
  );

  return { value, runtime, compact };
}

function SessionProviders({ value, runtime, children }: Omit<ReturnType<typeof useSessionCore>, "compact"> & { children: ReactNode }) {
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionContext.Provider value={value}>
        {/* A side chat is temporary, so only a chat in the list keeps a draft. */}
        <PromptInputProvider draftKey={value.isSide ? undefined : value.thread.id}>{children}</PromptInputProvider>
      </SessionContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function SideChatEmpty() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
      <MessageCirclePlusIcon className="size-7 text-muted-foreground" />
      <div className="font-medium text-sm">Side chat</div>
      <p className="max-w-64 text-muted-foreground text-xs">
        Ask a quick question without derailing the main conversation. Side chats are temporary and disappear when you
        close the app.
      </p>
    </div>
  );
}

interface SideChatInfo {
  id: string;
  title: string;
}

function SideChat({
  info,
  parent,
  active,
  ...shared
}: {
  info: SideChatInfo;
  parent: Thread;
  active: boolean;
} & Pick<CoreOptions, "workspaceTab" | "openWorkspace" | "focus" | "agentId" | "openAgent" | "openSideChat">) {
  const { settings } = useStore();
  const [thread] = useState<Thread>(() => ({
    id: info.id,
    title: info.title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    temporary: true,
    messages: [],
    // Starts on the parent chat's model and effort.
    choice: { model: chatModelId(parent, settings.model), ...(parent.choice?.effort ? { effort: parent.choice.effort } : {}) },
  }));
  const core = useSessionCore({
    ...shared,
    thread,
    active,
    ephemeral: true,
    extraBody: { side: true, parentTitle: parent.title },
  });

  return (
    <SessionProviders {...core}>
      <div className={cn("flex h-full min-h-0 flex-col", !active && "hidden")}>
        <ThreadView compact empty={<SideChatEmpty />} />
        <Composer compact={core.compact} />
      </div>
    </SessionProviders>
  );
}

function FadingTabRow({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = () => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((current) => (current.left === left && current.right === right ? current : { left, right }));
  };

  useEffect(() => {
    update();
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative min-w-0 flex-1">
      <div
        className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={update}
        ref={scroller}
      >
        {children}
      </div>
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent transition-opacity",
          edges.left ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent transition-opacity",
          edges.right ? "opacity-100" : "opacity-0"
        )}
      />
    </div>
  );
}

function PanelTab({
  active,
  icon,
  label,
  onSelect,
  onClose,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const tab = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) tab.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active]);
  return (
    <div
      className={cn(
        "group/tab flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-[13px] leading-[1.4] whitespace-nowrap transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
      data-active-tab={active}
      ref={tab}
      title={label}
    >
      <button className="flex items-center gap-1.5" onClick={onSelect} type="button">
        <span className="shrink-0">{icon}</span>
        <span>{label}</span>
      </button>
      {onClose ? (
        <button
          aria-label={`Close ${label}`}
          className={cn(
            "flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
            !active && "opacity-0 group-hover/tab:opacity-100"
          )}
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pressed}
            className={cn(
              "size-7 text-muted-foreground [&_svg]:size-[15px]",
              pressed && "bg-muted text-foreground hover:bg-muted"
            )}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ChatSession({ thread, active }: { thread: Thread; active: boolean }) {
  const { workspaceOpen, setWorkspaceOpen, sidebarOpen } = useStore();
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("agents");
  const [focus, setFocus] = useState<string | undefined>();
  const [agentId, setAgentId] = useState<string | undefined>();
  const [sideChats, setSideChats] = useState<SideChatInfo[]>([]);
  const [rightView, setRightView] = useState<string>("workspace");
  const [expanded, setExpanded] = useState(false);

  const openWorkspace = useCallback(
    (tab: WorkspaceTab, target?: string) => {
      setWorkspaceTab(tab);
      setFocus(target);
      setRightView("workspace");
      setWorkspaceOpen(true);
      if (target) {
        setTimeout(() => document.getElementById(`agent-${target}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
      }
    },
    [setWorkspaceOpen]
  );

  const openAgent = useCallback((id: string | null) => {
    setAgentId(id ?? undefined);
    if (!id) return;
    setWorkspaceTab("agents");
    setRightView("workspace");
    setWorkspaceOpen(true);
    setExpanded(false);
  }, [setWorkspaceOpen]);

  const openSideChat = useCallback(() => {
    const id = `side-${nanoid(8)}`;
    setSideChats((list) => [...list, { id, title: list.length ? `Side chat ${list.length + 1}` : "Side chat" }]);
    setRightView(id);
    setWorkspaceOpen(true);
  }, [setWorkspaceOpen]);

  const closeSideChat = (id: string) => {
    const remaining = sideChats.filter((c) => c.id !== id);
    setSideChats(remaining);
    if (rightView === id) setRightView(remaining.at(-1)?.id ?? "workspace");
    if (remaining.length === 0) setExpanded(false);
  };

  const core = useSessionCore({ thread, active, workspaceTab, openWorkspace, focus, agentId, openAgent, openSideChat });
  const shared = { workspaceTab, openWorkspace, focus, agentId, openAgent, openSideChat };
  const showRight = workspaceOpen;
  const showChat = !(showRight && expanded);

  return (
    <SessionProviders {...core}>
      <div className={cn("h-full min-h-0 w-full", !active && "hidden")}>
        <ResizablePanelGroup className="h-full gap-0" orientation="horizontal">
          {showChat && (
            <ResizablePanel defaultSize="60%" id="chat" minSize="420px">
              <div className="flex h-full flex-col overflow-hidden">
                <ChatTitleBar end={showRight ? undefined : <WorkspaceToggle />} showWindowControls={!sidebarOpen} thread={thread} />
                <ThreadView />
                <Composer compact={core.compact} />
              </div>
            </ResizablePanel>
          )}
          {showRight && (
            <>
              {showChat && <ResizableHandle className="w-1 bg-transparent transition-colors hover:bg-border" />}
              <ResizablePanel defaultSize="40%" id="workspace" minSize="340px">
                <Tabs
                  className="@container/ws flex h-full min-h-0 flex-col gap-0"
                  onValueChange={(value) => {
                    if (value === "off") return;
                    openWorkspace(value as WorkspaceTab);
                  }}
                  value={rightView === "workspace" ? workspaceTab : "off"}
                >
                  <header
                    className={cn(
                      "flex h-10 shrink-0 items-center gap-1",
                      !showChat && !sidebarOpen ? "px-3" : "pr-2 pl-1.5"
                    )}
                  >
                    {!showChat && !sidebarOpen && <WindowControls />}
                    <FadingTabRow>
                      <div className="flex w-max items-center gap-1">
                        {sideChats.map((c) => (
                          <PanelTab
                            active={rightView === c.id}
                            icon={<MessageCirclePlusIcon className="size-3.5" />}
                            key={c.id}
                            label={c.title}
                            onClose={() => closeSideChat(c.id)}
                            onSelect={() => setRightView(c.id)}
                          />
                        ))}
                      </div>
                    </FadingTabRow>
                    <HeaderButton label="New side chat" onClick={openSideChat}>
                      <PlusIcon />
                    </HeaderButton>
                    <div className="mx-0.5 h-4 w-px bg-border" />
                    <HeaderButton label={expanded ? "Restore" : "Expand"} onClick={() => setExpanded((e) => !e)} pressed={expanded}>
                      {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
                    </HeaderButton>
                    <WorkspaceToggle />
                  </header>
                  <div className={cn("min-h-0 flex-1 pr-2 pb-2", !showChat && "pl-2")}>
                    <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card">
                      {rightView === "workspace" && (
                        <div className="flex h-8 shrink-0 items-center border-b px-2">
                          <WorkspaceTabList />
                        </div>
                      )}
                      <div className={cn("min-h-0 flex-1", rightView !== "workspace" && "hidden")}>
                        <WorkspacePanel />
                      </div>
                      {sideChats.map((c) => (
                        <SideChat active={rightView === c.id} info={c} key={c.id} parent={thread} {...shared} />
                      ))}
                    </div>
                  </div>
                </Tabs>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </SessionProviders>
  );
}
