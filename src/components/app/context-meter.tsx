"use client";

import { usePreferenceRevision } from "@/features/model-settings/use-chat-models";
import { runtimeContext } from "@/features/model-settings/preferences";
import type { WindowSource as RuntimeSource } from "@/lib/context-window";
import { compactLine, getModel, MODELS, type ModelInfo } from "@/lib/models";
import { useStore } from "@/lib/store";
import { applyStored, estimateTokens } from "@/lib/token-estimate";
import type { AppUIMessage, ChatMeta, ContextSection, Usage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Popover } from "@base-ui/react/popover";
import { ArrowUpRightIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { POPUP_GAP } from "./model-menu";
import { useSession } from "./session-context";

type Tone = "calm" | "near" | "over";
type WindowSource = RuntimeSource;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const tokens = (n: number) => compact.format(Math.max(0, Math.round(n)));
const percent = (ratio: number) => `${ratio > 0 && ratio < 0.1 ? (ratio * 100).toFixed(1) : Math.round(ratio * 100)}%`;
const money = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/** Some servers send no usage at all, others send zeros; neither is a measurement. */
const reported = (usage?: Usage): usage is Usage => !!usage && usage.input + usage.output + usage.reasoning > 0;
/**
 * Tokens the reply left in the window. Older replies carry only totals across the turn's calls, which an
 * agent turn can push past the window even though each call fit, so those count only for a single call.
 */
const occupancy = (usage: Usage) => usage.context ?? (usage.calls === 1 ? usage.input + usage.output : undefined);
/** Whether the reply's counts add up several model calls, or may (older replies did not record how many). */
const totals = (usage: Usage) => (usage.calls ? usage.calls > 1 : usage.context === undefined);
const estimate = (messages: AppUIMessage[]) => messages.reduce((total, message) => total + estimateTokens(message), 0);

/** The parts of a prompt in the order they are sent, as the meter names them. */
const PARTS: { key: ContextSection; label: string }[] = [
  { key: "system", label: "System prompt" },
  { key: "instructions", label: "Project instructions" },
  { key: "skills", label: "Skills" },
  { key: "project", label: "Project folders" },
  { key: "tools", label: "Tool definitions" },
  { key: "summary", label: "Summary of earlier turns" },
  { key: "conversation", label: "Conversation" },
  { key: "attachments", label: "Images" },
  { key: "toolResults", label: "Tool calls and results" },
  { key: "reply", label: "Latest reply" },
];
/** One shade per part, darkest first, from the foreground token so both themes follow. */
/**
 * One shade per part from the foreground token, so both themes follow. Parts go largest first, left to right, the
 * largest in the brightest shade. The softest is still far above the empty
 * track (foreground at 10%), so what is used never reads as empty.
 */
const SHADES = ["bg-foreground/90", "bg-foreground/80", "bg-foreground/72", "bg-foreground/65", "bg-foreground/58", "bg-foreground/52", "bg-foreground/47", "bg-foreground/43", "bg-foreground/40", "bg-foreground/38"];

interface Part {
  key: ContextSection;
  label: string;
  tokens: number;
  shade: string;
}

/**
 * The window's tokens split by part. The total is what the runtime counted; the split is the worker's estimate of
 * each part's share (ChatMeta.breakdown), applied to that total. Messages sent since count with the conversation.
 */
function partsOf(breakdown: ChatMeta["breakdown"], total: number, since: number): Part[] {
  const sum = PARTS.reduce((n, part) => n + (breakdown?.[part.key] ?? 0), 0);
  if (!breakdown || sum <= 0) return [];
  const parts = PARTS.filter((part) => (breakdown[part.key] ?? 0) > 0 || (part.key === "conversation" && since > 0)).map((part) => ({
    ...part,
    tokens: ((breakdown[part.key] ?? 0) / sum) * total + (part.key === "conversation" ? since : 0),
    shade: SHADES[0],
  }));
  // Largest first, in the bar and the rows alike, so each row sits where its colour does.
  return parts.sort((a, b) => b.tokens - a.tokens).map((part, index) => ({ ...part, shade: SHADES[Math.min(index, SHADES.length - 1)] }));
}

interface Measure {
  /** Tokens now in the window, measured where the runtime reported them and estimated after that. */
  used: number;
  estimated: boolean;
  /** The latest finished reply, whether or not its usage was reported. */
  reply?: { usage?: Usage; model?: string };
  replies: number;
  unreported: number;
  /** The latest measured reply recorded only turn totals, so `used` is estimated from message text instead. */
  totalsOnly: boolean;
  processed: number;
  cost: number;
  summarized: number;
  /** What fills the window by part, when the latest measured reply carried its prompt's parts. */
  parts: Part[];
}

function measure(messages: AppUIMessage[]): Measure {
  let processed = 0;
  let cost = 0;
  let summarized = 0;
  let replies = 0;
  let unreported = 0;
  let measuredAt = -1;
  let reply: Measure["reply"];
  messages.forEach((message, index) => {
    for (const part of message.parts) if (part.type === "data-compaction") summarized = part.data.compacted;
    if (message.role !== "assistant" || !message.metadata?.durationMs) return;
    replies++;
    const usage = message.metadata.usage;
    reply = { usage: reported(usage) ? usage : undefined, model: message.metadata.model };
    if (!reported(usage)) {
      unreported++;
      return;
    }
    measuredAt = index;
    processed += usage.input + usage.output + usage.reasoning;
    const [inPrice, outPrice] = getModel(message.metadata.model).price;
    cost += ((usage.input - usage.cached) * inPrice + usage.cached * inPrice * 0.1 + (usage.output + usage.reasoning) * outPrice) / 1_000_000;
  });

  const after = messages.slice(measuredAt + 1);
  const compactedSince = after.some((message) => message.parts.some((part) => part.type === "data-compaction"));
  const base = measuredAt >= 0 && !compactedSince ? messages[measuredAt].metadata?.usage : undefined;
  const occupied = reported(base) ? occupancy(base) : undefined;
  const totalsOnly = reported(base) && occupied === undefined;
  if (occupied !== undefined) {
    const since = estimate(after);
    const parts = partsOf(messages[measuredAt].metadata?.breakdown, occupied, since);
    // The runtime's count may have left out its cached prompt; the harness then sent its estimate (harness/budget).
    return { used: occupied + since, estimated: after.length > 0 || Boolean(base?.estimated), reply, replies, unreported, totalsOnly, processed, cost, summarized, parts };
  }
  // Nothing measured since the last summary: estimate what the harness would send, as it does itself.
  const stored = applyStored(messages);
  const used = estimate(stored.rest) + (stored.summary ? Math.ceil(stored.summary.length / 3) : 0);
  return { used, estimated: messages.length > 0, reply, replies, unreported, totalsOnly, processed, cost, summarized, parts: [] };
}

function resolveWindow(model: ModelInfo): { tokens: number; source?: WindowSource } {
  if (!model.runtime) return { tokens: 0 };
  const raw = MODELS.find((item) => item.id === model.id) ?? model;
  const { tokens = 0, source } = runtimeContext(raw);
  return { tokens, source };
}

function Ring({ ratio, tone, unknown }: { ratio: number; tone: Tone; unknown: boolean }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg aria-hidden className="size-[18px] -rotate-90" viewBox="0 0 20 20">
      <circle
        className="stroke-current opacity-25"
        cx="10"
        cy="10"
        fill="none"
        r={r}
        strokeDasharray={unknown ? "1.5 3" : undefined}
        strokeLinecap="round"
        strokeWidth="2.25"
      />
      {!unknown && ratio > 0 && (
        <circle
          className={cn(
            "stroke-current transition-[stroke-dashoffset] duration-500 ease-out",
            tone === "near" && "text-amber-500",
            tone === "over" && "text-red-500"
          )}
          cx="10"
          cy="10"
          fill="none"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(1, Math.max(ratio, 0.04)))}
          strokeLinecap="round"
          strokeWidth="2.25"
        />
      )}
    </svg>
  );
}

