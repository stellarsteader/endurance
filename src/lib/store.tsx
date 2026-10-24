"use client";

import { nanoid } from "nanoid";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  MODELS,
  PRIMARY_RUNTIMES,
  registerRuntimeModels,
  type RuntimeId,
} from "./models";
import { modelKind, modelPreferences } from "../features/model-settings/preferences";
import { connectionLabel, defaultConnection, type ConnectionView, type LegacySettings } from "./connections";
import type { AppUIMessage, ChatChoice, ChatSettings } from "./types";
import { chatModelId, nextChoice } from "./chat-choice";
import type { CatalogResult } from "./desktop";
import type { WorkspacePolicy } from "./workspace-policy";
import type { HistorySession, SessionInput } from "./history-api";
import type { StoredProject } from "./workspace-api";
import { dropDraft } from "./drafts";

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  temporary?: boolean;
  projectId?: string;
  messages: AppUIMessage[];
  /** The chat's own model and effort; see lib/chat-choice. */
  choice?: ChatChoice;
  /** A saved chat whose messages are not read yet (they are when it is opened); `messageCount` and `replyModel` stand in. */
  loaded?: false;
  messageCount?: number;
  replyModel?: string;
}

/** Whether a chat has messages, read or not. */
export const hasMessages = (thread: Thread) => thread.messages.length > 0 || (thread.loaded === false && (thread.messageCount ?? 0) > 0);

export interface ProjectFolder {
  id: string;
  name: string;
}

/** The fields the main process stores; `folders` is the browser preview's stand-in and stays out. */
function toStoredProject(project: Project): StoredProject {
  const stored: Project = { ...project };
  delete stored.folders;
  return stored;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  pinned?: boolean;
  collapsed?: boolean;
  instructions?: string;
  /** Names picked by the browser preview, which has no filesystem access. */
  folders?: ProjectFolder[];
  /** Folders and access rules. The desktop main process keeps the copy it enforces. */
  access?: WorkspacePolicy;
}

export type GroupBy = "project" | "date" | "status" | "model" | "none";
export type OrderBy = "updated" | "created" | "title" | "custom";

/** A manual order: IDs first to last. See lib/ordering for how stale or missing IDs are handled. */
export interface CustomOrder {
  /** Project IDs, and "none" for chats without a project. */
  groups: string[];
  threads: string[];
}

/** The model menu's manual order: provider groups, and models across all groups. */
export interface ModelOrder {
  groups: string[];
  models: string[];
}

export interface SidebarView {
  groupBy: GroupBy;
  orderBy: OrderBy;
  /** Used when orderBy is "custom". Dragging a project or chat saves it and switches to it. */
  customOrder: CustomOrder;
  pinnedOnTop: boolean;
  showEmptyProjects: boolean;
  filters: {
    statuses: ThreadStatus[];
    models: string[];
    projects: string[];
  };
}

export const DEFAULT_VIEW: SidebarView = {
  groupBy: "project",
  orderBy: "updated",
  pinnedOnTop: true,
  showEmptyProjects: false,
  customOrder: { groups: [], threads: [] },
  filters: { statuses: [], models: [], projects: [] },
};

const EMPTY_MODEL_ORDER: ModelOrder = { groups: [], models: [] };

/** Saved ID lists come from localStorage, so anything that is not a list of strings reads as empty. */
const idList = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

export type ThreadStatus = "idle" | "streaming" | "awaiting" | "unread" | "error";

export type WorkspaceTab = "agents" | "tasks" | "changes" | "terminal" | "sources";

export interface AppearanceSettings {
  uiFontSize: number;
  codeFontSize: number;
  toolCallDensity: number;
  chatWidth: number;
  codeWordWrap: boolean;
  themedDiffBackgrounds: boolean;
}

/** Settings → General. */
export interface GeneralSettings {
  /** System notifications while the window is in the background: a reply finished, waits for you, or failed. */
  notifyFinished: boolean;
  notifyWaiting: boolean;
  notifyFailed: boolean;
  /** The notification plays the system's sound. */
  notifySound: boolean;
  /** "message": a chat is named after its first message. "model": the chat's own model names it after its first reply. */
  chatTitles: "message" | "model";
}

