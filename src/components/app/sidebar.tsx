"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getModel } from "@/lib/models";
import type { DropPosition } from "@/lib/ordering";
import { buildGroups, reorderGroups, reorderThreads, threadModel, type ThreadGroup } from "@/lib/sidebar-groups";
import {
  DEFAULT_VIEW,
  hasMessages,
  useStore,
  type GroupBy,
  type OrderBy,
  type Project,
  type SidebarView,
  type Thread,
  type ThreadStatus,
} from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  ArrowDownAZIcon,
  BookMarkedIcon,
  CalendarClockIcon,
  CalendarPlusIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderSearchIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GhostIcon,
  GripVerticalIcon,
  ListFilterIcon,
  ListIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { SettingsNav } from "./settings-nav";
import { SidebarDownloads } from "@/features/model-settings/downloads";
import { NewProjectDialog, ProjectSettingsDialog } from "./project-dialog";
import { librarySectionToOpen } from "./library";
import { DragCard, DropIndicator, Reorderable, useReorderDrag, useReorderDrop, type DragItem, type DropTarget } from "./reorder";
import { canExportChat, exportChat } from "./export-chat";

const GROUPINGS: { id: GroupBy; label: string; icon: typeof FolderIcon }[] = [
  { id: "project", label: "Project", icon: FolderIcon },
  { id: "date", label: "Date", icon: ClockIcon },
  { id: "status", label: "Status", icon: CircleDashedIcon },
  { id: "model", label: "Model", icon: SparklesIcon },
  { id: "none", label: "None", icon: ListIcon },
];

const ORDERINGS: { id: OrderBy; label: string; icon: typeof FolderIcon }[] = [
  { id: "updated", label: "Latest update", icon: CalendarClockIcon },
  { id: "created", label: "Date created", icon: CalendarPlusIcon },
  { id: "title", label: "Title (A–Z)", icon: ArrowDownAZIcon },
  { id: "custom", label: "Custom", icon: GripVerticalIcon },
];

/** Text starts here in rows under a project header: row padding, the folder icon and its gap. */
const INDENT = 31;
/** The `gap-3` between groups and `gap-0.5` between rows, in px: drop lines sit in the middle of them. */
const GROUP_GAP = 12;
const ROW_GAP = 2;

const STATUS_FILTERS: { id: ThreadStatus; label: string; dot: string }[] = [
  { id: "streaming", label: "Running", dot: "bg-sky-500" },
  { id: "awaiting", label: "Needs approval", dot: "bg-amber-500" },
  { id: "unread", label: "Unread", dot: "bg-sky-400" },
  { id: "error", label: "Failed", dot: "bg-red-500" },
  { id: "idle", label: "Idle", dot: "bg-muted-foreground/40" },
];

const sidebarFill =
  "hover:bg-sidebar-accent/60 dark:not-aria-expanded:hover:bg-sidebar-accent/60 aria-expanded:bg-sidebar-accent active:translate-y-0!";
const navRow = cn("h-7 justify-start gap-2 rounded-[6px] px-2 font-normal text-[13px] [&_svg]:size-[15px]", sidebarFill);
/** A nav row whose page is open, like the Settings button while settings show. */
const pressedRow =
  "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent dark:not-aria-expanded:hover:bg-sidebar-accent";
/** A 24px action inset 2px in a 28px row: 6px row corner − 2px inset. */
const rowAction = "size-6 rounded-[4px]";

const toggle = <T,>(list: T[], value: T) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

function ActiveDot({ on }: { on: boolean }) {
  return on ? <span className="ml-auto size-1.5 rounded-full bg-foreground/60" /> : null;
}

const searchRowIcon = cn(
  "size-7 rounded-[6px] border-0 bg-clip-border p-0 text-muted-foreground shadow-none focus-visible:border-transparent focus-visible:ring-0 active:translate-y-0!",
  sidebarFill
);

const filterSubCard = "w-[12.5rem]";
const filterSubRow = "h-[26px] rounded-[8px] py-0 text-[13px] font-normal leading-none";

