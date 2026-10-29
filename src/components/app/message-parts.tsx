"use client";

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { DiffView } from "./diff-view";
import { MessageResponse } from "@/components/ai-elements/message";
import { usePacedText } from "@/components/ai-elements/paced-text";
import { Reasoning, ReasoningContent, ReasoningTrigger, useReasoning } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { commandKeys } from "@/lib/command-key";
import { isToolPart, toolNameOf, type ToolPartLike } from "@/lib/derive";
import { approvalExpired, continuesInPlace, interruptionNote, interruptionOf, outcomeUnknown, type InterruptCause, type Interruption } from "@/lib/interrupted";
import type {
  AppUIMessage,
  CommitData,
  CompactionData,
  LoopData,
  CotData,
  CotKind,
  CotStep,
  EditFileOutput,
  ShellOutput,
  TestRunOutput,
  TodosData,
} from "@/lib/types";
import { useStore } from "@/lib/store";
import { formatContext } from "@/lib/models";
import { cn } from "@/lib/utils";
import {
  BookMarkedIcon,
  BookOpenIcon,
  BrainIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  CircleDotIcon,
  FileMinusIcon,
  FilePenLineIcon,
  FolderOpenIcon,
  FoldVerticalIcon,
  RepeatIcon,
  GlobeIcon,
  GitCommitHorizontalIcon,
  HammerIcon,
  LinkIcon,
  ListChecksIcon,
  ListTreeIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  TerminalSquareIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { SafeImage, useImageViewer } from "./image-viewer";
import { useSession } from "./session-context";
import {
  activeStep,
  formatElapsed,
  isShown,
  phaseLabel,
  reasoningHeading,
  stepElapsed,
  stepTitle,
  summarizeSteps,
  traceHeadline,
  traceState,
  turnStatus,
  visibleElapsed,
  type TraceState,
} from "@/lib/trace";
import { SubagentTrace, useNow } from "./subagents";

type Part = AppUIMessage["parts"][number];

const cotIcons = {
  search: SearchIcon,
  read: BookOpenIcon,
  think: BrainIcon,
  verify: ShieldCheckIcon,
  list: FolderOpenIcon,
  write: FilePenLineIcon,
  skill: BookMarkedIcon,
  delegate: UsersIcon,
  blocked: ShieldXIcon,
  web: GlobeIcon,
  page: LinkIcon,
  reasoning: BrainIcon,
} satisfies Record<CotKind, LucideIcon>;

function CompactionRow({ data }: { data: CompactionData }) {
  const [open, setOpen] = useState(false);
  return (
    <TraceRow
      detail={`${formatContext(data.after)} of ${formatContext(data.limit)}`}
      icon={<FoldVerticalIcon />}
      label={`Compacted ${data.compacted} earlier ${data.compacted === 1 ? "message" : "messages"}`}
      onToggle={() => setOpen((value) => !value)}
      open={open}
    >
      <MessageResponse className="text-[13px] leading-[1.4] text-muted-foreground">{data.summary}</MessageResponse>
    </TraceRow>
  );
}

/** The runtime's window turned out smaller than expected; the request was fitted to it and sent again. */
function FitRow({ window, runtime }: { window: number; runtime?: number }) {
  // The runtime, asked again, may still claim more than it accepted; both are shown so neither looks wrong.
  const detail = runtime ? `${formatContext(window)} window · server reports ${formatContext(runtime)}` : `${formatContext(window)} window`;
  return <TraceRow detail={detail} icon={<FoldVerticalIcon />} label="Fitted to the model's window and sent again" />;
}

/** Where the harness stopped a reply that kept repeating itself, and what it did next. */
function LoopNotice({ data, messageId }: { data: LoopData; messageId: string }) {
  const { chat, busy, send } = useSession();
  // Output stops only at the context window: a reply that reached it could not be continued in place.
  const label =
    data.reason !== "limit"
      ? `${data.part === "reasoning" ? "Thinking" : "The reply"} kept repeating itself, so it was stopped.`
      : data.part === "reasoning"
        ? "Thinking used up its share of the context window, so it was stopped."
        : "The reply filled the model's context window and could not go on here.";
  const full = `${label}${data.part === "reasoning" && data.retried ? " Answering without thinking." : ""}`;
  // A reply that filled the window, not looping, can go on in a new message, where earlier turns can be summarized.
  const resumable = data.part === "text" && data.reason === "limit" && !busy && chat.messages.at(-1)?.id === messageId;
  return (
    <div className="flex items-center gap-3">
      <TraceRow icon={<RepeatIcon className="text-amber-500" />} label={<span className="text-amber-500/90">{full}</span>} />
      {resumable && (
        <button
          className="shrink-0 text-[13px] text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:underline"
          onClick={() => send({ text: "Continue from where you stopped." })}
          type="button"
        >
          Continue
        </button>
      )}
    </div>
  );
}

const INTERRUPTED: Record<InterruptCause, { title: string; detail?: string }> = {
  stopped: { title: "Response stopped" },
  error: { title: "Response interrupted", detail: "An error ended this response before it finished." },
  closed: { title: "Response interrupted", detail: "Endurance closed before this response finished." },
  expired: {
    title: "Approval expired",
    detail: "This request is no longer active because Endurance restarted or 30 minutes passed. No action was taken.",
  },
};

/**
 * Under the last reply when it did not finish (lib/interrupted). Continue sends a new turn that tells the model what is
 * unknown; Retry starts the reply over. Neither reruns a saved step. When steps had started without a saved result,
 * both wait until the person confirms they have looked.
 */
function InterruptedNotice({ message, interruption }: { message: AppUIMessage; interruption: Interruption }) {
  const { chat, busy, model } = useSession();
  const [checked, setChecked] = useState(false);
  if (busy || chat.error || chat.messages.at(-1)?.id !== message.id) return null;
  // A reply that was only writing goes on in place; one that used tools goes on in a new turn that says what is unknown.
  const inPlace = continuesInPlace(message, interruption, model.runtime);
  const { title, detail } = INTERRUPTED[interruption.cause];
  const unknown = interruption.unknown;
  const ready = unknown.length === 0 || checked;
  const proceed = () =>
    inPlace
      ? chat.sendMessage(undefined, { body: { resume: true } })
      : chat.sendMessage({ text: "Continue from where you stopped.", metadata: { note: interruptionNote(interruption) } });
  const retry = () => chat.regenerate({ messageId: message.id });
  const actions = (
    <div className="flex shrink-0 justify-end gap-2">
      <Tooltip>
        <TooltipTrigger render={<Button className="h-7 rounded-[6px] text-[12px]" disabled={!ready} onClick={retry} type="button" variant="outline" />}>
          Retry
        </TooltipTrigger>
        <TooltipContent>Discard this response and generate a new one</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button className="h-7 rounded-[6px] text-[12px]" disabled={!ready} onClick={proceed} type="button" />}>
          Continue
        </TooltipTrigger>
        <TooltipContent>{inPlace ? "Continue this response" : "Continue from where this response stopped"}</TooltipContent>
      </Tooltip>
    </div>
  );

  // Stopped on purpose with nothing left uncertain: one quiet line, like the other trace rows.
  if (interruption.cause === "stopped" && unknown.length === 0) {
    return (
      <div className="flex items-center gap-3">
        <TraceRow icon={<CirclePauseIcon />} label={<span className="text-muted-foreground">{title}</span>} />
        <button
          className="shrink-0 text-[13px] text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:underline"
          onClick={proceed}
          type="button"
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1 rounded-[12px] border bg-card p-4" role="group" aria-label="Interrupted response">
      <div className="flex items-start gap-2">
        <CircleAlertIcon className="mt-[2px] size-[15px] shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-medium text-[13px] leading-[1.4]">{title}</div>
          {detail && <p className="text-[12px] leading-[1.35] text-muted-foreground">{detail}</p>}
        </div>
      </div>
      {unknown.length > 0 && (
        <div className="mt-3 space-y-2 pl-[23px]">
          <p className="text-[12px] leading-[1.35] text-muted-foreground">
            These steps started, but their results weren&apos;t recorded. They may have completed fully, partially, or not at all.
          </p>
          <ul className="space-y-1">
            {unknown.map((step) => (
              <li className="flex items-center gap-2 text-[13px] leading-[1.4]" key={step}>
                <CircleDashedIcon className="size-3.5 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1 truncate">{step}</span>
              </li>
            ))}
          </ul>
          <label className="flex cursor-pointer items-start gap-2 pt-1 text-[13px] leading-[1.4]">
            <input
              checked={checked}
              className="mt-[3px] size-3.5 shrink-0 accent-foreground"
              onChange={(event) => setChecked(event.target.checked)}
              type="checkbox"
            />
            <span>
              I&apos;ve reviewed these steps{" "}
              <span className="text-muted-foreground">· The agent will check their current state before repeating them.</span>
            </span>
          </label>
        </div>
      )}
      <div className="mt-3 border-t pt-3">{actions}</div>
    </div>
  );
}

/** A duration beside a label. Hidden under a second so a fresh row does not flash "0s". */
function Duration({ ms }: { ms: number | undefined }) {
  const text = visibleElapsed(ms);
  return text ? <span className="shrink-0 text-[12px] leading-[1.35] text-muted-foreground tabular-nums">{text}</span> : null;
}

/** The single "still working" line under a reply when nothing above it shows progress. */
function TurnStatus({ label, since }: { label: string; since?: number }) {
  // Replies without a start time count from when this line first appeared.
  const [mounted] = useState(() => Date.now());
  const now = useNow(true);
  return (
    <div className="flex h-7 items-center gap-2 text-sm">
      <Shimmer duration={1.2}>{label}</Shimmer>
      <Duration ms={now - (since ?? mounted)} />
    </div>
  );
}

function FileChips({ files, max = 6 }: { files: string[]; max?: number }) {
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {files.slice(0, max).map((file) => (
        <span
          className="flex h-5 max-w-full items-center truncate rounded-[4px] bg-muted/60 px-1.5 font-mono text-[11px] leading-[1.3] text-muted-foreground"
          key={file}
        >
          {file}
        </span>
      ))}
      {files.length > max && <span className="flex h-5 items-center px-1 text-[11px] leading-[1.3] text-muted-foreground">+{files.length - max}</span>}
    </div>
  );
}

