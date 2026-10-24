import { getModel } from "./models";
import { materialize, moveId, rankOf, type DropPosition } from "./ordering";
import { hasMessages, type OrderBy, type Project, type SidebarView, type Thread, type ThreadStatus } from "./store";

export interface ThreadGroup {
  key: string;
  label: string;
  kind: "pinned" | "project" | "plain";
  projectId?: string;
  items: Thread[];
}

const DAY = 86_400_000;

export const threadModel = (t: Thread) =>
  t.messages.findLast((m) => m.role === "assistant" && m.metadata?.model)?.metadata?.model ?? t.replyModel;

export const threadStatus = (t: Thread, statuses: Record<string, ThreadStatus>): ThreadStatus =>
  statuses[t.id] ?? "idle";

/** How chats are ordered in every grouping. Custom puts chats not yet placed by hand first, newest on top. */
export function compareThreads(view: Pick<SidebarView, "orderBy" | "customOrder">) {
  if (view.orderBy === "custom") {
    const rank = rankOf(view.customOrder.threads);
    return (a: Thread, b: Thread) => (rank(a.id) ?? -1) - (rank(b.id) ?? -1) || b.updatedAt - a.updatedAt;
  }
  return (a: Thread, b: Thread) =>
    view.orderBy === "title"
      ? a.title.localeCompare(b.title)
      : view.orderBy === "created"
        ? b.createdAt - a.createdAt
        : b.updatedAt - a.updatedAt;
}

/** Sort key for a group: its most recent (or earliest-created / alphabetical) member. */
const groupRank = (group: ThreadGroup, orderBy: OrderBy, project?: Project) => {
  if (orderBy === "title") return group.label.toLowerCase();
  if (group.items.length === 0) return orderBy === "created" ? (project?.createdAt ?? 0) : 0;
  return Math.max(...group.items.map((t) => (orderBy === "created" ? t.createdAt : t.updatedAt)));
};

function sortGroups(groups: ThreadGroup[], view: SidebarView, projects: Project[]) {
  const by = (orderBy: OrderBy) => (a: ThreadGroup, b: ThreadGroup) => {
    const ra = groupRank(a, orderBy, projects.find((p) => p.id === a.projectId));
    const rb = groupRank(b, orderBy, projects.find((p) => p.id === b.projectId));
    if (typeof ra === "string" && typeof rb === "string") return ra.localeCompare(rb);
    return (rb as number) - (ra as number);
  };
  if (view.orderBy !== "custom") return groups.sort(by(view.orderBy));
  // Groups not yet placed by hand, such as a new project, come first.
  const rank = rankOf(view.customOrder.groups);
  const recent = by("updated");
  return groups.sort((a, b) => (rank(a.key) ?? -1) - (rank(b.key) ?? -1) || recent(a, b));
}

const STATUS_LABEL: Record<ThreadStatus, string> = {
  streaming: "Running",
  awaiting: "Needs approval",
  unread: "Unread",
  error: "Failed",
  idle: "Idle",
};

