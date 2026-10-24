"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatContext } from "@/lib/models";
import { estimateText } from "@/lib/token-estimate";
import { useStore, type Project } from "@/lib/store";
import { cn } from "@/lib/utils";
import { MAX_INSTRUCTIONS, type FolderEntry } from "@/lib/workspace-api";
import { ipcMessage } from "@/lib/desktop";
import {
  accessFor,
  addFolder,
  ADDED_FOLDER_ACCESS,
  allowedLevels,
  ACCESS_LABEL,
  ACCESS_LEVELS,
  clearRule,
  EMPTY_POLICY,
  FIRST_FOLDER_ACCESS,
  folderName,
  hasOwnRule,
  inheritedFrom,
  removeFolder,
  setAccess,
  type Access,
  type WorkspacePolicy,
} from "@/lib/workspace-policy";
import {
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  LoaderCircleIcon,
  PencilLineIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TerminalAccessSetting } from "./user-terminal";

const ACCESS_ICON: Record<Access, LucideIcon> = {
  write: PencilLineIcon,
  read: EyeIcon,
  none: BanIcon,
};
const fade =
  "block min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]";
/** A 24px row action inside a 28px row, 6px row corner minus the 2px inset. */
const rowAction =
  "flex h-6 shrink-0 items-center rounded-[4px] outline-none transition-[opacity,background-color] hover:bg-muted focus-visible:bg-muted aria-expanded:bg-muted";