/**
 * The agent's reasoning before a step: open while it streams, then "Thought for 4s". A finished thought
 * stays open until the whole trace ends, also when the row is drawn again mid-trace.
 */
function ReasoningStepRow({ step, state, now }: { step: CotStep; state: TraceState; now: number }) {
  const live = step.status === "active" && state === "running";
  const took = visibleElapsed(stepElapsed(step, live ? now : undefined));
  return (
    <li>
      <Reasoning className="group mb-0" defaultOpen={state === "running" || state === "waiting"} isStreaming={live}>
        <ReasoningTrigger className="group/trigger flex w-full items-center gap-2 text-left text-[13px] leading-[1.4]">
          <BrainIcon className="size-[15px] shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {live ? <Shimmer duration={1.2}>{stepTitle(step)}</Shimmer> : <span className="text-foreground/85">{took ? `Thought for ${took}` : stepTitle(step)}</span>}
          </span>
          {live && <Duration ms={stepElapsed(step, now)} />}
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-[panel-open]/trigger:rotate-90" />
        </ReasoningTrigger>
        {step.note && <div className="pt-0.5 pl-[23px] text-[12px] leading-[1.35] text-amber-500/90">{step.note}</div>}
        <ReasoningContent className="mt-1 pb-1 pl-[23px] text-[12.5px] leading-[1.45]">{step.reasoning ?? ""}</ReasoningContent>
      </Reasoning>
    </li>
  );
}

/**
 * Under a finished reply, how far its approved plan got when steps are still open, so an answer that reads as done
 * cannot hide that it is not: a model ended a reply "review complete" with its plan at 0 of 3.
 */
function PlanLeftOpen({ parts }: { parts: AppUIMessage["parts"] }) {
  const approved = parts.some((part) => part.type === "dynamic-tool" && part.toolName === "plan_approval" && "approval" in part && part.approval?.approved);
  const todos = parts.findLast((part) => part.type === "data-todos");
  // A reply waiting on a card (a question, a command) has not ended; its plan is still being worked.
  const waiting = parts.some((part) => part.type === "dynamic-tool" && part.state === "approval-requested");
  if (!approved || waiting || todos?.type !== "data-todos") return null;
  const items = todos.data.items;
  const done = items.filter((item) => item.status === "completed").length;
  if (done === items.length) return null;
  return (
    <div className="not-prose flex items-center gap-2 px-1 text-[12px] leading-[1.35] text-amber-600 dark:text-amber-400">
      <ListChecksIcon className="size-3.5 shrink-0" />
      <span>
        Plan not finished: {done} of {items.length} steps done
      </span>
    </div>
  );
}