export const DEFAULT_GENERAL: GeneralSettings = {
  notifyFinished: true,
  notifyWaiting: true,
  notifyFailed: true,
  notifySound: true,
  chatTitles: "message",
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  uiFontSize: 13,
  codeFontSize: 12,
  toolCallDensity: 72,
  chatWidth: 840,
  codeWordWrap: true,
  themedDiffBackgrounds: true,
};

interface StoreState {
  runtimeCatalog: CatalogResult[];
  threads: Thread[];
  projects: Project[];
  sidebarView: SidebarView;
  activeId: string;
  settings: ChatSettings;
  statuses: Record<string, ThreadStatus>;
  sidebarOpen: boolean;
  workspaceOpen: boolean;
  paletteOpen: boolean;
  modelPickerOpen: boolean;
  projectSettingsId: string | null;
  /** Open when not undefined; holds the chat to move into the new project, or null to start a fresh chat */
  newProjectFor: string | null | undefined;
  /** Settings nav selection. Null when the settings sidebar is closed. */
  settingsSection: string | null;
  /** Library nav selection. Null when the library is closed. */
  librarySection: string | null;
  appearance: AppearanceSettings;
  general: GeneralSettings;
  modelOrder: ModelOrder;
  /** Saved connections as the main process reports them; it keeps their secrets and history. */
  connections: ConnectionView[];
}

interface StoreActions {
  /** Checks every connection again, or only the one named. */
  refreshModels: (connectionId?: string) => void;
  newThread: (opts?: { temporary?: boolean; projectId?: string | null }) => string;
  /** Project changes resolve once saved; on desktop the main process confirms each one before it shows. */
  createProject: (name: string, access?: WorkspacePolicy, instructions?: string) => Promise<string>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  restoreProject: (project: Project, threadIds: string[]) => Promise<void>;
  setSidebarView: (patch: Partial<SidebarView>) => void;
  markAllRead: () => void;
  selectThread: (id: string) => void;
  updateThread: (id: string, patch: Partial<Thread>) => void;
  deleteThread: (id: string) => void;
  setSettings: (patch: Partial<ChatSettings>) => void;
  /**
   * The person picks a model or effort for a chat. A picked model is also where new chats start. A chat the store
   * does not hold (a side chat) keeps its own choice; for it only the model new chats start with changes.
   */
  chooseForChat: (id: string, patch: ChatChoice) => void;
  setStatus: (id: string, status: ThreadStatus) => void;
  setSidebarOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  setWorkspaceOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  setPaletteOpen: (open: boolean) => void;
  setModelPickerOpen: (open: boolean) => void;
  openProjectSettings: (id: string | null) => void;
  openNewProject: (assignThreadId?: string | null) => void;
  closeNewProject: () => void;
  setSettingsSection: (section: string | null) => void;
  setLibrarySection: (section: string | null) => void;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  setGeneral: (patch: Partial<GeneralSettings>) => void;
  setModelOrder: (patch: Partial<ModelOrder>) => void;
  /** Lists runtimes found at their default address, except ones the person removed. */
  detectRuntimes: () => void;
  /** Lists a runtime chosen from Add server, even one removed before. */
  addRuntime: (id: RuntimeId) => void;
  removeConnection: (id: string) => Promise<void>;
}

type Store = StoreState & StoreActions;

const StoreContext = createContext<Store | null>(null);

const STORAGE_KEY = "endurance:v1";
/** Marked the localStorage-to-database chat import, which no longer runs; removed when found. */
const LEGACY_MIGRATED_KEY = "endurance:history-migrated";

// A chat whose messages were never read is saved without them, so its stored messages stay.
const toSession = (thread: Thread): SessionInput => ({
  id: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  pinned: thread.pinned,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  ...(thread.loaded === false ? {} : { messages: thread.messages }),
  ...(thread.choice ? { choice: thread.choice } : {}),
});
const fromSession = (session: HistorySession): Thread => ({
  id: session.id,
  title: session.title,
  projectId: session.projectId,
  pinned: session.pinned,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messages: [],
  loaded: false,
  messageCount: session.messageCount ?? 0,
  ...(session.replyModel ? { replyModel: session.replyModel } : {}),
  ...(session.choice ? { choice: session.choice } : {}),
});