function Row({ label, value, hint, muted }: { label: ReactNode; value: ReactNode; hint?: ReactNode; muted?: boolean }) {
  return (
    <div className="flex h-6 items-center justify-between gap-3 text-[12.5px]">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
        {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
        <span className={muted ? "text-muted-foreground" : "text-foreground"}>{value}</span>
      </span>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-foreground/[0.07] border-t px-3.5 pt-2.5 pb-2">
      <div className="mb-0.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{title}</span>
        {aside && <span className="truncate tabular-nums">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A note about missing or assumed information, with the one action that can fix it. */
function Notice({ tone = "info", children, action }: { tone?: "info" | "warn"; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === "warn" ? TriangleAlertIcon : InfoIcon;
  return (
    <div
      className={cn(
        "mx-3.5 mb-3 flex gap-2 rounded-[8px] px-2.5 py-2 text-[11.5px] leading-[1.45]",
        tone === "warn" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-foreground/[0.04] text-muted-foreground"
      )}
    >
      <Icon className="mt-[2px] size-3.5 shrink-0 opacity-80" />
      <div className="min-w-0">
        <p>{children}</p>
        {action}
      </div>
    </div>
  );
}

function NoticeAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      className="mt-1 inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground/85 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      onClick={onClick}
      type="button"
    >
      {children}
      <ArrowUpRightIcon className="size-3" />
    </button>
  );
}

export function ContextMeter() {
  const { chat, busy, model, effort } = useSession();
  const { setSettingsSection } = useStore();
  usePreferenceRevision();
  const m = useMemo(() => measure(chat.messages), [chat.messages]);

  const local = Boolean(model.runtime);
  const provider = model.providerLabel || "The runtime";
  const reachable = !local || MODELS.some((item) => item.id === model.id);
  const listed = resolveWindow(model);
  // A reply on this model that ran with a smaller window found out the runtime's real one (it named it).
  const ran = m.reply?.model === model.id ? m.reply.usage?.window : undefined;
  const window = local && ran && (!listed.tokens || ran < listed.tokens) ? { tokens: ran, source: "reported" as const } : listed;
  const max = window.tokens;
  const known = max > 0;
  // The model's maximum alone says little of how full the window is: the runtime may load it far smaller. Only
  // passing it does.
  const gauged = known && (window.source !== "max" || m.used > max);
  const ratio = known ? m.used / max : 0;
  // The bar and the parts' shares are of the whole window; past it, or with no window gauged, of what is in use.
  const scale = Math.max(1, gauged ? Math.max(max, m.used) : m.used);
  // The harness summarizes older turns once a request passes the trigger, so that is the line that matters.
  const trigger = compactLine(model.capabilities.includes("reasoning") && effort !== "none");
  const line = local ? trigger : 0.9;
  const tone: Tone = !gauged ? "calm" : ratio > 1 ? "over" : ratio >= line ? "near" : "calm";
  const empty = chat.messages.length === 0;
  // Ollama's default seen on another model is near certain until this one loads; the maximum is only a ceiling.
  const guessed = window.source === "default";
  const approx = m.estimated || guessed ? "≈ " : "";
  const size = !known ? "—" : window.source === "max" ? `up to ${tokens(max)}` : `${guessed ? "~" : ""}${tokens(max)}`;
  const usage = m.reply?.usage;
  const otherModel = m.reply?.model && m.reply.model !== model.id ? getModel(m.reply.model).name : undefined;
  const noPrice = model.price[0] === 0 && model.price[1] === 0;
  const openModels = () => setSettingsSection("models");

  // At most one notice: the one that most changes how to read the number.
  let notice: ReactNode = null;
  if (local && !reachable) {
    notice = (
      <Notice action={<NoticeAction onClick={openModels}>Check connection</NoticeAction>} tone="warn">
        {provider} is not responding, so the window size is unavailable. Usage shown is from saved replies.
      </Notice>
    );
  } else if (!known && model.runtime === "ollama") {
    // Ollama picks its default window from the server's memory; it is read when the model loads.
    notice = (
      <Notice action={<NoticeAction onClick={openModels}>Set a context length</NoticeAction>}>
        {provider} sets this model’s context size when it loads. It appears after your next message.
      </Notice>
    );
  } else if (!known) {
    notice = (
      <Notice action={local ? <NoticeAction onClick={openModels}>Set a context length</NoticeAction> : undefined}>
        {provider} does not report this model’s context size.
        {local ? " Replies run until the server’s own limit. Set a context length to see how full it is and keep long chats fitted." : ""}
      </Notice>
    );
  } else if (window.source === "default") {
    notice = (
      <Notice action={<NoticeAction onClick={openModels}>Set a context length</NoticeAction>}>
        {provider}’s default on this server, seen on another model. Confirmed when this model loads.
      </Notice>
    );
  } else if (window.source === "max") {
    notice = <Notice>{provider} reports only the model maximum. The loaded window may be smaller.</Notice>;
  } else if (m.estimated && !empty && m.replies > 0 && !usage) {
    notice = <Notice>{provider} did not report token counts, so this is estimated from message text. System prompt and tools are not included.</Notice>;
  } else if (m.totalsOnly && !empty) {
    notice = <Notice>The last reply recorded only totals across its model calls, so this is estimated from message text. System prompt and tools are not included.</Notice>;
  }

  const label = gauged && !empty ? `Context ${approx}${percent(ratio)} full` : "Context usage";

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full px-1.5 text-muted-foreground outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-popup-open:bg-muted/70 data-popup-open:text-foreground",
          tone === "near" && "text-amber-600 dark:text-amber-400",
          tone === "over" && "text-red-500"
        )}
      >
        {tone !== "calm" && <span className="pl-0.5 text-[11.5px] tabular-nums">{percent(ratio)}</span>}
        <Ring ratio={ratio} tone={tone} unknown={!gauged} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" className="isolate z-50 outline-none" collisionPadding={12} side="top" sideOffset={POPUP_GAP}>
          <Popover.Popup className="w-[18.5rem] max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-[12px] bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none duration-100 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <section className="px-3.5 pt-3 pb-2">
              <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  Context window
                  {busy && <span aria-label="Updating" className="size-1.5 animate-pulse rounded-full bg-sky-500" role="status" />}
                </span>
                {(!empty || known) && (
                  <span
                    className={cn(
                      "flex gap-2 tabular-nums",
                      tone === "near" && "text-amber-600 dark:text-amber-400",
                      tone === "over" && "text-red-500"
                    )}
                  >
                    {empty ? (
                      <span>— / {size}</span>
                    ) : (
                      <>
                        {gauged && <span>{`${approx}${percent(ratio)}`}</span>}
                        <span>{`${gauged ? "" : approx}${tokens(m.used)} / ${size}`}</span>
                      </>
                    )}
                  </span>
                )}
              </div>
              {/* One bar for the whole window: each part takes its share of it, and what is left is free. */}
              <div
                aria-hidden
                className={cn(
                  "flex h-1.5 gap-px overflow-hidden rounded-full",
                  gauged ? "bg-foreground/10" : "bg-[repeating-linear-gradient(90deg,color-mix(in_oklab,var(--color-foreground)_15%,transparent)_0_3px,transparent_3px_7px)]"
                )}
              >
                {m.parts.length > 0
                  ? m.parts.map((part) => (
                      <div className={cn("h-full shrink-0 transition-[width] duration-500 ease-out", part.shade)} key={part.key} style={{ width: `${(part.tokens / scale) * 100}%` }} />
                    ))
                  : gauged && (
                      <div
                        className={cn(
                          "h-full shrink-0 rounded-full transition-[width] duration-500 ease-out",
                          tone === "calm" && "bg-foreground/75",
                          tone === "near" && "bg-amber-500",
                          tone === "over" && "bg-red-500",
                          m.estimated && "opacity-60"
                        )}
                        style={{ width: `${Math.min(100, ratio * 100)}%` }}
                      />
                    )}
              </div>
              <div className="mt-1.5">
                {m.parts.map((part) => (
                  <Row
                    hint={percent(part.tokens / scale)}
                    key={part.key}
                    label={
                      <span className="flex items-center gap-1.5">
                        <span className={cn("size-2 shrink-0 rounded-[2px]", part.shade)} />
                        {part.label}
                      </span>
                    }
                    value={`~${tokens(part.tokens)}`}
                  />
                ))}
                {empty && <p className="pb-1 text-[11.5px] text-muted-foreground leading-[1.4]">Fills in after your first message.</p>}
              </div>
            </section>

            {notice}

            {m.reply && (
              <Section
                aside={usage && totals(usage) ? (usage.calls ? `Total of ${usage.calls} model calls` : "Total of all model calls") : undefined}
                title="Last reply"
              >
                {usage ? (
                  <>
                    <Row label="Prompt" value={tokens(usage.input)} />
                    {usage.cached > 0 && <Row hint={percent(usage.cached / Math.max(1, usage.input))} label="Reused from cache" value={tokens(usage.cached)} />}
                    <Row label="Reply" value={tokens(usage.output)} />
                    {usage.reasoning > 0 && <Row label="Thinking" value={tokens(usage.reasoning)} />}
                  </>
                ) : (
                  <Row label="Token counts" muted value="Not reported" />
                )}
              </Section>
            )}

            {m.replies > 0 && (
              <Section title="This chat">
                {m.processed > 0 && <Row hint={m.unreported ? `${m.unreported} unreported` : undefined} label="Tokens processed" value={tokens(m.processed)} />}
                {m.summarized > 0 && <Row label="Summarized" value={`${m.summarized} earlier ${m.summarized === 1 ? "message" : "messages"}`} />}
                <Row
                  label="Est. cost"
                  muted={noPrice}
                  value={noPrice ? (local ? "Free · runs locally" : "Not priced") : m.processed ? `${m.unreported ? "≥ " : ""}${money(m.cost)}` : "Unknown"}
                />
              </Section>
            )}

            {otherModel && (
              <p className="border-foreground/[0.07] border-t px-3.5 py-2 text-[11px] text-muted-foreground">Last reply came from {otherModel}.</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