function AccessMenu({
  policy,
  path,
  root,
  onChange,
}: {
  policy: WorkspacePolicy;
  path: string;
  root: boolean;
  onChange: (policy: WorkspacePolicy) => void;
}) {
  const level = accessFor(policy, path);
  const own = hasOwnRule(policy, path);
  const parent = inheritedFrom(policy, path);
  const allowed = allowedLevels(policy, path);
  const Icon = ACCESS_ICON[level];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={`Access for ${folderName(path)}: ${ACCESS_LABEL[level]}`}
            className={cn(
              rowAction,
              "gap-1.5 px-1.5 text-[12px] leading-[1.35]",
              own || root
                ? "text-foreground/85"
                : "text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
            )}
            type="button"
          />
        }
      >
        <Icon className="size-3.5" />
        {ACCESS_LABEL[level]}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" sideOffset={7}>
        <DropdownMenuGroup>
          {parent && !root && allowed.length < ACCESS_LEVELS.length && (
            <DropdownMenuLabel className="px-2 pt-1.5 pb-0.5 text-[11px] font-normal">
              Limited by {folderName(parent.path)}
            </DropdownMenuLabel>
          )}
          {ACCESS_LEVELS.map((option) => {
            const OptionIcon = ACCESS_ICON[option];
            return (
              <DropdownMenuItem
                className="h-[26px] rounded-[8px] py-0 text-[13px]"
                disabled={!allowed.includes(option)}
                key={option}
                onClick={() => onChange(setAccess(policy, path, option))}
              >
                <OptionIcon className="size-[15px]" />
                <span className="flex-1">{ACCESS_LABEL[option]}</span>
                {option === level && <CheckIcon className="size-3.5" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {own && !root && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="h-[26px] rounded-[8px] py-0 text-[13px]"
              onClick={() => onChange(clearRule(policy, path))}
            >
              <span className="pl-[23px]">Same as parent</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Children({
  root,
  directory,
  depth,
  policy,
  onChange,
}: {
  root: string;
  directory: string;
  depth: number;
  policy: WorkspacePolicy;
  onChange: (policy: WorkspacePolicy) => void;
}) {
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.enduranceWorkspace
      ?.listFolder(root, directory)
      .then((value) => {
        if (cancelled) return;
        setEntries(value.entries);
        setMore(value.more);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [root, directory]);
  const inset = { paddingLeft: 8 + depth * 16 };
  if (failed)
    return (
      <p
        className="h-7 text-[12px] leading-7 text-muted-foreground"
        style={inset}
      >
        This folder is unavailable.
      </p>
    );
  if (!entries)
    return (
      <div className="flex h-7 items-center" style={inset}>
        <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
      </div>
    );
  if (!entries.length)
    return (
      <p
        className="h-7 text-[12px] leading-7 text-muted-foreground"
        style={inset}
      >
        Empty
      </p>
    );
  return (
    <>
      {entries.map((entry) => (
        <TreeRow
          depth={depth}
          entry={entry}
          key={entry.path}
          onChange={onChange}
          policy={policy}
          root={root}
        />
      ))}
      {more && (
        <p
          className="h-7 text-[12px] leading-7 text-muted-foreground"
          style={inset}
        >
          Showing the first 200 items
        </p>
      )}
    </>
  );
}

function TreeRow({
  root,
  entry,
  depth,
  policy,
  onChange,
}: {
  root: string;
  entry: FolderEntry;
  depth: number;
  policy: WorkspacePolicy;
  onChange: (policy: WorkspacePolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const blocked = accessFor(policy, entry.path) === "none";
  const Icon = entry.directory ? FolderIcon : FileIcon;
  return (
    <>
      <div
        className="group/row flex h-7 items-center gap-2 rounded-[6px] pr-0.5 hover:bg-muted/50"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <button
          aria-expanded={entry.directory ? open : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
          disabled={!entry.directory}
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <span className="grid size-[15px] shrink-0 place-items-center text-muted-foreground">
            {entry.directory && (
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform",
                  open && "rotate-90",
                )}
              />
            )}
          </span>
          <Icon className="size-[15px] shrink-0 text-muted-foreground" />
          <span
            className={cn(
              fade,
              "text-[13px] leading-[1.4]",
              blocked && "text-muted-foreground",
            )}
          >
            {entry.name}
          </span>
        </button>
        <AccessMenu
          onChange={onChange}
          path={entry.path}
          policy={policy}
          root={false}
        />
      </div>
      {open && entry.directory && (
        <Children
          depth={depth + 1}
          directory={entry.path}
          onChange={onChange}
          policy={policy}
          root={root}
        />
      )}
    </>
  );
}

function RootRow({
  path,
  policy,
  onChange,
}: {
  path: string;
  policy: WorkspacePolicy;
  onChange: (policy: WorkspacePolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="group/row flex h-7 items-center gap-2 rounded-[6px] pr-0.5 pl-2 hover:bg-muted/50">
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
          onClick={() => setOpen((value) => !value)}
          title={path}
          type="button"
        >
          <span className="grid size-[15px] shrink-0 place-items-center text-muted-foreground">
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                open && "rotate-90",
              )}
            />
          </span>
          <FolderIcon className="size-[15px] shrink-0 text-muted-foreground" />
          <span className={cn(fade, "text-[13px] leading-[1.4]")}>
            {folderName(path)}
          </span>
        </button>
        <AccessMenu onChange={onChange} path={path} policy={policy} root />
        <button
          aria-label={`Remove ${folderName(path)}`}
          className={cn(
            rowAction,
            "w-6 justify-center text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground",
          )}
          onClick={() => onChange(removeFolder(policy, path))}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      {open && (
        <Children
          depth={1}
          directory={path}
          onChange={onChange}
          policy={policy}
          root={path}
        />
      )}
    </div>
  );
}

function FolderAccess({
  policy,
  onChange,
}: {
  policy: WorkspacePolicy;
  onChange: (policy: WorkspacePolicy) => void;
}) {
  const [picking, setPicking] = useState(false);
  const add = async () => {
    if (!window.enduranceWorkspace) {
      toast("Adding folders needs the desktop app");
      return;
    }
    setPicking(true);
    try {
      let next = policy;
      for (const folder of await window.enduranceWorkspace.pickFolders(true)) {
        const result = addFolder(
          next,
          folder.path,
          next.folders.length === 0 ? FIRST_FOLDER_ACCESS : ADDED_FOLDER_ACCESS,
        );
        if (result.error) toast(result.error);
        next = result.policy;
      }
      onChange(next);
    } catch {
      toast("Couldn't add that folder");
    } finally {
      setPicking(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] leading-[1.35] text-muted-foreground">
        Folders
      </div>
      <div className="max-h-72 overflow-y-auto rounded-[12px] border p-1">
        {policy.folders.map((folder) => (
          <RootRow
            key={folder.path}
            onChange={onChange}
            path={folder.path}
            policy={policy}
          />
        ))}
        {/* Separates the project's folders from the action, like a menu divider inset by the card padding. */}
        {policy.folders.length > 0 && <div className="my-1 h-px bg-border" role="separator" />}
        <button
          className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] leading-[1.4] outline-none hover:bg-muted/50 focus-visible:bg-muted/50 disabled:opacity-50"
          disabled={picking}
          onClick={add}
          type="button"
        >
          <span className="size-[15px] shrink-0" />
          <FolderPlusIcon className="size-[15px] shrink-0 text-muted-foreground" />
          Add folder
        </button>
      </div>
    </div>
  );
}

/**
 * What the person wants every chat in the project to follow. Sent with each request right after the model's identity;
 * a model with a small window gets the first quarter of its window and the chat says it was cut (harness/instructions).
 */
function ProjectInstructions({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const tokens = estimateText(value);
  const near = value.length > MAX_INSTRUCTIONS * 0.9;
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between gap-3 text-[12px] leading-[1.35] text-muted-foreground">
        Instructions
        {value && (
          <span className={cn("tabular-nums", near && "text-amber-600 dark:text-amber-400")}>
            {value.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()} characters · about {formatContext(tokens)} tokens
          </span>
        )}
      </span>
      <Textarea
        className="max-h-56 min-h-20 rounded-[6px] text-[13px]"
        maxLength={MAX_INSTRUCTIONS}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Guidance for every chat in this project, such as conventions, tone, or things to avoid."
        value={value}
      />
    </label>
  );
}

function ProjectForm({
  title,
  action,
  project,
  onSubmit,
  onClose,
}: {
  title: string;
  action: string;
  project?: Project;
  onSubmit: (name: string, policy: WorkspacePolicy, instructions: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [policy, setPolicy] = useState<WorkspacePolicy>(
    project?.access ?? EMPTY_POLICY,
  );
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onSubmit(name.trim(), policy, instructions.trim());
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? ipcMessage(error) : "Couldn't save the project",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="gap-5 rounded-[12px] sm:max-w-[34rem]">
        <DialogHeader>
          <DialogTitle className="text-[15px] leading-[1.6]">
            {title}
          </DialogTitle>
        </DialogHeader>
        <label className="block space-y-1.5">
          <span className="text-[12px] leading-[1.35] text-muted-foreground">
            Name
          </span>
          <Input
            autoFocus
            className="h-8 rounded-[6px] text-[13px]"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
            placeholder="Project name"
            value={name}
          />
        </label>
        <FolderAccess
          onChange={(next) => {
            // An empty name takes the first folder's name; a name already there, typed or filled, stays.
            if (!name.trim() && next.folders.length) setName(folderName(next.folders[0].path));
            setPolicy(next);
          }}
          policy={policy}
        />
        <ProjectInstructions onChange={setInstructions} value={instructions} />
        {project && <TerminalAccessSetting projectId={project.id} />}
        <DialogFooter>
          <Button
            className="h-7 rounded-[6px] text-[12px]"
            onClick={onClose}
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            className="h-7 rounded-[6px] text-[12px]"
            disabled={!name.trim() || saving}
            onClick={() => void submit()}
          >
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NewProjectDialog({
  assignThreadId,
  onClose,
}: {
  assignThreadId: string | null;
  onClose: () => void;
}) {
  const { createProject, newThread, updateThread } = useStore();
  return (
    <ProjectForm
      action="Create"
      onClose={onClose}
      onSubmit={async (name, policy, instructions) => {
        const id = await createProject(name, policy, instructions || undefined);
        if (assignThreadId) updateThread(assignThreadId, { projectId: id });
        else newThread({ projectId: id });
      }}
      title="Create project"
    />
  );
}

export function ProjectSettingsDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { updateProject } = useStore();
  return (
    <ProjectForm
      action="Save"
      onClose={onClose}
      onSubmit={(name, policy, instructions) => updateProject(project.id, { name, access: policy, folders: undefined, instructions: instructions || undefined })}
      project={project}
      title="Project settings"
    />
  );
}