/** The default runtime, for the browser preview, which has no main process to own connections. */
const previewConnections = (): ConnectionView[] =>
  PRIMARY_RUNTIMES.map((id) => {
    const connection = defaultConnection(id);
    return { ...connection, builtin: true, primary: true, label: connectionLabel(connection), host: "127.0.0.1", location: "this-computer", mine: true, secrets: { hasKey: false, headerNames: [] } };
  });

/** Connection settings kept in localStorage before the main process owned them; read once to migrate. */
function legacySettings(): (LegacySettings & { keys: Partial<Record<string, string>> }) | undefined {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as (LegacySettings & Record<string, unknown>) | null;
    if (!saved || (!saved.connections && !saved.addedRuntimes && !saved.dismissedRuntimes)) return undefined;
    const keys = Object.fromEntries(
      Object.entries(saved.connections ?? {}).flatMap(([id, value]) => (typeof value?.apiKey === "string" && value.apiKey ? [[id, value.apiKey]] : []))
    );
    return { connections: saved.connections, addedRuntimes: saved.addedRuntimes, dismissedRuntimes: saved.dismissedRuntimes, keys };
  } catch {
    return undefined;
  }
}

const blankThread = (temporary = false, projectId?: string): Thread => ({
  id: nanoid(10),
  title: temporary ? "Temporary chat" : "New chat",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  temporary,
  projectId,
  messages: [],
});

function loadInitial(): StoreState {
  const fallbackThread = blankThread();
  const base: StoreState = {
    runtimeCatalog: [],
    threads: [fallbackThread],
    projects: [],
    sidebarView: DEFAULT_VIEW,
    activeId: fallbackThread.id,
    // No model until a runtime lists one; the first chat model it lists is chosen (applyCatalog).
    settings: { model: "", effort: "high", defaultApproval: "ask", webSearch: false },
    statuses: {},
    sidebarOpen: true,
    workspaceOpen: true,
    paletteOpen: false,
    modelPickerOpen: false,
    projectSettingsId: null,
    newProjectFor: undefined,
    settingsSection: null,
    librarySection: null,
    appearance: DEFAULT_APPEARANCE,
    general: DEFAULT_GENERAL,
    modelOrder: EMPTY_MODEL_ORDER,
    connections: previewConnections(),
  };
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const { connections: _legacyConnections, addedRuntimes: _added, dismissedRuntimes: _dismissed, ...saved } = JSON.parse(raw) as Partial<StoreState> & LegacySettings;
    void _legacyConnections;
    void _added;
    void _dismissed;
    // The desktop app keeps chats in its database; chats an older version left in localStorage are dropped.
    const threads = !window.enduranceHistory && saved.threads?.length ? saved.threads : base.threads;
    const fresh = blankThread();
    // The one app-wide mode of earlier versions is dropped: new chats start in the default, each chat keeps its own.
    const { approval: _appWide, ...savedSettings } = (saved.settings ?? {}) as Partial<ChatSettings> & { approval?: unknown };
    void _appWide;
    return {
      ...base,
      ...saved,
      projects: saved.projects ?? [],
      sidebarView: {
        ...DEFAULT_VIEW,
        ...saved.sidebarView,
        customOrder: { groups: idList(saved.sidebarView?.customOrder?.groups), threads: idList(saved.sidebarView?.customOrder?.threads) },
        filters: { ...DEFAULT_VIEW.filters, ...saved.sidebarView?.filters },
      },
      threads: [fresh, ...threads.filter((t) => t.messages.length > 0)],
      activeId: fresh.id,
      settings: { ...base.settings, ...savedSettings },
      statuses: {},
      paletteOpen: false,
      modelPickerOpen: false,
      projectSettingsId: null,
      newProjectFor: undefined,
      settingsSection: null,
      librarySection: null,
      appearance: { ...DEFAULT_APPEARANCE, ...saved.appearance },
      general: { ...DEFAULT_GENERAL, ...saved.general },
      modelOrder: { groups: idList(saved.modelOrder?.groups), models: idList(saved.modelOrder?.models) },
      connections: base.connections,
    };
  } catch {
    return base;
  }
}