function FilterMenu() {
  const { sidebarView: view, setSidebarView, projects, threads, markAllRead } = useStore();
  const { filters } = view;
  const setFilters = (patch: Partial<SidebarView["filters"]>) =>
    setSidebarView({ filters: { ...filters, ...patch } });
  const filterCount = filters.statuses.length + filters.models.length + filters.projects.length;
  const usedModels = useMemo(
    () => [...new Set(threads.map(threadModel).filter((m): m is string => Boolean(m)))],
    [threads]
  );
  const grouping = GROUPINGS.find((g) => g.id === view.groupBy);
  const ordering = ORDERINGS.find((o) => o.id === view.orderBy);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button aria-label="Filter and sort" className={cn(searchRowIcon, "relative")} size="icon-sm" variant="ghost" />
              }
            />
          }
        >
          <ListFilterIcon />
          {filterCount > 0 && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-sky-500" />}
        </TooltipTrigger>
        <TooltipContent>Filter and sort</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="w-60"
        collisionAvoidance={{ side: "flip", align: "none", fallbackAxisSide: "none" }}
        side="right"
        sideOffset={3}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="[&>svg:last-child]:ml-0">
            Group by
            <span className="ml-auto text-right text-muted-foreground text-xs">{grouping?.label}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={filterSubCard}>
            <DropdownMenuRadioGroup onValueChange={(v) => setSidebarView({ groupBy: v as GroupBy })} value={view.groupBy}>
              {GROUPINGS.map((g) => (
                <DropdownMenuRadioItem className={filterSubRow} key={g.id} value={g.id}>
                  <g.icon className="text-muted-foreground" /> {g.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="[&>svg:last-child]:ml-0">
            Sort by
            <span className="ml-auto text-right text-muted-foreground text-xs">{ordering?.label}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={filterSubCard}>
            <DropdownMenuRadioGroup onValueChange={(v) => setSidebarView({ orderBy: v as OrderBy })} value={view.orderBy}>
              {ORDERINGS.map((o) => (
                <DropdownMenuRadioItem className={filterSubRow} key={o.id} value={o.id}>
                  <o.icon className="text-muted-foreground" /> {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Show</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={filterSubCard}>
            <DropdownMenuCheckboxItem
              checked={view.pinnedOnTop}
              className={filterSubRow}
              onCheckedChange={(v) => setSidebarView({ pinnedOnTop: v })}
            >
              Pinned on top
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={view.showEmptyProjects}
              className={filterSubRow}
              onCheckedChange={(v) => setSidebarView({ showEmptyProjects: v })}
            >
              Empty projects
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between">
            Filters
            <button
              className="rounded px-1 text-muted-foreground text-xs hover:text-foreground disabled:opacity-40"
              disabled={filterCount === 0}
              onClick={() => setSidebarView({ filters: DEFAULT_VIEW.filters })}
              type="button"
            >
              Reset
            </button>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Status
            <ActiveDot on={filters.statuses.length > 0} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={filterSubCard}>
            {STATUS_FILTERS.map((s) => (
              <DropdownMenuCheckboxItem
                checked={filters.statuses.includes(s.id)}
                className={filterSubRow}
                key={s.id}
                onCheckedChange={() => setFilters({ statuses: toggle(filters.statuses, s.id) })}
              >
                <span className={cn("size-2 rounded-full", s.dot)} /> {s.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Project
            <ActiveDot on={filters.projects.length > 0} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={filterSubCard}>
            {[...projects, { id: "none", name: "No project" }].map((p) => (
              <DropdownMenuCheckboxItem
                checked={filters.projects.includes(p.id)}
                className={filterSubRow}
                key={p.id}
                onCheckedChange={() => setFilters({ projects: toggle(filters.projects, p.id) })}
              >
                <FolderIcon className="text-muted-foreground" /> {p.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Model
            <ActiveDot on={filters.models.length > 0} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={filterSubCard}>
            {usedModels.length === 0 && <div className="px-2 py-1.5 text-muted-foreground text-xs">No models used yet</div>}
            {usedModels.map((m) => (
              <DropdownMenuCheckboxItem
                checked={filters.models.includes(m)}
                className={filterSubRow}
                key={m}
                onCheckedChange={() => setFilters({ models: toggle(filters.models, m) })}
              >
                {getModel(m).name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={markAllRead}>Mark all as read</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NewProjectHost() {
  const { newProjectFor, closeNewProject } = useStore();
  if (newProjectFor === undefined) return null;
  return <NewProjectDialog assignThreadId={newProjectFor} onClose={closeNewProject} />;
}

function AddMenu() {
  const { newThread, openNewProject } = useStore();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button aria-label="New" className={searchRowIcon} size="icon-sm" variant="ghost" />}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipContent>New chat or project</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="w-56"
        collisionAvoidance={{ side: "flip", align: "none", fallbackAxisSide: "none" }}
        side="right"
        sideOffset={3}
      >
        <DropdownMenuItem onClick={() => newThread()}>
          <SquarePenIcon /> New chat
          <DropdownMenuShortcut>⌘⇧O</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => newThread({ temporary: true })}>
          <GhostIcon /> Temporary chat
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openNewProject()}>
          <FolderPlusIcon /> New project…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const STATUS_LABEL: Partial<Record<ThreadStatus, string>> = {
  streaming: "Responding",
  awaiting: "Needs approval",
  unread: "New response",
  error: "Failed",
};

function StatusDot({ status }: { status: ThreadStatus | undefined }) {
  const label = status && STATUS_LABEL[status];
  if (!label) return null;
  if (status === "streaming") return <LoaderCircleIcon aria-label={label} className="size-3.5 shrink-0 animate-spin text-sky-500 motion-reduce:animate-none" role="img" />;
  const color = status === "awaiting" ? "bg-amber-500" : status === "unread" ? "bg-sky-500" : "bg-red-500";
  return <span aria-label={label} className={cn("size-2 shrink-0 rounded-full", color)} role="img" title={label} />;
}

/** What a dragged chat carries and what a chat row offers as a target: the group it is shown in. */
interface ChatSpot {
  groupKey: string;
}
interface ProjectSpot {
  pinned: boolean;
}

/** One node is both the drag handle and the drop target for a row. */
function useBothRefs(a: (node: HTMLElement | null) => void, b: (node: HTMLElement | null) => void) {
  return useCallback(
    (node: HTMLElement | null) => {
      a(node);
      b(node);
    },
    [a, b]
  );
}

function ThreadRow({ thread, group, indent, reorderable }: { thread: Thread; group: ThreadGroup; indent: boolean; reorderable: boolean }) {
  const { activeId, selectThread, updateThread, deleteThread, statuses, projects, librarySection } = useStore();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  // While the Library page is open, its button is the one selected row; the chat behind it is not shown.
  const active = thread.id === activeId && librarySection === null;
  const status = statuses[thread.id];
  const spot: ChatSpot = { groupKey: group.key };
  const drag = useReorderDrag({ kind: "chat", id: thread.id, data: spot }, !reorderable || renaming);
  const drop = useReorderDrop({ kind: "chat", id: thread.id, data: spot, accepts: ["chat"] }, !reorderable);
  const ref = useBothRefs(drag.setNode, drop.setNode);

  return (
    <div
      {...drag.handle}
      data-current={active || undefined}
      data-reorder-row=""
      className={cn(
        "group/row relative flex h-7 items-center gap-2 rounded-[6px] pr-1 text-[13px] transition-colors",
        indent ? "pl-[calc(0.5rem+15px+0.5rem)]" : "pl-2",
        drag.dragging && "opacity-40",
        // Keyboard focus reads like hover: the row's own fill, not an outline around the title.
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 has-[:focus-visible]:bg-sidebar-accent/60"
      )}
      ref={ref}
    >
      <DropIndicator gap={ROW_GAP} inset={indent ? INDENT : 8} placement={drop.placement} />
      {renaming ? (
        <input
          autoFocus
          className="h-6 flex-1 rounded border bg-background px-1.5 text-sm outline-none"
          onBlur={() => {
            updateThread(thread.id, { title: draft.trim() || thread.title });
            setRenaming(false);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(thread.title);
              setRenaming(false);
            }
          }}
          value={draft}
        />
      ) : (
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none" onClick={() => selectThread(thread.id)} type="button">
          {thread.temporary && <GhostIcon className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]">
            {thread.title}
          </span>
        </button>
      )}
      {/* Status and the options button share one slot. Pointing at the row, tabbing to it or opening its menu
          swaps the status for the button in place, so they never draw over each other and nothing moves. */}
      {!renaming && status && STATUS_LABEL[status] && (
        <span className="-mr-0.5 grid size-6 shrink-0 place-items-center transition-opacity duration-150 group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0 group-has-[[aria-expanded=true]]/row:opacity-0 motion-reduce:transition-none">
          <StatusDot status={status} />
        </span>
      )}
      {!renaming && (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Thread options"
              data-row-actions=""
              className={cn(
                rowAction,
                "absolute top-1/2 right-0.5 z-10 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 aria-expanded:opacity-100 motion-reduce:transition-none"
              )}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onClick={() => updateThread(thread.id, { pinned: !thread.pinned })}>
            {thread.pinned ? <PinOffIcon /> : <PinIcon />} {thread.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setDraft(thread.title);
              setRenaming(true);
            }}
          >
            <PencilIcon /> Rename
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInputIcon /> Move to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuRadioGroup
                onValueChange={(v) => updateThread(thread.id, { projectId: v === "none" ? undefined : (v as string) })}
                value={thread.projectId ?? "none"}
              >
                {projects.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id}>
                    {p.name}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem value="none">No project</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {canExportChat() && hasMessages(thread) && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <DownloadIcon /> Export
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuItem onClick={() => void exportChat(thread, "markdown")}>Markdown</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void exportChat(thread, "json")}>JSON</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              deleteThread(thread.id);
              toast("Chat deleted");
            }}
            variant="destructive"
          >
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      )}
    </div>
  );
}

export function ProjectSettingsHost() {
  const { projectSettingsId, projects, openProjectSettings } = useStore();
  const project = projects.find((p) => p.id === projectSettingsId);
  if (!project) return null;
  return <ProjectSettingsDialog key={project.id} onClose={() => openProjectSettings(null)} project={project} />;
}

const projectPath = (project: Project) => project.access?.folders[0]?.path;

function ProjectMenu({ project, chatIds }: { project: Project; chatIds: string[] }) {
  const { updateProject, removeProject, restoreProject, newThread, openProjectSettings } = useStore();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`${project.name} options`}
              className={cn(rowAction, "opacity-0 group-hover/project:opacity-100 aria-expanded:opacity-100")}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-52"
          collisionAvoidance={{ side: "flip", align: "none", fallbackAxisSide: "none" }}
          side="right"
          sideOffset={3}
        >
          <DropdownMenuItem className={filterSubRow} onClick={() => newThread({ projectId: project.id })}>
            <SquarePenIcon className="size-[15px]" /> New chat
          </DropdownMenuItem>
          <DropdownMenuItem className={filterSubRow} onClick={() => openProjectSettings(project.id)}>
            <Settings2Icon className="size-[15px]" /> Project settings…
          </DropdownMenuItem>
          <DropdownMenuItem className={filterSubRow} onClick={() => updateProject(project.id, { pinned: !project.pinned }).catch(projectError)}>
            {project.pinned ? <PinOffIcon className="size-[15px]" /> : <PinIcon className="size-[15px]" />} {project.pinned ? "Unpin project" : "Pin project"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {projectPath(project) && (
            <>
              <DropdownMenuItem className={filterSubRow} onClick={() => void window.enduranceWorkspace?.revealFolder(projectPath(project)!)}>
                <FolderSearchIcon className="size-[15px]" /> Reveal in Finder
              </DropdownMenuItem>
              <DropdownMenuItem
                className={filterSubRow}
                onClick={() => {
                  (navigator.clipboard?.writeText(projectPath(project)!) ?? Promise.reject()).then(
                    () => toast("Path copied"),
                    () => toast("Couldn't copy the path")
                  );
                }}
              >
                <CopyIcon className="size-[15px]" /> Copy path
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            className={filterSubRow}
            onClick={() =>
              removeProject(project.id).then(
                () =>
                  toast(`Removed “${project.name}”`, {
                    description: chatIds.length ? `${chatIds.length} chats moved to Chats` : undefined,
                    action: { label: "Undo", onClick: () => restoreProject(project, chatIds).catch(projectError) },
                  }),
                projectError
              )
            }
            variant="destructive"
          >
            <FolderMinusIcon className="size-[15px]" /> Remove project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

const projectError = () => toast.error("Couldn't save the project");

function GroupSection({ group, reorderable }: { group: ThreadGroup; reorderable: boolean }) {
  const { newThread, projects, updateProject } = useStore();
  const project = projects.find((p) => p.id === group.projectId);
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = project ? Boolean(project.collapsed) : localCollapsed;
  const toggleCollapsed = () =>
    project ? updateProject(project.id, { collapsed: !project.collapsed }).catch(projectError) : setLocalCollapsed((c) => !c);

  // A project is dragged by its header and lands before or after another project's whole block.
  // Its header also takes chats dropped into the project, even while it is collapsed.
  const movable = reorderable && group.kind === "project";
  const place: ProjectSpot = { pinned: Boolean(project?.pinned) };
  const drag = useReorderDrag({ kind: "project", id: group.key, data: place }, !movable);
  const { setNode: setBlock, placement: blockPlacement } = useReorderDrop(
    { kind: "project", id: group.key, data: place, accepts: ["project"] },
    !movable
  );
  const header = useReorderDrop(
    { kind: "project-header", id: group.key, data: { groupKey: group.key } satisfies ChatSpot, accepts: ["chat"], mode: "into" },
    !movable
  );
  const headerRef = useBothRefs(drag.setNode, header.setNode);

  if (group.kind !== "project") {
    return (
      <div>
        {group.label && <div className="px-2 pt-1 pb-0.5 font-medium text-[11px] text-muted-foreground">{group.label}</div>}
        <div className="flex flex-col gap-0.5">
          {group.items.map((t) => (
            <ThreadRow group={group} indent={false} key={t.id} reorderable={reorderable} thread={t} />
          ))}
        </div>
      </div>
    );
  }

  const Icon = collapsed ? FolderIcon : FolderOpenIcon;
  return (
    <div className={cn("relative", drag.dragging && "opacity-40")} ref={setBlock}>
      <DropIndicator gap={GROUP_GAP} placement={blockPlacement} />
      <div
        {...drag.handle}
        className="group/project relative flex h-7 items-center rounded-[6px] pr-2 pl-2 text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent/60"
        data-reorder-row=""
        ref={headerRef}
      >
        <DropIndicator placement={header.placement} />
        <button
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] leading-[1.4]"
          onClick={toggleCollapsed}
          type="button"
        >
          <span className="group/icon relative grid size-[15px] shrink-0 place-items-center before:absolute before:-inset-1 before:content-['']">
            <Icon className="col-start-1 row-start-1 size-[15px] text-muted-foreground group-hover/icon:opacity-0" />
            <ChevronRightIcon
              className={cn(
                "col-start-1 row-start-1 size-[15px] text-muted-foreground opacity-0 group-hover/icon:opacity-100",
                !collapsed && "rotate-90"
              )}
            />
          </span>
          {project?.pinned && <PinIcon className="size-3 shrink-0 text-muted-foreground" />}
          <span className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]">{group.label}</span>
          {collapsed && group.items.length > 0 && (
            <span className="shrink-0 text-[10px] leading-[1.4] text-muted-foreground tabular-nums group-hover/project:invisible group-has-[[data-popup-open]]/project:invisible">
              {group.items.length}
            </span>
          )}
        </button>
        <div
          data-row-actions=""
          className="pointer-events-none absolute top-1/2 right-0.5 z-10 flex -translate-y-1/2 items-center opacity-0 group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-has-[[data-popup-open]]/project:pointer-events-auto group-has-[[data-popup-open]]/project:opacity-100">
          {project && <ProjectMenu chatIds={group.items.map((t) => t.id)} project={project} />}
          <Button
            aria-label={`New chat in ${group.label}`}
            className={rowAction}
            onClick={() => newThread({ projectId: group.projectId ?? null })}
            size="icon-xs"
            variant="ghost"
          >
            <SquarePenIcon />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={collapsed}>
          <div className="flex flex-col gap-0.5 pt-0.5">
            {group.items.map((t) => (
              <ThreadRow group={group} indent key={t.id} reorderable={reorderable} thread={t} />
            ))}
            {group.items.length === 0 && (
              <div className="py-1 pl-[calc(0.5rem+15px+0.5rem)] text-muted-foreground text-xs">No chats yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Dragging chats and projects. Any drop saves the order the person now sees and switches the sort to
 * Custom; Undo brings back the sort, the order and the chat's project as they were.
 */
function useSidebarReorder(groups: ThreadGroup[]) {
  const { threads, projects, sidebarView: view, setSidebarView, updateThread } = useStore();
  const groupFor = (key: string) => groups.find((g) => g.key === key);

  // Right after the item's previous neighbour or right before its next one is where it already is:
  // no line, rather than a line that promises a move and does nothing.
  const staysPut = (ids: string[], id: string, target: DropTarget) => {
    const from = ids.indexOf(id);
    const at = ids.indexOf(target.id);
    return from >= 0 && at >= 0 && at - from === (target.placement === "after" ? -1 : 1);
  };

  const canDrop = (item: DragItem, target: DropTarget) => {
    if (item.kind === "project") {
      const shown = groups.filter((g) => g.kind === "project").map((g) => g.key);
      // Pinned projects stay above the rest, so a project moves only among projects pinned like it.
      return (
        target.kind === "project" &&
        target.id !== item.id &&
        (target.data as ProjectSpot).pinned === (item.data as ProjectSpot).pinned &&
        !staysPut(shown, item.id, target)
      );
    }
    if (target.kind === "chat" && target.id === item.id) return false;
    const from = groupFor((item.data as ChatSpot).groupKey);
    const to = groupFor((target.data as ChatSpot).groupKey);
    if (from && from === to && target.kind === "chat" && staysPut(from.items.map((t) => t.id), item.id, target)) return false;
    // Pinned, date, status and model groups follow from the chat itself; only a project can be changed by a drop.
    return Boolean(from && to && (from.key === to.key || (from.kind === "project" && to.kind === "project")));
  };

  const onDrop = (item: DragItem, target: DropTarget) => {
    const before = { orderBy: view.orderBy, customOrder: view.customOrder };
    const thread = threads.find((t) => t.id === item.id);
    let movedTo: ThreadGroup | undefined;
    if (item.kind === "project") {
      const order = reorderGroups(groups, view, projects, item.id, target.id, target.placement as DropPosition);
      setSidebarView({ orderBy: "custom", customOrder: { ...view.customOrder, groups: order } });
    } else {
      const to = groupFor((target.data as ChatSpot).groupKey);
      if (!to || !thread) return;
      // Dropped on a project header: first in that project.
      const anchor = target.kind === "chat" ? target.id : to.items.find((t) => t.id !== item.id)?.id;
      const position = target.kind === "chat" ? (target.placement as DropPosition) : "before";
      setSidebarView({ orderBy: "custom", customOrder: { ...view.customOrder, threads: reorderThreads(threads, view, item.id, anchor, position) } });
      if (to.kind === "project" && thread.projectId !== to.projectId) {
        movedTo = to;
        updateThread(thread.id, { projectId: to.projectId });
      }
    }
    const undo = () => {
      setSidebarView(before);
      if (movedTo && thread) updateThread(thread.id, { projectId: thread.projectId });
    };
    if (movedTo) toast(`Moved to ${movedTo.label}`, { action: { label: "Undo", onClick: undo } });
    else if (before.orderBy !== "custom") toast("Sort changed to Custom", { action: { label: "Undo", onClick: undo } });
  };

  const overlay = (item: DragItem) =>
    item.kind === "project" ? (
      <DragCard>
        <FolderIcon className="size-[15px] shrink-0 text-muted-foreground" />
        <span className="truncate">{groupFor(item.id)?.label}</span>
      </DragCard>
    ) : (
      <DragCard>
        <span className="truncate">{threads.find((t) => t.id === item.id)?.title}</span>
      </DragCard>
    );

  const label = (item: DragItem) =>
    (item.kind === "project" ? groupFor(item.id)?.label : threads.find((t) => t.id === item.id)?.title) ?? "Item";

  return { canDrop, onDrop, overlay, label };
}

export function Sidebar() {
  const { threads, projects, sidebarView, statuses, newThread, openNewProject, settingsSection, setSettingsSection, librarySection, setLibrarySection } = useStore();
  const [query, setQuery] = useState("");
  const settingsOpen = settingsSection !== null;
  const groups = useMemo(
    () => buildGroups(threads, projects, sidebarView, statuses, query),
    [threads, projects, sidebarView, statuses, query]
  );
  const reorder = useSidebarReorder(groups);
  // Search results are a partial list; a drop among them would place chats next to ones the person cannot see.
  const reorderable = !query.trim();
  const filtered =
    sidebarView.filters.statuses.length + sidebarView.filters.models.length + sidebarView.filters.projects.length > 0;

  return (
    <aside className="flex h-full w-full flex-col">
      {settingsOpen ? (
        <div className="flex min-h-0 flex-1 flex-col px-2">
          <SettingsNav onBack={() => setSettingsSection(null)} />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-2">
      <div className="flex flex-col gap-0.5">
        <Button className={navRow} onClick={() => newThread()} variant="ghost">
          <SquarePenIcon className="size-4" />
          New chat
          <Kbd className="ml-auto">⌘⇧O</Kbd>
        </Button>
        <Button className={navRow} onClick={() => newThread({ temporary: true })} variant="ghost">
          <GhostIcon className="size-4" />
          Temporary chat
        </Button>
        <Button className={navRow} onClick={() => openNewProject()} variant="ghost">
          <FolderGit2Icon className="size-4" />
          Projects
        </Button>
        <Button
          aria-pressed={librarySection !== null}
          className={cn(navRow, librarySection !== null && pressedRow)}
          onClick={() => setLibrarySection(librarySection ?? librarySectionToOpen())}
          variant="ghost"
        >
          <BookMarkedIcon className="size-4" />
          Library
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-7 rounded-[6px] border-transparent bg-sidebar-accent/50 pl-7 text-[13px] shadow-none focus-visible:border-transparent"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            value={query}
          />
        </div>
        <FilterMenu />
        <AddMenu />
      </div>
      <ScrollArea className="-mr-2 min-h-0 flex-1" scrollbarClassName="w-1 p-0">
        <Reorderable {...reorder}>
        <div className="flex flex-col gap-3 pr-2 pb-2">
          {groups.map((g) => (
            <GroupSection group={g} key={g.key} reorderable={reorderable} />
          ))}
          {groups.length === 0 && (
            <p className="px-2 py-6 text-center text-muted-foreground text-xs">
              {query || filtered ? "No chats match your search or filters." : "Your chats will appear here."}
            </p>
          )}
        </div>
        </Reorderable>
      </ScrollArea>
      </div>
      )}
      {/* The Models page already shows full progress. */}
      {settingsSection !== "models" && <SidebarDownloads onOpen={() => setSettingsSection("models")} />}
      <div className="shrink-0 border-t">
        <div className="flex h-11 items-center gap-2 pr-2 pl-4">
          {/* Empty where the profile was, so Settings keeps its place at the end of the row. */}
          <div aria-hidden className="flex-1" />
          <Button
            aria-label="Settings"
            aria-pressed={settingsOpen}
            className={cn(
              "transition-none rounded-[6px]",
              sidebarFill,
              settingsOpen &&
                "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent dark:not-aria-expanded:hover:bg-sidebar-accent"
            )}
            onClick={() => setSettingsSection(settingsOpen ? null : "general")}
            size="icon-sm"
            variant="ghost"
          >
            <SettingsIcon />
          </Button>
        </div>
      </div>
    </aside>
  );
}
