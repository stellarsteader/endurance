"use client";

import { usePromptInputController } from "@/components/ai-elements/prompt-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AppUIMessage, TodosData } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CornerDownLeftIcon,
  ListChecksIcon,
  PaperclipIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useSession } from "./session-context";

function ItemAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            disabled={disabled}
            onClick={onClick}
            type="button"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The to-do list of the current reply: the one in progress, or the last finished one when nothing was sent since.
 * A list from an earlier reply belongs to that request, so it is not shown once another one starts or follows.
 */
function currentTodos(messages: AppUIMessage[]): { reply: string; todos: TodosData } | undefined {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return undefined;
  const part = last.parts.findLast((item) => item.type === "data-todos");
  return part?.type === "data-todos" ? { reply: last.id, todos: part.data } : undefined;
}

/** Opens when its list first appears, so the steps are seen once; closed by the person, it stays closed for that list. */
function TodoStrip({ todos }: { todos: TodosData }) {
  const [open, setOpen] = useState(true);
  const done = todos.items.filter((t) => t.status === "completed").length;
  const current = todos.items.find((t) => t.status === "in_progress");

  return (
    <div>
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-background/60"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <ListChecksIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium tabular-nums">
          {done}/{todos.items.length}
        </span>
        <span className="text-muted-foreground">to-dos</span>
        {current && (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span>·</span>
            <CircleDotIcon className="size-3 shrink-0 animate-pulse text-sky-500" />
            <span className="truncate">{current.title}</span>
          </span>
        )}
        <ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="space-y-1 px-2 pt-0.5 pb-1.5">
          {todos.items.map((t) => (
            <li className="flex items-center gap-2 text-xs" key={t.id}>
              {t.status === "completed" ? (
                <CheckCircle2Icon className="size-3.5 text-emerald-500" />
              ) : t.status === "in_progress" ? (
                <CircleDotIcon className="size-3.5 text-sky-500" />
              ) : (
                <CircleDashedIcon className="size-3.5 text-muted-foreground" />
              )}
              <span className={cn(t.status === "completed" ? "text-muted-foreground line-through" : "text-foreground/90")}>
                {t.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tray tucked under the composer: running to-dos plus messages waiting to send. */
export function ComposerQueue() {
  const { queue, removeQueued, sendNow, moveQueued, busy, pendingApproval, chat } = useSession();
  const { setInput } = usePromptInputController().textInput;
  const current = useMemo(() => currentTodos(chat.messages), [chat.messages]);
  const todos = current?.todos;
  const showTodos = Boolean(todos && (busy || pendingApproval || todos.items.some((t) => t.status !== "completed")));

  if (queue.length === 0 && !showTodos) return null;

  const status = pendingApproval
    ? "waiting for your approval"
    : busy
      ? "sends when this response finishes"
      : "sending…";

  return (
    <div className="mx-2 -mb-3 rounded-t-2xl border border-b-0 bg-muted/50 px-1.5 pt-1.5 pb-4 dark:bg-muted/30">
      {showTodos && todos && <TodoStrip key={current?.reply} todos={todos} />}
      {showTodos && queue.length > 0 && <div className="mx-2 my-1 h-px bg-border" />}
      {queue.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 px-2 py-1 text-xs">
            <span className="font-medium">{queue.length} queued</span>
            <span className="truncate text-muted-foreground">· {status}</span>
            <button
              className="ml-auto shrink-0 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                for (const item of queue) removeQueued(item.id);
              }}
              type="button"
            >
              Clear
            </button>
          </div>
          <ul className="max-h-36 overflow-y-auto [scrollbar-width:none]">
            {queue.map((item, i) => (
              <li
                className="group/q flex items-center gap-2 rounded-lg py-1 pr-1 pl-2 transition-colors hover:bg-background/70"
                key={item.id}
              >
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{item.text || "Attachments only"}</span>
                {item.files.length > 0 && (
                  <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs">
                    <PaperclipIcon className="size-3" />
                    {item.files.length}
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/q:opacity-100">
                  <ItemAction disabled={i === 0} label="Move up" onClick={() => moveQueued(item.id, -1)}>
                    <ArrowUpIcon className="size-3.5" />
                  </ItemAction>
                  <ItemAction disabled={i === queue.length - 1} label="Move down" onClick={() => moveQueued(item.id, 1)}>
                    <ArrowDownIcon className="size-3.5" />
                  </ItemAction>
                  <ItemAction
                    label="Edit"
                    onClick={() => {
                      setInput(item.text);
                      removeQueued(item.id);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </ItemAction>
                  <ItemAction label="Remove" onClick={() => removeQueued(item.id)}>
                    <XIcon className="size-3.5" />
                  </ItemAction>
                </div>
                <button
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md border bg-background px-2 text-[11px] text-muted-foreground shadow-xs transition-colors hover:text-foreground"
                  onClick={() => sendNow(item.id)}
                  title="Interrupt the current response and send this now"
                  type="button"
                >
                  Steer
                  <CornerDownLeftIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