/** Read by the chat transport at request time, outside React render. */
export const currentSettings: { value: ChatSettings | undefined } = { value: undefined };
/** The projects and threads as of the last render, read by the chat transport at request time. */
export const currentWorkspace: { projects: Project[]; threads: Thread[] } = { projects: [], threads: [] };

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(loadInitial);

  // Desktop projects live in the main process database. The copy loaded from localStorage is only sent
  // the first time, to be imported; after that the main process never takes the renderer's copy.
  const [projectsReady, setProjectsReady] = useState(() => typeof window === "undefined" || !window.enduranceWorkspace);
  const projectsRef = useRef(state.projects);
  useEffect(() => {
    projectsRef.current = state.projects;
  }, [state.projects]);
  useEffect(() => {
    const workspace = window.enduranceWorkspace;
    if (!workspace) return;
    let cancelled = false;
    workspace
      .projects(projectsRef.current.map(toStoredProject))
      .then((projects) => {
        if (cancelled) return;
        setState((s) => ({ ...s, projects }));
        setProjectsReady(true);
      })
      .catch((error: unknown) => console.warn("Could not load projects", error));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    currentSettings.value = state.settings;
  }, [state.settings]);
  useEffect(() => {
    currentWorkspace.projects = state.projects;
    currentWorkspace.threads = state.threads;
  }, [state.projects, state.threads]);

  // The main process owns connections and pushes the list and the catalog; this keeps a copy to render.
  const states = useRef(new Map<string, string | undefined>());
  const labels = useRef(new Map<string, string>());
  useEffect(() => {
    labels.current = new Map(state.connections.map((item) => [item.id, item.label]));
  }, [state.connections]);
  const applyCatalog = useCallback((catalog: CatalogResult[]) => {
    for (const item of catalog) {
      const before = states.current.get(item.connectionId);
      // A server that was starting announces itself when it can take requests.
      if (before === "starting" && item.state === "connected") {
        const label = labels.current.get(item.connectionId) ?? item.models[0]?.providerLabel ?? "Server";
        toast.success(`${label} is ready`, { description: `${item.models.length} ${item.models.length === 1 ? "model" : "models"} available.` });
      }
      states.current.set(item.connectionId, item.state);
    }
    registerRuntimeModels(catalog.flatMap((item) => item.models));
    // With no model chosen, or one no longer listed, new chats start on the first chat model listed.
    const chat = MODELS.filter((model) => modelKind(model) === "chat" && modelPreferences(model).visible !== false);
    setState((value) => ({
      ...value,
      runtimeCatalog: catalog,
      ...(chat.length && !chat.some((model) => model.id === value.settings.model) && !value.settings.model.startsWith("local:") && !value.settings.model.startsWith("server:")
        ? { settings: { ...value.settings, model: chat[0].id } }
        : {}),
    }));
  }, []);
  const refreshModels = useCallback((connectionId?: string) => {
    window.endurance?.catalog(connectionId).then(applyCatalog, () => {});
  }, [applyCatalog]);
  useEffect(() => {
    const desktop = window.endurance;
    if (!desktop) return;
    const offConnections = desktop.onConnections((connections) => setState((value) => ({ ...value, connections })));
    const offCatalog = desktop.onCatalog(applyCatalog);
    (async () => {
      const legacy = legacySettings();
      let connections = await desktop.connections(legacy);
      // Keys typed before keys moved to the keychain go there once, for the address they were typed for.
      for (const [id, key] of Object.entries(legacy?.keys ?? {}))
        if (key && connections.some((item) => item.id === id)) await desktop.updateConnection(id, { apiKey: { replace: key } }).catch(() => undefined);
      if (legacy?.keys && Object.keys(legacy.keys).length) connections = await desktop.connections();
      setState((value) => ({ ...value, connections }));
      applyCatalog(await desktop.catalog());
    })().catch(() => {});
    return () => {
      offConnections();
      offCatalog();
    };
  }, [applyCatalog]);

  useEffect(() => {
    const appearance = { ...DEFAULT_APPEARANCE, ...state.appearance };
    const root = document.documentElement;
    const ui = appearance.uiFontSize;
    root.style.setProperty("--text-sm", `${ui}px`);
    root.style.setProperty("--text-xs", `${Math.max(10, ui - 2)}px`);
    root.style.setProperty("--text-base", `${ui + 1}px`);
    root.style.setProperty("--code-font-size", `${appearance.codeFontSize}px`);
    root.style.setProperty("--chat-width", `${appearance.chatWidth}px`);
    root.dataset.toolDensity = appearance.toolCallDensity < 40 ? "compact" : "detailed";
    root.dataset.codeWrap = appearance.codeWordWrap ? "true" : "false";
    root.dataset.themedDiff = appearance.themedDiffBackgrounds ? "true" : "false";
  }, [state.appearance]);

  // Desktop chats live in the history database; localStorage keeps only view settings there.
  const [historyReady, setHistoryReady] = useState(() => typeof window === "undefined" || !window.enduranceHistory);
  const persisted = useRef(new Map<string, Thread>());
  const threadsRef = useRef(state.threads);
  useEffect(() => {
    threadsRef.current = state.threads;
  }, [state.threads]);
  useEffect(() => {
    const history = window.enduranceHistory;
    if (!history) return;
    let cancelled = false;
    (async () => {
      const sessions = await history.sessions();
      window.localStorage.removeItem(LEGACY_MIGRATED_KEY);
      if (cancelled) return;
      const stored = sessions.map(fromSession);
      for (const thread of stored) persisted.current.set(thread.id, thread);
      setState((s) => ({
        ...s,
        threads: [...s.threads.filter((thread) => thread.temporary || (!hasMessages(thread) && !stored.some((item) => item.id === thread.id))), ...stored],
      }));
      setHistoryReady(true);
    })().catch(() => setHistoryReady(true));
    return () => {
      cancelled = true;
    };
  }, []);
  // A saved chat's messages are read when it is opened. What is read counts as saved, so it is not written back.
  const loading = useRef(new Set<string>());
  const unread = state.threads.find((thread) => thread.id === state.activeId && thread.loaded === false);
  useEffect(() => {
    const history = window.enduranceHistory;
    if (!history || !unread || loading.current.has(unread.id)) return;
    const id = unread.id;
    loading.current.add(id);
    history
      .messages(id)
      .then((messages) =>
        setState((s) => ({
          ...s,
          threads: s.threads.map((thread) => {
            if (thread.id !== id || thread.loaded !== false) return thread;
            const { loaded: _loaded, messageCount: _count, replyModel: _model, ...rest } = thread;
            void _loaded;
            void _count;
            void _model;
            const read = { ...rest, messages };
            if (persisted.current.get(id) === thread) persisted.current.set(id, read);
            return read;
          }),
        }))
      )
      .catch((error: unknown) => console.warn("Could not read the chat", error))
      .finally(() => loading.current.delete(id));
  }, [unread]);
  useEffect(() => {
    const history = window.enduranceHistory;
    if (!history || !historyReady) return;
    const flush = () => {
      const current = new Map(threadsRef.current.filter((thread) => !thread.temporary && hasMessages(thread)).map((thread) => [thread.id, thread]));
      for (const [id, thread] of current)
        if (persisted.current.get(id) !== thread) {
          persisted.current.set(id, thread);
          history.saveSession(toSession(thread)).catch((error: unknown) => {
            persisted.current.delete(id);
            console.warn("Could not save chat history", error);
          });
        }
      for (const id of [...persisted.current.keys()])
        if (!current.has(id)) {
          persisted.current.delete(id);
          history.deleteSession(id).catch(() => {});
        }
    };
    const timer = setTimeout(flush, 400);
    // Closing the window must not drop the last reply.
    window.addEventListener("pagehide", flush);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [state.threads, historyReady]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const { threads, projects, sidebarView, settings, sidebarOpen, workspaceOpen, appearance, general, modelOrder } = state;
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          threads: window.enduranceHistory ? undefined : threads.filter((t) => !t.temporary),
          // Kept in localStorage only until the main process has the projects.
          projects: window.enduranceWorkspace && projectsReady ? undefined : projects,
          sidebarView,
          settings,
          sidebarOpen,
          workspaceOpen,
          appearance,
          general,
          modelOrder,
        })
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [state, projectsReady]);

  const newThread = useCallback((opts?: { temporary?: boolean; projectId?: string | null }) => {
    const id = nanoid(10);
    setState((s) => {
      const current = s.threads.find((t) => t.id === s.activeId);
      const projectId =
        opts?.projectId === null ? undefined : (opts?.projectId ?? current?.projectId);
      const thread = { ...blankThread(opts?.temporary, projectId), id };
      const reuse =
        current &&
        !hasMessages(current) &&
        !current.temporary &&
        !opts?.temporary &&
        current.projectId === projectId;
      if (reuse) return { ...s, librarySection: null };
      const threads = s.threads.filter((t) => hasMessages(t) || t.pinned);
      return { ...s, threads: [thread, ...threads], activeId: thread.id, librarySection: null };
    });
    return id;
  }, []);

  // Shows what was saved: on desktop the main process's answer, so a failed save never looks saved.
  const commitProject = useCallback(async (project: Project) => {
    const workspace = window.enduranceWorkspace;
    const saved: Project = workspace ? await workspace.saveProject(toStoredProject(project)) : project;
    setState((s) => ({
      ...s,
      projects: s.projects.some((p) => p.id === saved.id) ? s.projects.map((p) => (p.id === saved.id ? saved : p)) : [...s.projects, saved],
    }));
    return saved;
  }, []);

  const createProject = useCallback(
    async (name: string, access?: WorkspacePolicy, instructions?: string) => {
      const project: Project = { id: nanoid(8), name, createdAt: Date.now(), ...(access?.folders.length ? { access } : {}), ...(instructions ? { instructions } : {}) };
      return (await commitProject(project)).id;
    },
    [commitProject]
  );

  const updateProject = useCallback(
    async (id: string, patch: Partial<Project>) => {
      const current = projectsRef.current.find((p) => p.id === id);
      if (current) await commitProject({ ...current, ...patch });
    },
    [commitProject]
  );

  const removeProject = useCallback(async (id: string) => {
    await window.enduranceWorkspace?.removeProject(id);
    setState((s) => ({
      ...s,
      projects: s.projects.filter((p) => p.id !== id),
      threads: s.threads.map((t) => (t.projectId === id ? { ...t, projectId: undefined } : t)),
    }));
  }, []);

  const restoreProject = useCallback(
    async (project: Project, threadIds: string[]) => {
      await commitProject(project);
      setState((s) => ({
        ...s,
        threads: s.threads.map((t) => (threadIds.includes(t.id) ? { ...t, projectId: project.id } : t)),
      }));
    },
    [commitProject]
  );

  const setSidebarView = useCallback((patch: Partial<SidebarView>) => {
    setState((s) => ({ ...s, sidebarView: { ...s.sidebarView, ...patch } }));
  }, []);

  const markAllRead = useCallback(() => {
    setState((s) => ({
      ...s,
      statuses: Object.fromEntries(
        Object.entries(s.statuses).map(([k, v]) => [k, v === "unread" ? "idle" : v])
      ),
    }));
  }, []);

  const selectThread = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      activeId: id,
      // Choosing a chat leaves the Library page, which shares the sidebar with the chat list.
      librarySection: null,
      threads: s.threads.filter((t) => hasMessages(t) || t.id === id || t.pinned),
      statuses: s.statuses[id] === "unread" ? { ...s.statuses, [id]: "idle" } : s.statuses,
    }));
  }, []);

  const updateThread = useCallback((id: string, patch: Partial<Thread>) => {
    setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  }, []);

  const deleteThread = useCallback((id: string) => {
    dropDraft(id);
    setState((s) => {
      const threads = s.threads.filter((t) => t.id !== id);
      if (threads.length === 0) {
        const t = blankThread();
        return { ...s, threads: [t], activeId: t.id };
      }
      return { ...s, threads, activeId: s.activeId === id ? threads[0].id : s.activeId };
    });
  }, []);

  const setSettings = useCallback((patch: Partial<ChatSettings>) => {
    setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  }, []);

  const chooseForChat = useCallback((id: string, patch: ChatChoice) => {
    setState((s) => {
      const settings = patch.model ? { ...s.settings, model: patch.model } : s.settings;
      // Only a model or effort pins the chat's model; the approval mode alone leaves it following its replies.
      const start = (t: Thread) => t.choice ?? (patch.model || patch.effort ? { model: chatModelId(t, s.settings.model) } : {});
      const threads = s.threads.map((t) => (t.id === id ? { ...t, choice: nextChoice(start(t), patch) } : t));
      return { ...s, settings, threads };
    });
  }, []);

  const setStatus = useCallback((id: string, status: ThreadStatus) => {
    setState((s) => {
      const prev = s.statuses[id];
      if (prev === status) return s;
      const next =
        status === "idle" && prev === "streaming" && s.activeId !== id ? "unread" : status;
      return { ...s, statuses: { ...s.statuses, [id]: next } };
    });
  }, []);

  const setSidebarOpen = useCallback((open: boolean | ((v: boolean) => boolean)) => {
    setState((s) => ({ ...s, sidebarOpen: typeof open === "function" ? open(s.sidebarOpen) : open }));
  }, []);

  const setWorkspaceOpen = useCallback((open: boolean | ((v: boolean) => boolean)) => {
    setState((s) => ({
      ...s,
      workspaceOpen: typeof open === "function" ? open(s.workspaceOpen) : open,
    }));
  }, []);

  const setPaletteOpen = useCallback((paletteOpen: boolean) => {
    setState((s) => ({ ...s, paletteOpen }));
  }, []);

  const setModelPickerOpen = useCallback((modelPickerOpen: boolean) => {
    setState((s) => ({ ...s, modelPickerOpen }));
  }, []);

  const openProjectSettings = useCallback((projectSettingsId: string | null) => {
    setState((s) => ({ ...s, projectSettingsId }));
  }, []);

  const openNewProject = useCallback((assignThreadId?: string | null) => {
    setState((s) => ({ ...s, newProjectFor: assignThreadId ?? null }));
  }, []);

  const closeNewProject = useCallback(() => {
    setState((s) => ({ ...s, newProjectFor: undefined }));
  }, []);

  const setSettingsSection = useCallback((settingsSection: string | null) => {
    setState((s) => ({ ...s, settingsSection, librarySection: settingsSection === null ? s.librarySection : null }));
  }, []);

  const setLibrarySection = useCallback((librarySection: string | null) => {
    setState((s) => ({ ...s, librarySection, settingsSection: librarySection === null ? s.settingsSection : null }));
  }, []);

  const setAppearance = useCallback((patch: Partial<AppearanceSettings>) => {
    setState((s) => ({ ...s, appearance: { ...s.appearance, ...patch } }));
  }, []);

  const setGeneral = useCallback((patch: Partial<GeneralSettings>) => {
    setState((s) => ({ ...s, general: { ...s.general, ...patch } }));
  }, []);

  const setModelOrder = useCallback((patch: Partial<ModelOrder>) => {
    setState((s) => ({ ...s, modelOrder: { ...s.modelOrder, ...patch } }));
  }, []);

  const detectRuntimes = useCallback(() => {
    window.endurance?.detect().catch(() => {});
  }, []);
  // Servers already running at their default address are listed without the person adding them.
  useEffect(() => {
    detectRuntimes();
  }, [detectRuntimes]);
  const addRuntime = useCallback((id: RuntimeId) => {
    window.endurance?.addRuntime(id).catch(() => {});
  }, []);
  const removeConnection = useCallback(async (id: string) => {
    await window.endurance?.removeConnection(id);
  }, []);

  const value = useMemo<Store>(
    () => ({
      ...state,
      refreshModels,
      newThread,
      createProject,
      updateProject,
      removeProject,
      restoreProject,
      setSidebarView,
      markAllRead,
      selectThread,
      updateThread,
      deleteThread,
      setSettings,
      chooseForChat,
      setStatus,
      setSidebarOpen,
      setWorkspaceOpen,
      setPaletteOpen,
      setModelPickerOpen,
      openProjectSettings,
      openNewProject,
      closeNewProject,
      setSettingsSection,
      setLibrarySection,
      setAppearance,
      setGeneral,
      setModelOrder,
      detectRuntimes,
      addRuntime,
      removeConnection,
    }),
    [
      state,
      refreshModels,
      newThread,
      createProject,
      updateProject,
      removeProject,
      restoreProject,
      setSidebarView,
      markAllRead,
      selectThread,
      updateThread,
      deleteThread,
      setSettings,
      chooseForChat,
      setStatus,
      setSidebarOpen,
      setWorkspaceOpen,
      setPaletteOpen,
      setModelPickerOpen,
      openProjectSettings,
      openNewProject,
      closeNewProject,
      setSettingsSection,
      setLibrarySection,
      setAppearance,
      setGeneral,
      setModelOrder,
      detectRuntimes,
      addRuntime,
      removeConnection,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}
