"use client";

import { useStore, type Thread } from "@/lib/store";
import { decisionsIn, withoutRules, withRules, type AllowRule, type Decision, type Outcome } from "@/lib/permissions";
import { ipcMessage } from "@/lib/desktop";
import type { AppUIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MinusIcon,
  ShieldCheckIcon,
  TerminalSquareIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { when } from "./history-settings";

/** Rows each list shows before "Show more", and how many more each press adds. */
const FIRST = 5;
const MORE = 20;

const OUTCOME: Record<Outcome, { label: string; icon: LucideIcon }> = {
  once: { label: "Allowed once", icon: CheckIcon },
  always: { label: "Always allowed", icon: ShieldCheckIcon },
  denied: { label: "Denied", icon: BanIcon },
  skipped: { label: "Skipped", icon: MinusIcon },
};

/** A 24px row action, as in the folder rows above. */
const rowAction =
  "flex size-6 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground outline-none transition-[opacity,background-color] hover:bg-muted hover:text-foreground focus-visible:bg-muted";
/** Overflow fades across the last 32px with no ellipsis, as folder names above do (DESIGN.md). */
const fade =
  "block min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]";
/** A row's second line: what was answered, when, and in which chat, whose title fades last. */
const meta = "flex min-w-0 items-baseline gap-1 text-[12px] leading-[1.35] text-muted-foreground";
/** The group label of each list inside the card, like a menu's. */
const heading = "flex h-6 items-center justify-between gap-3 px-2 text-[11px] leading-[1.3] text-muted-foreground";
/** Rows in a list are 2px apart (DESIGN.md). */
const list = "flex flex-col gap-0.5 outline-none";

interface ChatDecision {
  decision: Decision;
  thread: Thread;
}

/**
 * The project's chats' messages: those on screen as they are now, the others read from the history once. The
 * answers on their cards are what this section lists (lib/permissions).
 */
function useChatMessages(chats: Thread[]) {
  const [read, setRead] = useState(() => new Map<string, AppUIMessage[]>());
  const [failed, setFailed] = useState(false);
  const history = typeof window === "undefined" ? undefined : window.enduranceHistory;
  const missing = chats.filter((thread) => thread.loaded === false && (thread.messageCount ?? 0) > 0 && !read.has(thread.id)).map((thread) => thread.id);
  const key = missing.join(" ");
  useEffect(() => {
    if (!history || !key) return;
    let cancelled = false;
    Promise.all(key.split(" ").map((id) => history.messages(id).then((messages) => [id, messages] as const)))
      .then((entries) => !cancelled && setRead((current) => new Map([...current, ...entries])))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [history, key]);
  const messagesOf = (thread: Thread) => (thread.loaded === false ? (read.get(thread.id) ?? []) : thread.messages);
  return { messagesOf, loading: Boolean(history && key) && !failed, failed };
}

/**
 * Before rows go away, moves focus to the next row's remove button (or the one before), or to the list, so removing
 * with the keyboard keeps a place. Done first: focus left on a removed button falls back to the whole dialog.
 */
function keepFocus(list: HTMLElement | null, index: number | undefined) {
  const buttons = list?.querySelectorAll<HTMLButtonElement>("[data-remove]");
  const next = index === undefined ? undefined : (buttons?.[index + 1] ?? buttons?.[index - 1]);
  (next ?? list)?.focus();
}

const ruleName = (rule: AllowRule) => (rule.kind === "web" ? "Web access" : rule.key);
const ruleId = (rule: AllowRule) => (rule.kind === "web" ? "web" : `command:${rule.key}`);

/** A project rule: what it allows, the command it was given on, when, and in which chat (`chat`, unless deleted since). */
function RuleRow({ rule, chat, onRemove }: { rule: AllowRule; chat?: Thread; onRemove: () => void }) {
  const web = rule.kind === "web";
  const Icon = web ? GlobeIcon : TerminalSquareIcon;
  const name = ruleName(rule);
  // The command it was given on, when that says more than the key.
  const from = !web && rule.command.trim() !== rule.key ? rule.command : undefined;
  return (
    <div className="group/row flex items-center gap-2 rounded-[6px] py-1 pr-0.5 pl-2 hover:bg-muted/50" role="listitem">
      <Icon className="size-[15px] shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2" title={from ? `Allowed from: ${from}` : undefined}>
          {web ? (
            <span className="shrink-0 text-[13px] leading-[1.4]">{name}</span>
          ) : (
            <span className="shrink-0 font-mono text-[12px] leading-[1.4]">{name}</span>
          )}
          {from ? (
            <span className={cn(fade, "text-[12px] leading-[1.4] text-muted-foreground")}>
              from <span className="font-mono">{from}</span>
            </span>
          ) : (
            <span className="flex-1" />
          )}
        </div>
        <div className={meta} title={chat ? `Allowed in “${chat.title}”` : undefined}>
          {rule.at > 0 && <span className="shrink-0 tabular-nums">{when(rule.at)}</span>}
          {rule.at > 0 && chat && <span className="shrink-0">·</span>}
          {chat && <span className={fade}>in {chat.title}</span>}
        </div>
      </div>
      <button
        aria-label={`Remove ${name}`}
        className={cn(rowAction, "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100")}
        data-remove=""
        onClick={onRemove}
        title="Remove: chats in this project ask again"
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function DecisionRow({ item }: { item: ChatDecision }) {
  const { decision, thread } = item;
  const [open, setOpen] = useState(false);
  const outcome = OUTCOME[decision.outcome];
  const web = decision.kind === "web";
  return (
    <div role="listitem">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <outcome.icon aria-hidden className={cn("size-[15px] shrink-0", decision.outcome === "denied" ? "text-foreground/70" : "text-muted-foreground")} />
        <div className="flex min-w-0 flex-1 flex-col">
          {web ? (
            <span className={cn(fade, "text-[13px] leading-[1.4]")}>
              Web access
              {decision.purpose && <span className="text-muted-foreground"> · {decision.purpose}</span>}
            </span>
          ) : (
            <span className={cn(fade, "font-mono text-[12px] leading-[1.4]")}>{decision.command ?? "Command"}</span>
          )}
          <span className={meta}>
            <span className={cn("shrink-0", decision.outcome === "denied" && "text-foreground/85")}>{outcome.label}</span>
            {decision.at && <span className="shrink-0 tabular-nums">· {when(decision.at)}</span>}
            <span className="shrink-0">·</span>
            <span className={fade}>{thread.title}</span>
          </span>
        </div>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 pt-1 pr-2 pb-2 pl-[31px]">
          {decision.command && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-muted/40 px-2 py-1.5 font-mono text-[12px] leading-[1.6] select-text">
              {decision.command}
            </pre>
          )}
          <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-[12px] leading-[1.35]">
            <dt className="text-muted-foreground">Chat</dt>
            <dd className="min-w-0 truncate">{thread.title}</dd>
            {decision.cwd && (
              <>
                <dt className="text-muted-foreground">Folder</dt>
                <dd className="min-w-0 truncate font-mono">{decision.cwd}</dd>
              </>
            )}
            {decision.purpose && (
              <>
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="min-w-0 break-words">{decision.purpose}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Answer</dt>
            <dd className="min-w-0">
              {outcome.label}
              {decision.outcome === "skipped" && <span className="text-muted-foreground"> · a new message was sent instead</span>}
            </dd>
            {decision.at && (
              <>
                <dt className="text-muted-foreground">Asked</dt>
                <dd className="min-w-0 tabular-nums">{new Date(decision.at).toLocaleString()}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function ShowMore({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button
      className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12px] leading-[1.35] text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50"
      onClick={onClick}
      type="button"
    >
      <span className="size-[15px] shrink-0" />
      Show {Math.min(hidden, MORE)} more
      {hidden > MORE && <span className="tabular-nums">of {hidden}</span>}
    </button>
  );
}

const Empty = ({ children }: { children: string }) => <p className="px-2 py-1.5 text-[12px] leading-[1.45] text-muted-foreground">{children}</p>;

/**
 * Project settings → Permissions: what the project's chats may do without asking, with a way to remove it, and the
 * answers given on command and web access cards in them. Removing applies right away, apart from the dialog's Save:
 * the project's chats ask again from their next request.
 */
export function ProjectPermissions({ projectId }: { projectId: string }) {
  const { threads, projects, updateProject } = useStore();
  const project = projects.find((item) => item.id === projectId);
  const chats = useMemo(() => threads.filter((thread) => thread.projectId === projectId && !thread.temporary), [threads, projectId]);
  const { messagesOf, loading, failed } = useChatMessages(chats);
  const [rulesShown, setRulesShown] = useState(FIRST);
  const [decisionsShown, setDecisionsShown] = useState(FIRST);
  const ruleList = useRef<HTMLDivElement>(null);

  // Latest first. Rules given before Always allow held for a project are on their chats' cards, so in Recent decisions.
  const rules = [...(project?.alwaysAllowed ?? [])].sort((a, b) => b.at - a.at);
  // Newest first; a reply's cards share its time, so within one the later card comes first.
  const decisions: ChatDecision[] = chats
    .flatMap((thread) => decisionsIn(messagesOf(thread)).reverse().map((decision) => ({ decision, thread })))
    .sort((a, b) => (b.decision.at ?? 0) - (a.decision.at ?? 0));

  /** Removes the rules, or puts them back (Undo), on the project as its last save left it. */
  const apply = (items: AllowRule[], restore: boolean) =>
    updateProject(projectId, (current) => ({
      alwaysAllowed: restore ? withRules(current.alwaysAllowed ?? [], items) : withoutRules(current.alwaysAllowed ?? [], items),
    })).catch((error: unknown) => toast.error(restore ? "Couldn't put it back" : "Couldn't remove it", { description: error instanceof Error ? ipcMessage(error) : undefined }));
  const remove = (items: AllowRule[], index?: number) => {
    keepFocus(ruleList.current, index);
    void apply(items, false);
    toast(`Removed ${items.length === 1 ? ruleName(items[0]) : `${items.length} permissions`}`, {
      description: `Chats in ${project?.name ? `“${project.name}”` : "this project"} will ask again before using ${items.length === 1 ? "it" : "them"}.`,
      action: { label: "Undo", onClick: () => void apply(items, true) },
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[12px] leading-[1.35] text-muted-foreground">
        Permissions
        <span>Changes here apply right away</span>
      </div>
      <div className="rounded-[12px] border p-1">
        <div className={heading}>
          <span className="flex items-baseline gap-1.5">
            Always allowed
            {rules.length > 0 && <span className="text-[10px] tabular-nums">{rules.length}</span>}
          </span>
          {rules.length > 1 && (
            <button
              className="rounded-[4px] px-1 py-0.5 text-[11px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted"
              onClick={() => remove(rules)}
              type="button"
            >
              Remove all
            </button>
          )}
        </div>
        <div aria-label="Always allowed" className={list} ref={ruleList} role="list" tabIndex={-1}>
          {rules.length === 0 ? (
            <Empty>Nothing yet. Choosing Always allow when a chat here asks to run a command or go online adds it, for every chat in this project.</Empty>
          ) : (
            rules.slice(0, rulesShown).map((rule, index) => (
              <RuleRow chat={rule.chatId ? threads.find((thread) => thread.id === rule.chatId) : undefined} key={ruleId(rule)} onRemove={() => remove([rule], index)} rule={rule} />
            ))
          )}
        </div>
        {rules.length > rulesShown && <ShowMore hidden={rules.length - rulesShown} onClick={() => setRulesShown((value) => value + MORE)} />}
        {/* Separates the two lists, like a menu divider inset by the card padding. */}
        <div className="my-1 h-px bg-border" role="separator" />
        <div className={heading}>
          <span className="flex items-baseline gap-1.5">
            Recent decisions
            {decisions.length > 0 && <span className="text-[10px] tabular-nums">{decisions.length}</span>}
          </span>
        </div>
        <div aria-label="Recent decisions" className={list} role="list">
          {loading ? (
            <div className="flex h-7 items-center gap-2 px-2 text-[12px] text-muted-foreground" role="status">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              Reading this project&apos;s chats…
            </div>
          ) : failed ? (
            <Empty>Couldn&apos;t read this project&apos;s chats. Close and open Project settings to try again.</Empty>
          ) : decisions.length === 0 ? (
            <Empty>No answers yet. Commands and web access you allow or deny in this project&apos;s chats are listed here.</Empty>
          ) : (
            decisions.slice(0, decisionsShown).map((item) => <DecisionRow item={item} key={`${item.thread.id}:${item.decision.id}`} />)
          )}
        </div>
        {!loading && decisions.length > decisionsShown && <ShowMore hidden={decisions.length - decisionsShown} onClick={() => setDecisionsShown((value) => value + MORE)} />}
      </div>
    </div>
  );
}