export function buildGroups(
  threads: Thread[],
  projects: Project[],
  view: SidebarView,
  statuses: Record<string, ThreadStatus>,
  query: string
): ThreadGroup[] {
  const { filters } = view;
  const q = query.trim().toLowerCase();
  const visible = threads.filter((t) => {
    if (!hasMessages(t) && !t.pinned) return false;
    if (q && !t.title.toLowerCase().includes(q)) return false;
    if (filters.statuses.length && !filters.statuses.includes(threadStatus(t, statuses))) return false;
    if (filters.models.length && !filters.models.includes(threadModel(t) ?? "")) return false;
    if (filters.projects.length && !filters.projects.includes(t.projectId ?? "none")) return false;
    return true;
  });

  const order = compareThreads(view);
  const groups: ThreadGroup[] = [];

  let rest = visible;
  if (view.pinnedOnTop && view.groupBy !== "none") {
    const pinned = visible.filter((t) => t.pinned);
    rest = visible.filter((t) => !t.pinned);
    if (pinned.length) groups.push({ key: "pinned", label: "Pinned", kind: "pinned", items: pinned.sort(order) });
  }

  const bucket = (keyOf: (t: Thread) => string, labelOf: (key: string) => string, kind: ThreadGroup["kind"] = "plain") => {
    const map = new Map<string, ThreadGroup>();
    for (const t of rest) {
      const key = keyOf(t);
      if (!map.has(key)) map.set(key, { key, label: labelOf(key), kind, items: [] });
      map.get(key)?.items.push(t);
    }
    return map;
  };

  switch (view.groupBy) {
    case "project": {
      const map = bucket(
        (t) => t.projectId ?? "none",
        (key) => projects.find((p) => p.id === key)?.name ?? "Chats",
        "project"
      );
      if (!q && !filters.statuses.length && !filters.models.length) {
        for (const p of projects) {
          // A project with folders stays visible before its first chat, so it can start one.
          if (!view.showEmptyProjects && !p.access?.folders.length) continue;
          if (!map.has(p.id) && (!filters.projects.length || filters.projects.includes(p.id))) {
            map.set(p.id, { key: p.id, label: p.name, kind: "project", items: [] });
          }
        }
      }
      const list = [...map.values()].map((g) => ({
        ...g,
        projectId: g.key === "none" ? undefined : g.key,
        items: g.items.sort(order),
      }));
      const sorted = sortGroups(list, view, projects);
      const isPinned = (g: ThreadGroup) => Boolean(projects.find((p) => p.id === g.projectId)?.pinned);
      groups.push(...sorted.filter(isPinned), ...sorted.filter((g) => !isPinned(g)));
      break;
    }
    case "date": {
      const today = new Date().setHours(0, 0, 0, 0);
      const field = view.orderBy === "created" ? "createdAt" : "updatedAt";
      const labels = ["Today", "Yesterday", "Previous 7 days", "Older"];
      const map = bucket(
        (t) => {
          const at = t[field];
          if (at >= today) return labels[0];
          if (at >= today - DAY) return labels[1];
          if (at >= today - 7 * DAY) return labels[2];
          return labels[3];
        },
        (key) => key
      );
      for (const label of labels) {
        const g = map.get(label);
        if (g) groups.push({ ...g, items: g.items.sort(order) });
      }
      break;
    }
    case "status": {
      const map = bucket((t) => threadStatus(t, statuses), (key) => STATUS_LABEL[key as ThreadStatus]);
      for (const key of ["streaming", "awaiting", "unread", "error", "idle"] as ThreadStatus[]) {
        const g = map.get(key);
        if (g) groups.push({ ...g, items: g.items.sort(order) });
      }
      break;
    }
    case "model": {
      const map = bucket(
        (t) => threadModel(t) ?? "unknown",
        (key) => (key === "unknown" ? "No model" : getModel(key).name)
      );
      groups.push(...sortGroups([...map.values()].map((g) => ({ ...g, items: g.items.sort(order) })), view, projects));
      break;
    }
    case "none":
      groups.push({ key: "all", label: "", kind: "plain", items: rest.sort(order) });
  }

  return groups.filter((g) => g.items.length > 0 || g.kind === "project");
}

/** Chats the sidebar can list, in the order the current sort puts them across every group. */
const listedThreadIds = (threads: Thread[], view: SidebarView) =>
  threads
    .filter((t) => !t.temporary && (hasMessages(t) || t.pinned))
    .sort(compareThreads(view))
    .map((t) => t.id);

/**
 * The custom chat order after a drop: the order the person sees now, with `id` moved next to `anchor`.
 * Without an anchor (an empty project) the order stays as shown, so switching to Custom moves nothing.
 */
export function reorderThreads(threads: Thread[], view: SidebarView, id: string, anchor: string | undefined, position: DropPosition) {
  const shown = listedThreadIds(threads, view);
  return anchor ? moveId(shown, id, anchor, position) : shown;
}

/** The custom project order after a drop. "none" stands for the Chats group of chats without a project. */
export function reorderGroups(groups: ThreadGroup[], view: SidebarView, projects: Project[], id: string, anchor: string, position: DropPosition) {
  const shown = groups.filter((g) => g.kind === "project").map((g) => g.key);
  const all = [...projects.map((p) => p.id), "none"];
  return moveId(materialize(shown, view.customOrder.groups, all), id, anchor, position);
}