/** A failure's first line that opens to the whole message, such as an edit's closest lines, which the model saw too. */
function StepDetail({ note, detail }: { note: string; detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-0.5 text-[12px] leading-[1.35]">
      <button
        aria-expanded={open}
        className="flex max-w-full items-baseline gap-1 text-left text-amber-500/90 outline-none hover:text-amber-500 focus-visible:text-amber-500"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="min-w-0">{note}</span>
        <ChevronRightIcon className={cn("size-3 shrink-0 translate-y-[1px]", open && "rotate-90")} />
      </button>
      {open && <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-[6px] bg-muted/40 p-2 font-mono text-[11.5px] text-muted-foreground">{detail}</pre>}
    </div>
  );
}

function AgentStepRow({ step, state, now }: { step: CotStep; state: TraceState; now: number }) {
  if (step.kind === "reasoning") return <ReasoningStepRow now={now} state={state} step={step} />;
  const Icon = cotIcons[step.kind];
  const live = step.status === "active" && state === "running";
  const cutOff = step.status === "active" && state === "stopped";
  return (
    <li className="flex gap-2">
      <Icon className={cn("mt-[3px] size-[15px] shrink-0", step.kind === "blocked" ? "text-amber-500" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 text-[13px] leading-[1.4]", step.status === "complete" && "text-foreground/85")}>
            {live ? <Shimmer duration={1.2}>{stepTitle(step)}</Shimmer> : stepTitle(step)}
          </span>
          <Duration ms={stepElapsed(step, live ? now : undefined)} />
        </div>
        {(step.note || cutOff) && (step.detail ? <StepDetail detail={step.detail} note={step.note ?? ""} /> : (
          <div className={cn("pt-0.5 text-[12px] leading-[1.35]", cutOff ? "text-muted-foreground" : "text-amber-500/90")}>
            {step.note ?? "Stopped"}
          </div>
        ))}
        {step.files && step.files.length > 0 && <FileChips files={step.files} />}
      </div>
    </li>
  );
}

/**
 * The local agent's trace: one collapsible row in the same language as Thought and tool rows. It opens
 * while the agent works and folds into a one-line summary once the work is done.
 */
/**
 * A command's card drawn inside the trace, where the command ran (CotStep.card), or undefined when the reply has no
 * such card. `asking`: the card waits for an approval, so it stays in sight even with the trace folded.
 */
interface TraceCards {
  draw: (toolCallId: string) => ReactNode | undefined;
  asking: (toolCallId: string) => boolean;
  /** A plan, a question or a file change: it stays in sight when the trace folds, as it did drawn after the trace. */
  decision: (toolCallId: string) => boolean;
}

function AgentSteps({ data, streaming, asking, cards }: { data: CotData; streaming: boolean; asking: boolean; cards?: TraceCards }) {
  const state = traceState(data, streaming, asking);
  const running = state === "running";
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Open while it works and while a command in it waits for approval, so the buttons are in sight.
  const open = toggled ?? (running || state === "waiting");
  const now = useNow(running);
  // Until the first step, the status line under the reply says what is happening.
  if (data.steps.length === 0) return null;

  const active = activeStep(data);
  // Thinking alone is not counted as work, so a trace of only thinking has no summary to add.
  const summary = summarizeSteps(data.steps);
  // Open, the active row below already names the step, so the header stays general.
  const label = state === "running" ? (
    <Shimmer duration={1.2}>{active ? (open ? "Working" : stepTitle(active)) : phaseLabel(data)}</Shimmer>
  ) : (
    <>
      {traceHeadline(data, state)}
      {summary && <span className="text-muted-foreground"> · {summary}</span>}
    </>
  );

  return (
    <div className="not-prose">
      <button
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-2 rounded-[6px] px-1 text-left hover:bg-muted/50"
        onClick={() => setToggled(!open)}
        type="button"
      >
        <ListTreeIcon className="size-[15px] shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4]">{label}</span>
        {running && data.startedAt && <Duration ms={now - data.startedAt} />}
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")} />
      </button>
      {open ? (
        <ol className="flex flex-col gap-1 pt-1 pb-2 pl-1">
          {data.steps.map((step) => {
            const card = step.card ? cards?.draw(step.card) : undefined;
            return card ? (
              <li className="-ml-1" key={step.id}>
                {card}
              </li>
            ) : (
              <AgentStepRow key={step.id} now={now} state={state} step={step} />
            );
          })}
        </ol>
      ) : (
        // Folded, a command waiting for approval still shows its card, so it can be answered; a plan or a question
        // shows what was decided, and a file change its diff.
        data.steps.map((step) => (step.card && (cards?.asking(step.card) || cards?.decision(step.card)) ? <div key={step.id}>{cards.draw(step.card)}</div> : null))
      )}
    </div>
  );
}

function CotBlock({ data, streaming }: { data: CotData; streaming: boolean }) {
  const active = data.steps.some((s) => s.status === "active") && streaming;
  const searched = data.steps.find((s) => s.kind === "search")?.results?.length ?? 0;
  return (
    <ChainOfThought className="rounded-xl border bg-muted/20 px-3 py-2.5" defaultOpen>
      <ChainOfThoughtHeader>
        {active ? <Shimmer duration={1.2}>Researching…</Shimmer> : `Researched ${searched} sites in ${data.steps.length} steps`}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {data.steps.map((step) => (
          <ChainOfThoughtStep
            icon={cotIcons[step.kind]}
            key={step.id}
            label={step.status === "active" && streaming ? <Shimmer duration={1.2}>{step.label}</Shimmer> : step.label}
            status={step.status === "active" && !streaming ? "complete" : step.status}
          >
            {step.results && step.results.length > 0 && (
              <ChainOfThoughtSearchResults>
                {step.results.map((r) => (
                  <ChainOfThoughtSearchResult key={r}>
                    <img
                      alt=""
                      className="size-3 rounded-sm"
                      src={`https://www.google.com/s2/favicons?domain=${r}&sz=32`}
                    />
                    {r}
                  </ChainOfThoughtSearchResult>
                ))}
              </ChainOfThoughtSearchResults>
            )}
          </ChainOfThoughtStep>
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function SourcesBlock({ sources }: { sources: Extract<Part, { type: "source-url" }>[] }) {
  return (
    <Sources>
      <SourcesTrigger count={sources.length}>
        <div className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
          <div className="flex -space-x-1">
            {sources.slice(0, 4).map((s) => (
              <img
                alt=""
                className="size-4 rounded-full bg-background ring-1 ring-border"
                key={s.sourceId}
                src={`https://www.google.com/s2/favicons?domain=${new URL(s.url).hostname}&sz=32`}
              />
            ))}
          </div>
          <span className="font-medium">{sources.length} sources</span>
          <ChevronDownIcon className="size-3.5" />
        </div>
      </SourcesTrigger>
      <SourcesContent className="w-full">
        {sources.map((s, i) => (
          <a
            className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-foreground hover:bg-muted"
            href={s.url}
            key={s.sourceId}
            rel="noreferrer"
            target="_blank"
          >
            <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>
            <img alt="" className="size-3.5" src={`https://www.google.com/s2/favicons?domain=${new URL(s.url).hostname}&sz=32`} />
            <span className="truncate">{s.title ?? s.url}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{new URL(s.url).hostname.replace("www.", "")}</span>
          </a>
        ))}
      </SourcesContent>
    </Sources>
  );
}

function TraceRow({
  icon,
  label,
  detail,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="flex size-[15px] shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-[15px]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left text-[13px] leading-[1.4]">{label}</span>
      {detail != null && detail !== false && (
        <span className="shrink-0 text-[12px] leading-[1.35] text-muted-foreground tabular-nums">{detail}</span>
      )}
      {onToggle && (
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")} />
      )}
    </>
  );
  return (
    <div className="not-prose">
      {onToggle ? (
        <button className="flex h-7 w-full items-center gap-2 rounded-[6px] px-1 hover:bg-muted/50" onClick={onToggle} type="button">
          {body}
        </button>
      ) : (
        <div className="flex h-7 items-center gap-2 px-1">{body}</div>
      )}
      {open && children ? <div className="pb-2 pl-[27px]">{children}</div> : null}
    </div>
  );
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-[12px] leading-[1.35]">
      <span className="text-emerald-500">+{additions}</span>
      {deletions > 0 && <span className="text-red-500"> −{deletions}</span>}
    </span>
  );
}

function QuietPre({ children }: { children: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-[6px] bg-muted/40 p-3 font-mono text-[12px] leading-[1.35]">
      {children}
    </pre>
  );
}

function TodosTask({ data }: { data: TodosData }) {
  const [open, setOpen] = useState(false);
  const done = data.items.filter((t) => t.status === "completed").length;
  return (
    <TraceRow
      detail={`${done}/${data.items.length}`}
      icon={<ListChecksIcon />}
      label="To-dos"
      onToggle={() => setOpen((value) => !value)}
      open={open}
    >
      <ul>
        {data.items.map((item) => (
          <li className="flex h-7 items-center gap-2 text-[13px] leading-[1.4]" key={item.id}>
            {item.status === "completed" ? (
              <CheckCircle2Icon className="size-[15px] text-emerald-500" />
            ) : item.status === "in_progress" ? (
              <CircleDotIcon className="size-[15px] text-sky-500" />
            ) : (
              <CircleDashedIcon className="size-[15px] text-muted-foreground" />
            )}
            <span className={item.status === "completed" ? "text-muted-foreground" : undefined}>{item.title}</span>
          </li>
        ))}
      </ul>
    </TraceRow>
  );
}

function CommitCard({ data }: { data: CommitData }) {
  const [open, setOpen] = useState(false);
  return (
    <TraceRow
      detail={data.hash.slice(0, 7)}
      icon={<GitCommitHorizontalIcon />}
      label={data.message}
      onToggle={() => setOpen((value) => !value)}
      open={open}
    >
      <div className="text-[12px] leading-[1.35] text-muted-foreground">{data.branch}</div>
      {data.files.map((file) => (
        <div className="flex h-7 items-center gap-2" key={file.path}>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-[1.35]">{file.path}</span>
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </div>
      ))}
    </TraceRow>
  );
}

export function TestRunView({ data }: { data: TestRunOutput }) {
  return (
    <div className="flex flex-col gap-3">
      {data.suites.map((suite) => (
        <div key={suite.name}>
          <div className="font-mono text-[12px] leading-[1.35]">{suite.name}</div>
          {suite.tests.map((test) => (
            <div className="flex h-6 items-center gap-2 pl-3 text-[13px] leading-[1.4]" key={test.name}>
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  test.status === "failed" ? "bg-red-500" : test.status === "skipped" ? "bg-amber-500" : "bg-emerald-500"
                )}
              />
              <span className="min-w-0 flex-1 truncate">{test.name}</span>
              {test.status !== "skipped" && test.durationMs > 0 && (
                <span className="text-[12px] leading-[1.35] text-muted-foreground tabular-nums">{test.durationMs}ms</span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function testLabel(data: TestRunOutput) {
  return [
    data.passed ? `${data.passed} passed` : null,
    data.failed ? `${data.failed} failed` : null,
    data.skipped ? `${data.skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function EditFileRow({ part }: { part: ToolPartLike }) {
  const { openWorkspace, workspaceTab, focus } = useSession();
  const workspaceOpen = useStore().workspaceOpen;
  const input = part.input as { path?: string } | undefined;
  const out = part.state === "output-available" ? (part.output as EditFileOutput) : undefined;
  // A small change shows its diff in place, as Claude Code and Codex show edits; a large one waits to be opened.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (out ? !out.deleted && out.additions + out.deletions <= SMALL_CHANGE : false);
  const setOpen = (next: (value: boolean) => boolean) => setToggled(next(open));
  const path = out?.path ?? input?.path ?? "file";
  const showing = Boolean(out && workspaceOpen && workspaceTab === "changes" && focus === out.path);

  return (
    <div className="not-prose">
      <div className="flex h-7 items-center gap-2 px-1">
        <span className="flex size-[15px] shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-[15px]">
          {out?.deleted ? <FileMinusIcon /> : <FilePenLineIcon />}
        </span>
        {out ? (
          <button
            className={cn(
              "min-w-0 flex-1 truncate text-left text-[13px] leading-[1.4] outline-none transition-colors",
              showing ? "text-foreground" : "text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            )}
            onClick={() => openWorkspace("changes", out.path)}
            type="button"
          >
            {out.deleted ? "Deleted" : "Edited"} {path}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left text-[13px] leading-[1.4]">
            <Shimmer duration={1.2}>{`Editing ${path}`}</Shimmer>
          </span>
        )}
        {out && <DiffStat additions={out.additions} deletions={out.deletions} />}
        {out && (
          <button
            aria-expanded={open}
            aria-label={open ? "Hide diff" : "Show diff"}
            className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            <ChevronRightIcon className={cn("size-3.5", open && "rotate-90")} />
          </button>
        )}
      </div>
      {open && out && (
        <div className="pb-2 pl-[27px]">
          <DiffView className="max-h-80" patch={out.patch} />
        </div>
      )}
    </div>
  );
}

/** Changed lines up to which an edit's diff shows open. */
const SMALL_CHANGE = 20;

/**
 * A plan the agent proposed, waiting for the person: Approve carries it out in the same reply, Revise sends what to
 * change so the agent proposes again, Cancel stops it.
 */
function PlanApproval({ part, expired }: { part: ToolPartLike; expired: boolean }) {
  const { chat } = useSession();
  const plan = (part.input ?? {}) as { title?: string; summary?: string; steps?: { title: string; detail: string }[] };
  const approval = "approval" in part ? part.approval : undefined;
  const asking = part.state === "approval-requested" && !expired;
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const answer = (approved: boolean, reason?: string) => approval && chat.addToolApprovalResponse({ id: approval.id, approved, reason });
  const outcome = part.state === "output-available" || (part.state === "approval-responded" && approval?.approved)
    ? "Approved"
    : part.state === "output-denied" || approval?.approved === false
      ? approval?.reason && approval.reason !== "cancel" ? "Changes requested" : "Cancelled"
      : expired && part.state === "approval-requested"
        ? "Expired"
        : undefined;
  return (
    <div className="rounded-[12px] border bg-card p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 font-medium text-amber-600 text-xs uppercase tracking-wide dark:text-amber-300">
          <HammerIcon className="size-3.5" /> Plan
        </div>
        {outcome && <span className="text-[12px] text-muted-foreground">{outcome}</span>}
      </div>
      <div className="font-medium text-[15px] leading-[1.4]">{plan.title ?? "Plan"}</div>
      {plan.summary && <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">{plan.summary}</p>}
      <ol className="mt-3 space-y-2.5">
        {(plan.steps ?? []).map((step, i) => (
          <li className="flex gap-3" key={`${i}-${step.title}`}>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] text-muted-foreground">{i + 1}</span>
            <div>
              <div className="font-medium text-[13px] leading-[1.4]">{step.title}</div>
              {step.detail && <div className="text-[13px] leading-[1.45] text-muted-foreground">{step.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
      {asking && (
        <div className="mt-4 border-t pt-3">
          {revising ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (note.trim()) answer(false, note.trim());
              }}
            >
              <Textarea aria-label="What to change in the plan" autoFocus className="min-h-16 text-[13px]" onChange={(event) => setNote(event.target.value)} placeholder="What should change?" value={note} />
              <div className="flex justify-end gap-2">
                <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => setRevising(false)} type="button" variant="ghost">
                  Back
                </Button>
                <Button className="h-7 rounded-[6px] text-[12px]" disabled={!note.trim()} type="submit">
                  Send changes
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end gap-2">
              <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => answer(false, "cancel")} type="button" variant="ghost">
                Cancel
              </Button>
              <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => setRevising(true)} type="button" variant="outline">
                Revise
              </Button>
              <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => answer(true)} type="button">
                <HammerIcon /> Approve
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A question the agent asked (ask_user): pick an option or write an answer, or skip. The answer goes back as the
 * approval's reason and the run goes on in the same reply. A question nobody can answer any more shows as expired.
 */
function QuestionCard({ part, expired }: { part: ToolPartLike; expired: boolean }) {
  const { chat } = useSession();
  const asked = (part.input ?? {}) as { question?: string; options?: string[]; multiple?: boolean };
  const options = asked.options ?? [];
  // Several options may be ticked together, as Claude Code's multiSelect; the person's own words are added to them.
  const multiple = Boolean(asked.multiple);
  const [picked, setPicked] = useState<string[]>([]);
  const approval = "approval" in part ? part.approval : undefined;
  const asking = part.state === "approval-requested" && !expired;
  const [choice, setChoice] = useState<string>();
  const [own, setOwn] = useState("");
  const output = part.state === "output-available" ? (part.output as { answer?: string; skipped?: boolean } | undefined) : undefined;
  const given = output?.answer ?? (approval?.approved ? approval.reason : undefined);
  // Skipped with its button, or passed over by a message sent instead (chat-session declines it).
  const skipped = output?.skipped || approval?.approved === false || part.state === "output-denied";
  const answer = multiple ? [...options.filter((option) => picked.includes(option)), own.trim()].filter(Boolean).join("\n") : own.trim() || choice;
  const respond = (approved: boolean, reason?: string) => approval && chat.addToolApprovalResponse({ id: approval.id, approved, reason });
  const status = given ? undefined : skipped ? "Skipped" : expired && part.state === "approval-requested" ? "Expired" : undefined;
  return (
    <div className="rounded-[12px] border bg-card p-4" role="group" aria-label="Question from the agent">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 font-medium text-sky-600 text-xs uppercase tracking-wide dark:text-sky-300">
          <MessageCircleQuestionIcon className="size-3.5" /> Question
        </div>
        {status && <span className="text-[12px] text-muted-foreground">{status}</span>}
      </div>
      <div className="text-[15px] leading-[1.45]">{asked.question}</div>
      {given ? (
        <ul className="mt-3 flex flex-col gap-1 text-[13px] leading-[1.4]">
          {given.split("\n").map((line, index) => (
            <li className="flex items-start gap-2" key={index}>
              <CheckCircle2Icon className="mt-[2px] size-3.5 shrink-0 text-emerald-500" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : asking ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer) respond(true, answer);
          }}
        >
          {options.length > 0 && multiple && (
            <div className="flex flex-col gap-1" role="group" aria-label="Answers, choose any">
              {options.map((option) => {
                const on = picked.includes(option);
                return (
                  <button
                    aria-checked={on}
                    className={cn(
                      "flex min-h-8 items-center gap-2 rounded-[6px] border px-2.5 py-1.5 text-left text-[13px] leading-[1.4] outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                      on && "border-foreground/40 bg-muted/60"
                    )}
                    key={option}
                    onClick={() => setPicked((list) => (on ? list.filter((item) => item !== option) : [...list, option]))}
                    role="checkbox"
                    type="button"
                  >
                    <span className={cn("flex size-3 shrink-0 items-center justify-center rounded-[3px] border", on && "border-foreground bg-foreground text-background")}>
                      {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
                    </span>
                    {option}
                  </button>
                );
              })}
              <span className="px-0.5 text-[11.5px] text-muted-foreground">Choose any that apply.</span>
            </div>
          )}
          {options.length > 0 && !multiple && (
            <div className="flex flex-col gap-1" role="radiogroup" aria-label="Answers">
              {options.map((option) => (
                <button
                  aria-checked={choice === option && !own.trim()}
                  className={cn(
                    "flex min-h-8 items-center gap-2 rounded-[6px] border px-2.5 py-1.5 text-left text-[13px] leading-[1.4] outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                    choice === option && !own.trim() && "border-foreground/40 bg-muted/60"
                  )}
                  key={option}
                  onClick={() => {
                    setChoice(option);
                    setOwn("");
                  }}
                  role="radio"
                  type="button"
                >
                  <span className={cn("size-3 shrink-0 rounded-full border", choice === option && !own.trim() && "border-[4px] border-foreground")} />
                  {option}
                </button>
              ))}
            </div>
          )}
          <Textarea
            aria-label="Your own answer"
            className="min-h-10 text-[13px]"
            onChange={(event) => setOwn(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && answer) {
                event.preventDefault();
                respond(true, answer);
              }
            }}
            placeholder={options.length ? (multiple ? "Add anything in your own words…" : "Or answer in your own words…") : "Your answer…"}
            value={own}
          />
          <div className="flex justify-end gap-2">
            <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => respond(false, "skip")} type="button" variant="ghost">
              Skip
            </Button>
            <Button className="h-7 rounded-[6px] text-[12px]" disabled={!answer} type="submit">
              Answer
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

const TOOL_TITLES: Record<string, string> = {
  read_file: "Read file",
  grep: "Search code",
  run_shell: "Run shell command",
  run_tests: "Run tests",
  web_search: "Web search",
  web_access: "Web access",
};

function textOf(output: unknown, key: string) {
  if (!output || typeof output !== "object" || !(key in output)) return null;
  const value = (output as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function filesOf(output: unknown) {
  if (!output || typeof output !== "object" || !("files" in output)) return null;
  const files = (output as { files: unknown }).files;
  return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : null;
}

/** The Always allow label for a command: the keys it remembers, each cut short when long, in full on hover. */
function AllowKeys({ keys, scope }: { keys: string[]; scope: string }) {
  const key = (value: string) => (
    <span className="max-w-[12rem] truncate font-mono" key={value}>
      {value}
    </span>
  );
  return (
    <span className="flex min-w-0 items-center gap-1" title={keys.join(", ")}>
      Always allow
      {keys.length === 1 ? key(keys[0]) : keys.length === 2 ? <>{key(keys[0])} and {key(keys[1])}</> : `these ${keys.length} commands`}
      {` in this ${scope}`}
    </span>
  );
}

/** A command's state beside it: asking, running, or how it ended when that was not plainly. */
function shellDetail(ran: ShellOutput | undefined, asking: boolean, unknown: boolean, expired: boolean) {
  if (asking) return "Needs approval";
  if (expired) return "Expired";
  // It started and nothing came after (its last saved output may still say running): whether it finished was never seen.
  if (unknown) return "Outcome unknown";
  if (!ran) return undefined;
  if (ran.running) return "Running";
  if (ran.timedOut) return "Timed out";
  if (ran.exitCode === null) return "Stopped";
  return ran.exitCode ? `Exit ${ran.exitCode}` : undefined;
}

/**
 * `live`: the reply can still change. A settled reply's step without a result shows "Outcome unknown", and an approval
 * nobody can answer any more shows as expired (`expired`).
 */
function ToolBlock({ part, live, expired }: { part: ToolPartLike; live: boolean; expired: boolean }) {
  const { chat, model, thread } = useSession();
  // A chat whose model runs elsewhere already leaves this computer; the card must not promise otherwise.
  const location = model.location;
  const elsewhere = location === "network" || location === "remote";
  const name = toolNameOf(part);
  const approval = "approval" in part ? part.approval : undefined;
  const asking = part.state === "approval-requested" && !expired;
  const [open, setOpen] = useState(asking);
  // A card that starts asking for approval opens; adjusted while rendering rather than in an effect.
  const [wasAsking, setWasAsking] = useState(asking);
  if (asking !== wasAsking) {
    setWasAsking(asking);
    if (asking) setOpen(true);
  }

  if (name === "edit_file") return <EditFileRow part={part} />;
  if (name === "plan_approval") return <PlanApproval expired={expired} part={part} />;
  if (name === "user_question") return <QuestionCard expired={expired} part={part} />;

  const title = ("title" in part && (part.title as string | undefined)) || TOOL_TITLES[name] || name;
  const denied = part.state === "output-denied" || (part.state === "approval-responded" && approval?.approved === false);
  const unknown = !live && outcomeUnknown(part);
  const running = live && (part.state === "input-streaming" || part.state === "input-available" || (name === "run_shell" && part.state === "output-available" && Boolean((part.output as ShellOutput | undefined)?.running)));

  const web = name === "web_access";
  // What Always allow remembers for a command (lib/command-key): each part's key. A command with none always asks.
  const keys = name === "run_shell" ? commandKeys((part.input as { command?: string } | undefined)?.command ?? "") : [];
  // Always allow holds for the chat's project, or for the chat alone when it has none, such as a side chat.
  const scope = thread.projectId ? "project" : "chat";
  const respond = (approved: boolean, always = false) => {
    if (!approval) return;
    // "always" lets the local agent skip asking again: in every chat of the project, or in this chat when it has none
    // (lib/permissions, recorded when the answer is sent).
    chat.addToolApprovalResponse({ id: approval.id, approved, reason: approved ? (always ? "always" : undefined) : "User denied" });
    if (always) toast.success(`${web ? "Web access" : keys.length === 1 ? keys[0] : "Commands"} allowed in this ${scope}`);
  };

  if (name === "run_tests" && part.state === "output-available") {
    const data = part.output as TestRunOutput;
    const seconds = data.durationMs >= 1000 ? `${(data.durationMs / 1000).toFixed(1)}s` : `${data.durationMs}ms`;
    return (
      <TraceRow
        detail={seconds}
        icon={<ListChecksIcon />}
        label={testLabel(data) || "Tests"}
        onToggle={() => setOpen((value) => !value)}
        open={open}
      >
        <TestRunView data={data} />
      </TraceRow>
    );
  }

  const shell = name === "run_shell" ? (part.input as { command?: string; cwd?: string; network?: boolean } | undefined) : undefined;
  const command = shell?.command;
  const ran = name === "run_shell" && part.state === "output-available" ? (part.output as ShellOutput) : undefined;
  const readText = name === "read_file" ? textOf(part.output, "content") : null;
  const searchFiles = name === "grep" ? filesOf(part.output) : null;
  const stdout = name === "run_shell" && part.state === "output-available" ? textOf(part.output, "stdout") : null;
  const expandable = Boolean(asking || readText || searchFiles || stdout || part.errorText);

  let icon = <TerminalSquareIcon />;
  if (name === "read_file") icon = <BookOpenIcon />;
  if (name === "grep" || name === "web_search") icon = <SearchIcon />;
  if (web) icon = <GlobeIcon />;

  const purpose = web ? (part.input as { purpose?: string } | undefined)?.purpose : undefined;
  const label = command ? (
    <span className="font-mono text-[12px] leading-[1.35]">{command}</span>
  ) : web ? (
    purpose ?? title
  ) : running ? (
    <Shimmer duration={1.2}>{title}</Shimmer>
  ) : (
    title
  );
  const lapsed = expired && part.state === "approval-requested";
  const detail = denied
    ? "Denied"
    : shell
      ? shellDetail(ran, asking, unknown, lapsed)
      : web && part.state === "output-available"
        ? "Allowed"
        : web && asking
          ? "Needs approval"
          : lapsed
            ? "Expired"
            : unknown
              ? "Outcome unknown"
              : name === "grep" && searchFiles
                ? String(searchFiles.length)
                : undefined;

  return (
    <TraceRow
      detail={detail}
      icon={icon}
      label={label}
      onToggle={expandable ? () => setOpen((value) => !value) : undefined}
      open={open}
    >
      {asking && (
        <div className="flex flex-col gap-2 py-1">
          <p className="text-[13px] leading-[1.4]">
            {web ? (
              elsewhere
                ? "This sends search terms and page addresses to the internet. Turn Internet Access off to stop web requests from this chat."
                : "This sends search terms and page addresses to the internet. Turn Internet Access off to keep this chat on this computer."
            ) : (
              `Runs in ${shell?.cwd ?? "the project"}. It can change files only in Read & write folders${shell?.network ? " and can reach the internet" : " and has no internet"}, and stops after 2 minutes.`
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => respond(false)} size="sm" variant="outline">
              Deny
            </Button>
            {(web || keys.length > 0) && (
              <Button className="h-7 max-w-full min-w-0 rounded-[6px] text-[12px]" onClick={() => respond(true, true)} size="sm" variant="outline">
                {web ? `Always allow in this ${scope}` : <AllowKeys keys={keys} scope={scope} />}
              </Button>
            )}
            <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => respond(true)} size="sm">
              {web ? "Allow once" : "Run once"}
            </Button>
          </div>
        </div>
      )}
      {readText && <QuietPre>{readText}</QuietPre>}
      {searchFiles && (
        <div className="flex flex-col">
          {searchFiles.map((file) => (
            <div className="flex h-6 items-center font-mono text-[12px] leading-[1.35]" key={file}>
              {file}
            </div>
          ))}
        </div>
      )}
      {stdout && <QuietPre>{stdout}</QuietPre>}
      {part.errorText && <p className="text-[13px] leading-[1.4] text-red-500">{part.errorText}</p>}
    </TraceRow>
  );
}

/**
 * "Thinking 4s" while the thought streams, titled by the model's latest heading when it writes one,
 * then "Thought for 4s". A reloaded chat has no measured time and reads "Thought".
 */
function ThoughtLabel({ text }: { text: string }) {
  const { duration, isStreaming } = useReasoning();
  // The row mounts when the thought starts streaming.
  const [startedAt] = useState(() => Date.now());
  const now = useNow(isStreaming);
  if (isStreaming) {
    return (
      <span className="flex items-center gap-2">
        <Shimmer as="span" className="min-w-0 truncate" duration={1}>
          {reasoningHeading(text) ?? "Thinking"}
        </Shimmer>
        <Duration ms={now - startedAt} />
      </span>
    );
  }
  return <span>{duration ? `Thought for ${formatElapsed(duration * 1000)}` : "Thought"}</span>;
}

const linkCitations = (text: string, sources: Extract<Part, { type: "source-url" }>[]) =>
  sources.length === 0
    ? text
    : text.replace(/\[(\d+)\]/g, (match, n: string) => {
        const s = sources[Number(n) - 1];
        return s ? `[\\[${n}\\]](${s.url})` : match;
      });

/** The reply's text as it streams, at a steady pace (paced-text). */
function PacedResponse({ text, live, sources }: { text: string; live: boolean; sources: Extract<Part, { type: "source-url" }>[] }) {
  const shown = usePacedText(text, live);
  return (
    <MessageResponse className="py-2" isAnimating={live || shown.length < text.length}>
      {linkCitations(shown, sources)}
    </MessageResponse>
  );
}

function PacedThought({ text, live }: { text: string; live: boolean }) {
  const shown = usePacedText(text, live);
  return <ReasoningContent className="mt-1 pb-2 pl-[27px] text-[13px] leading-[1.4]">{shown}</ReasoningContent>;
}

export function MessageParts({ message, streaming }: { message: AppUIMessage; streaming: boolean }) {
  const parts = message.parts;
  const sources = parts.filter((p): p is Extract<Part, { type: "source-url" }> => p.type === "source-url");
  const subagents = parts.flatMap((p) => (p.type === "data-subagent" ? [p.data] : []));
  const lastTodos = parts.findLastIndex((p) => p.type === "data-todos");
  const firstSource = parts.findIndex((p) => p.type === "source-url");
  const firstAgent = parts.findIndex((p) => p.type === "data-subagent");
  const lastIndex = parts.length - 1;
  const imageAt = new Map<number, number>();
  const images = parts.flatMap((p, i) => {
    if (p.type !== "file" || !p.mediaType.startsWith("image/")) return [];
    imageAt.set(i, imageAt.size);
    return [{ id: `${message.id}-${i}`, url: p.url, name: p.filename }];
  });
  const { open: openImage, viewer } = useImageViewer(images);

  const { waitStatus } = useSession();
  const status = waitStatus && streaming && !parts.some(isShown) ? waitStatus : turnStatus(parts, streaming);
  const statusLine = status && <TurnStatus label={status} since={message.metadata?.createdAt} />;
  const expired = !streaming && approvalExpired(message);
  const interruption = interruptionOf(message, streaming);
  const notice = interruption && <InterruptedNotice interruption={interruption} message={message} />;
  // Commands the agent's trace names by their tool call: each card is drawn at its step instead of after the trace.
  const toolParts = new Map(parts.filter(isToolPart).map((part) => [part.toolCallId, part] as const));
  // A to-do list or a summary made during the run is named in the trace as "<part type>:<part id>" (agent placeData).
  const dataPart = (card: string) => {
    const at = card.indexOf(":");
    const type = card.slice(0, at);
    const id = card.slice(at + 1);
    return type === "data-todos" || type === "data-compaction" ? parts.findLast((part) => part.type === type && part.id === id) : undefined;
  };
  const placed = new Set(
    parts.flatMap((part) =>
      part.type === "data-cot" && part.data.agent ? part.data.steps.flatMap((step) => (step.card && (toolParts.has(step.card) || dataPart(step.card)) ? [step.card] : [])) : []
    )
  );
  const placedData = (part: Part) => (part.type === "data-todos" || part.type === "data-compaction") && placed.has(`${part.type}:${part.id}`);
  const traceCards: TraceCards = {
    draw: (id) => {
      const data = dataPart(id);
      if (data?.type === "data-todos") return <TodosTask data={data.data} />;
      if (data?.type === "data-compaction") return <CompactionRow data={data.data} />;
      const part = toolParts.get(id);
      return part ? <ToolBlock expired={expired} live={streaming} part={part} /> : undefined;
    },
    asking: (id) => toolParts.get(id)?.state === "approval-requested" && !expired,
    decision: (id) => {
      if (dataPart(id)) return true;
      const part = toolParts.get(id);
      return part?.type === "dynamic-tool" && (part.toolName === "plan_approval" || part.toolName === "user_question" || part.toolName === "edit_file");
    },
  };
  // The trace waits only while an approval in this reply can still be answered.
  const asking = !expired && [...toolParts.values()].some((part) => part.state === "approval-requested");
  if (!parts.some(isShown)) return statusLine || notice || null;

  return (
    <div className="flex flex-col gap-1 text-[15px] leading-[1.6]">
      {parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        switch (part.type) {
          case "text":
            return (
              <PacedResponse key={key} live={streaming && i === lastIndex} sources={sources} text={part.text} />
            );
          case "reasoning":
            return (
              <Reasoning className="group mb-0" isStreaming={streaming && part.state === "streaming"} key={key}>
                <ReasoningTrigger className="group/trigger flex h-7 w-full items-center gap-2 rounded-[6px] px-1 text-[13px] leading-[1.4] text-foreground hover:bg-muted/50">
                  <BrainIcon className="size-[15px] text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    <ThoughtLabel text={part.text} />
                  </span>
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-[panel-open]/trigger:rotate-90" />
                </ReasoningTrigger>
                <PacedThought live={streaming && part.state === "streaming"} text={part.text} />
              </Reasoning>
            );
          case "source-url":
            return i === firstSource ? <SourcesBlock key={key} sources={sources} /> : null;
          case "data-cot":
            return part.data.agent ? (
              <AgentSteps asking={asking} cards={traceCards} data={part.data} key={key} streaming={streaming} />
            ) : (
              <CotBlock data={part.data} key={key} streaming={streaming} />
            );
          case "data-compaction":
            return placedData(part) ? null : <CompactionRow data={part.data} key={key} />;
          case "data-loop":
            return <LoopNotice data={part.data} key={key} messageId={message.id} />;
          case "data-fit":
            return <FitRow key={key} runtime={part.data.runtime} window={part.data.window} />;
          case "data-instructions":
            return (
              <TraceRow
                detail={`${part.data.kept.toLocaleString()} of ${part.data.total.toLocaleString()} characters`}
                icon={<FoldVerticalIcon />}
                key={key}
                label="Project instructions were cut to fit this model's window"
              />
            );
          case "data-subagent":
            return i === firstAgent ? <SubagentTrace agents={subagents} key={key} /> : null;
          case "data-todos":
            return i === lastTodos && !placedData(part) ? <TodosTask data={part.data} key={key} /> : null;
          case "data-commit":
            return <CommitCard data={part.data} key={key} />;
          case "file":
            return part.mediaType.startsWith("image/") ? (
              <button
                aria-label={`Open ${part.filename ?? "image"}`}
                className="group/tile relative w-fit cursor-zoom-in overflow-hidden rounded-[12px] bg-muted outline-none ring-1 ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                key={key}
                onClick={() => openImage(imageAt.get(i) ?? 0)}
                type="button"
              >
                <SafeImage alt={part.filename ?? "Image"} className="block max-h-80 min-h-16 w-auto min-w-16 max-w-full object-contain" src={part.url} />
                <span className="pointer-events-none absolute inset-0 transition-colors group-hover/tile:bg-black/10" />
              </button>
            ) : null;
          default:
            // A command placed in the trace is drawn there, in the order it ran.
            return isToolPart(part) && !placed.has(part.toolCallId) ? <ToolBlock expired={expired} key={key} live={streaming} part={part} /> : null;
        }
      })}
      {!streaming && <PlanLeftOpen parts={parts} />}
      {statusLine}
      {notice}
      {viewer}
    </div>
  );
}