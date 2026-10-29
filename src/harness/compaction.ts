/**
 * Compaction, one way for every chat, with or without a project. Nothing is done while a model writes: the window
 * is checked right before each call (before the first, between a task's calls, before an answer cut at the window
 * goes on), and only a request that would not fit beside the output kept free is made smaller. Sizes are the
 * runtime's own counts where there are any (budget.measuredTokens, lib/message-tokens) and estimates otherwise.
 *
 * Two things are summarized, oldest first, by the model the request is for, thinking as the chat does:
 * - the conversation before this request (compactHistory): everything before the message being answered. The
 *   summary is stored on the reply, so later requests reuse it instead of summarizing again;
 * - a task's own steps (compactSteps), when its tool calls and results fill the window. The summary rides on the
 *   request's last user message for the rest of the task.
 * The user's own messages are kept as written beside the summary, newest first, within a share of the window, as
 * Codex keeps recent user messages; older ones are left to the summary (decision log, 2026-10-25 05:30).
 *
 * A summary call reads as much as the model's window leaves beside the output kept free, the instructions and the
 * summary so far, cut only between messages, and a message too long for one call between paragraphs or lines. Each
 * piece is folded into the summary so far. A piece the runtime refuses as too long loses its oldest message and is
 * sent again, as Codex does.
 */
import type { UIMessageStreamWriter } from "ai";
import { request as makeRequest } from "./vendor/llm/llm";
import { Message, type ContentPart, type LLMEvent } from "./vendor/llm/schema";
import type { AppUIMessage, CompactionData } from "../lib/types";
import type { RuntimeConnection } from "../lib/models";
import { countedMessageTokens } from "../lib/message-tokens";
import { applyStored, estimateText, estimateTokens, textOf } from "../lib/token-estimate";
import { capsFor, guardedStream, type CallInfo } from "./guarded";
import { budgetFor, charsFor, measuredTokens, RESULT_PREFIX, tokensOf } from "./budget";
import { withBody } from "./output";
import type { Tuned } from "./sampling";
import type { ThinkingRequest } from "./thinking";
import { appNote } from "./app-note";

export { applyStored, estimateTokens };

/** The summary's size, as a share of the window: it is sent with every later request. */
const SUMMARY = 1 / 8;
/** The user's own messages kept as written beside a summary, as a share of the window (decision log, 2026-10-25 05:30). */
const USER_SHARE = 0.1;
/** A window assumed for /compact when the runtime reports none, as small local models load by default. */
const UNKNOWN_WINDOW = 4096;

type FinishUsage = Extract<LLMEvent, { type: "finish" }>["usage"];

/**
 * The summary as the message before the newest one, marked where it starts and ends. Framed as background: a model
 * that takes the summary's open items for the request resumes old work instead of answering, and one that reads it as
 * a closed transcript may stop calling tools (Hermes Agent saw both). The end mark matters because the summary and the
 * newest message often go as one message (a chat template takes no two user messages in a row), and without it the
 * earlier requests the summary keeps read as part of the new one.
 */
export function summaryMessage(summary: string, tools = false) {
  return Message.user(
    appNote(
      [
        `Summary of the earlier conversation, which is no longer shown in full. It is background, not a new request.${tools ? " Your tools work as before." : ""}`,
        "",
        summary,
        "",
        "End of the summary. The user's new message comes after this note: reply to it, and take up work the summary lists only when that message asks for it.",
      ].join("\n")
    )
  );
}

/** The runtime's counts of the conversation's messages put on the messages sent for them, by ID. */
export function carryCounts(sent: readonly Message[], messages: readonly AppUIMessage[]) {
  const counts = countedMessageTokens(messages);
  for (const message of sent) {
    const tokens = message.id ? counts.get(message.id) : undefined;
    if (tokens !== undefined) measuredTokens.set(message, tokens);
  }
}

/** What every summary call needs: the model and runtime it goes to, how it thinks, and where its usage is counted. */
interface SummaryCall {
  model: Parameters<typeof makeRequest>[0]["model"];
  layer: typeof import("./chat").layer;
  signal: AbortSignal;
  /** The chat's thinking setting, as the runtime takes it. */
  thinking?: ThinkingRequest;
  /** Whether that setting thinks, for how the output kept free is shared. */
  thinks: boolean;
  /** Shares the server's request slots with the conversation. */
  connection?: RuntimeConnection;
  /** The request fields for an output of at most this many tokens, with the chat's sampling. */
  tune?: (maxTokens?: number) => Tuned;
  /** How the runtime's counts compared with the estimate, for what has no count of its own. */
  ratio?: number;
  /** Each summary call's usage, for the reply it was made for. */
  onUsage?: (usage: FinishUsage, call: CallInfo) => void;
  /** What the person asked the summary to keep, as `/compact <what to keep>` says it. */
  focus?: string;
}

interface Options extends SummaryCall {
  messages: AppUIMessage[];
  contextWindow?: number;
  /** Estimated tokens the request adds besides the conversation: system prompt, tool definitions, run steps. */
  system: number;
  /** Tokens the next call keeps free for its output (budget.reserve), which a summary call keeps free as well. */
  reserve?: number;
  /** Receives the `data-compaction` part; a forced compaction returns it instead. */
  writer?: UIMessageStreamWriter<AppUIMessage>;
  /** Summarize now, as /compact asks, even when the history still fits. */
  force?: boolean;
}

/** Why a history was left as it was: too little to summarize, small enough, or the summary was unusable. */
export type CompactSkip = "short" | "fits" | "failed";

const PROMPT = (words: number, focus?: string) =>
  [
    "Summarize this conversation so it can continue without the original messages.",
    // Requests marked done or open: listed bare, a request already carried out read to the next reply as the task at hand.
    "Use these headings, leaving out any with nothing under it: Requests (each marked done or open), Decisions, Files and what changed, Commands and results, Findings, Still to do.",
    "Keep names, numbers, file paths and the user's preferences exactly as written.",
    "When an earlier summary is given, keep its points unless the conversation changed them.",
    `Write in the conversation's language, in short bullet points, at most about ${words} words.`,
    focus?.trim() ? `The user asked this summary to keep in particular: ${focus.trim().slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join(" ");

// ------------------------------------------------------------------ the ledger

/** Where the app's own record starts in a stored summary; the model's summary is what comes before it. */
const LEDGER = "\n\n[Kept by the app as written, not summarized]";
/** Heads the user's earlier messages; "The user wrote:" in summaries stored before it, still read back. */
const SAID = "The user's earlier messages, as written (each was answered at the time):";

interface Ledger {
  said: string[];
  changed: string[];
}

function ledgerText(ledger: Ledger) {
  const sections = [
    ledger.said.length ? `${SAID}\n${ledger.said.map((line) => `- ${line.replace(/\n/g, "\n  ")}`).join("\n")}` : "",
    ledger.changed.length ? `Files changed:\n${ledger.changed.map((line) => `- ${line}`).join("\n")}` : "",
  ].filter(Boolean);
  // A blank line between the lists, or markdown reads the next heading as part of the last item.
  return sections.length ? `${LEDGER}\n${sections.join("\n\n")}` : "";
}

/** A stored summary split back into the model's part and the app's ledger, which is carried on by the app, not the model. */
function splitSummary(text: string | undefined): { prose: string; ledger: Ledger } {
  const ledger: Ledger = { said: [], changed: [] };
  if (!text) return { prose: "", ledger };
  const at = text.indexOf(LEDGER);
  if (at < 0) return { prose: text, ledger };
  let section: keyof Ledger | undefined;
  for (const line of text.slice(at + LEDGER.length).split("\n")) {
    if (line === SAID || line === "The user wrote:") section = "said";
    else if (line === "Files changed:") section = "changed";
    else if (section && line.startsWith("- ")) ledger[section].push(line.slice(2));
    else if (section === "said" && line.startsWith("  ") && ledger.said.length) ledger.said[ledger.said.length - 1] += `\n${line.slice(2)}`;
  }
  return { prose: text.slice(0, at), ledger };
}

/** The user's messages kept as written, newest first within the share of the window, back in their order. */
function keepSaid(said: { text: string; tokens: number }[], window: number) {
  const kept: string[] = [];
  let room = Math.floor(window * USER_SHARE);
  for (let at = said.length - 1; at >= 0 && said[at].tokens <= room; at--) {
    kept.unshift(said[at].text);
    room -= said[at].tokens;
  }
  return kept;
}

/** A tool call in a line: its name and the argument that says what it worked on. */
function callLine(name: string, input: unknown) {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const target = [args.path, args.paths, args.command, args.url, args.query, args.pattern, args.skill]
    .map((value) => (Array.isArray(value) ? value.join(", ") : value))
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return target ? `${name} ${target}` : name;
}

// ------------------------------------------------------------------ summarizing

interface Item {
  text: string;
  tokens: number;
}

/** A text in parts of about `size` characters, cut where a paragraph or a line ends when it can be. */
function splitLong(text: string, size: number) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const head = rest.slice(0, size);
    const at = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"));
    // A break in the latter half keeps parts near the size; without one the text is cut at the size.
    const cut = at > size / 2 ? at : size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** An item in parts of at most `room` tokens, its tokens shared by length. */
function splitItem(item: Item, room: number): Item[] {
  const count = Math.ceil(item.tokens / Math.max(1, room));
  const texts = splitLong(item.text, Math.ceil(item.text.length / count));
  return texts.map((text) => ({ text, tokens: Math.ceil((item.tokens * text.length) / Math.max(1, item.text.length)) }));
}

/** A runtime's refusal of a request too long for its window, as the profile reads one (profile/models.windowFromError). */
const tooLong = (error: unknown) => /context|n_ctx|max_model_len|too long|exceed/i.test(error instanceof Error ? error.message : String(error));

/** Folds the items into the summary so far, as many at a time as the window leaves room for. Undefined when a piece failed. */
async function summarize(items: Item[], previous: string, contextWindow: number | undefined, reserve: number | undefined, call: SummaryCall) {
  const window = contextWindow ?? UNKNOWN_WINDOW;
  const ratio = call.ratio ?? 1;
  // The output kept free is the one every call of this model keeps; the summary's own length is its share of it.
  const room = Math.min(window, reserve || budgetFor(window, undefined, call.thinks).reserve);
  const length = Math.min(room, Math.floor(window * SUMMARY));
  // Thinking takes what the summary leaves of the output, so it cannot use the summary's room; thinking off, a model
  // that thinks anyway is held as any call is (guarded.capsFor).
  const caps = call.thinks && room > length ? { reasoning: room - length, text: length, total: room } : { ...capsFor(room), text: length };
  const words = Math.max(60, Math.floor(length * 0.6));
  const queue = [...items];
  let summary = previous;
  while (queue.length) {
    const head = (text: string) => `${PROMPT(words, call.focus)}\n\n${text ? `Earlier summary:\n${text}\n\n` : ""}Conversation:\n`;
    const free = window - room - Math.ceil(estimateText(head(summary)) * ratio);
    if (free <= 0) return undefined;
    if (queue[0].tokens > free) queue.splice(0, 1, ...splitItem(queue[0], free));
    const piece: Item[] = [];
    let used = 0;
    while (queue.length && used + queue[0].tokens <= free) {
      used += queue[0].tokens;
      piece.push(queue.shift()!);
    }
    const sent = call.tune?.(room) ?? { generation: { maxTokens: room } };
    let response: Awaited<ReturnType<typeof guardedStream>> | undefined;
    while (!response) {
      try {
        response = await guardedStream({
          input: makeRequest(
            withBody(
              {
                model: call.model,
                system: PROMPT(words, call.focus),
                messages: [Message.user([summary ? `Earlier summary:\n${summary}` : "", `Conversation:\n${piece.map((item) => item.text).join("\n\n")}`].filter(Boolean).join("\n\n"))],
                ...call.thinking,
                ...(sent.generation ? { generation: sent.generation } : {}),
              },
              sent.body
            )
          ),
          layer: call.layer,
          connection: call.connection,
          signal: call.signal,
          caps,
          onUsage: call.onUsage,
        });
      } catch (error) {
        // Refused as too long, the piece drops its oldest message and goes again; a single message is halved.
        if (call.signal.aborted || !tooLong(error) || !piece.length) throw error;
        if (piece.length > 1) piece.shift();
        else if (piece[0].tokens > 1) {
          const [first, ...later] = splitItem(piece[0], Math.ceil(piece[0].tokens / 2));
          piece.splice(0, 1, first);
          queue.unshift(...later);
        } else return undefined;
      }
    }
    // A summary that looped or ran too long is not used.
    const next = response.stopped ? "" : response.text.trim();
    if (!next) return undefined;
    summary = next;
  }
  return summary;
}

// ------------------------------------------------------------------ the conversation before the request

/** A message as the summary reads it: its text, and the tools a reply used, which later requests no longer carry. */
function conversationLine(message: AppUIMessage) {
  const used = message.parts.flatMap((part) => (part.type === "dynamic-tool" ? [`[Used ${callLine(part.toolName, part.input)}]`] : []));
  const text = [textOf(message), ...used].filter(Boolean).join("\n");
  return `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
}

/** Files a reply changed, by the paths of its edits. */
const changedIn = (messages: readonly AppUIMessage[]) =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "dynamic-tool" || part.toolName !== "edit_file") return [];
      const target = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>).path : undefined;
      return typeof target === "string" ? [target] : [];
    })
  );

/**
 * Returns the history to send: the stored or new summary, then the message being answered and what follows it.
 * `data` is set when a new summary was made, and `skipped` says why not otherwise.
 */
export async function compactHistory({ messages, contextWindow, system, reserve = 0, writer, force, ...call }: Options): Promise<{
  summary?: string;
  rest: AppUIMessage[];
  data?: CompactionData;
  skipped?: CompactSkip;
}> {
  const stored = applyStored(messages);
  const ratio = call.ratio ?? 1;
  const counts = countedMessageTokens(messages);
  const tokens = (message: AppUIMessage) => counts.get(message.id) ?? Math.ceil(estimateTokens(message) * ratio);
  const limit = contextWindow && contextWindow >= 1024 ? contextWindow : undefined;
  const size = (list: AppUIMessage[]) => list.reduce((total, message) => total + tokens(message), 0);
  const summaryTokens = stored.summary ? Math.ceil(estimateText(stored.summary) * ratio) : 0;
  const total = Math.ceil(system * ratio) + summaryTokens + size(stored.rest);
  const unchanged = (skipped: CompactSkip) => ({ summary: stored.summary, rest: stored.rest, skipped });
  if (stored.rest.length < 3) return unchanged("short");
  if (!force && (!limit || total + reserve <= limit)) return unchanged("fits");

  // Everything before the message being answered is summarized; that message and what follows stay word for word.
  const latest = stored.rest.findLastIndex((message) => message.role === "user");
  const kept = stored.rest.length - (latest >= 0 ? latest : stored.rest.length - 1);
  const older = stored.rest.slice(0, stored.rest.length - kept);
  if (!older.length) return unchanged("short");

  const earlier = splitSummary(stored.summary);
  const items = older.map((message) => ({ text: conversationLine(message), tokens: tokens(message) }));
  const prose = await summarize(items, earlier.prose, limit, reserve, call);
  if (!prose) return unchanged("failed");
  const said = [
    ...earlier.ledger.said.map((text) => ({ text, tokens: Math.ceil(estimateText(text) * ratio) })),
    ...older.filter((message) => message.role === "user").map((message) => ({ text: textOf(message), tokens: tokens(message) })),
  ].filter((item) => item.text.trim());
  const ledger: Ledger = { said: keepSaid(said, limit ?? UNKNOWN_WINDOW), changed: [...new Set([...earlier.ledger.changed, ...changedIn(older)])] };
  const summary = `${prose}${ledgerText(ledger)}`;
  const rest = stored.rest.slice(stored.rest.length - kept);
  const after = Math.ceil(system * ratio) + Math.ceil(estimateText(summary) * ratio) + size(rest);
  // A summary that leaves the request as large as it was would only be made again on the next request.
  if (!force && after >= total) return unchanged("failed");
  const data: CompactionData = { summary, compacted: older.length, before: total, after, limit: limit ?? 0, upTo: older.at(-1)!.id };
  writer?.write({ type: "data-compaction", id: `compaction-${data.upTo}`, data });
  return { summary, rest, data };
}

// ------------------------------------------------------------------ a task's own steps

/** How a summary of a task's steps starts, in the request's last user message, so a later one can find and replace it. */
const STEPS_NOTE = "<app-note>\nYour earlier steps in this task were summarized to make room in the context window.";
const STEPS_END = "\n</app-note>";

const partText = (part: ContentPart) => {
  if (part.type === "text") return part.text;
  if (part.type === "tool-call") return `Called ${callLine(part.name, part.input)}`;
  if (part.type === "tool-result") return `Result of ${part.name}:\n${part.result.type === "text" ? String(part.result.value) : JSON.stringify(part.result.value)}`;
  return "";
};

/** A step's message as the summary reads it. Thinking is left out: it is not what the next call needs. */
function stepLine(message: Message) {
  const text = message.content.map(partText).filter(Boolean).join("\n");
  if (!text) return "";
  if (message.role === "assistant") return `Assistant: ${text}`;
  if (message.role === "tool") return text;
  return text.startsWith(RESULT_PREFIX) ? text : `User: ${text}`;
}

/** What the user wrote in a task's steps: the answers they gave to its questions and plans. */
const answersIn = (steps: Message[]) =>
  steps.flatMap((message) =>
    message.content.flatMap((part) =>
      part.type === "tool-result" && (part.name === "ask_user" || part.name === "propose_plan")
        ? [part.result.type === "text" ? String(part.result.value) : JSON.stringify(part.result.value)]
        : []
    )
  );

/** The summary note and the message it was taken out of, when the request's last user message carries one. */
function stepsNoteOf(message: Message | undefined) {
  if (message?.role !== "user") return undefined;
  const index = message.content.findIndex((part) => part.type === "text" && part.text.startsWith(STEPS_NOTE));
  if (index < 0) return undefined;
  const part = message.content[index];
  const text = part.type === "text" ? part.text.slice(STEPS_NOTE.length).replace(/^ Summary:\n/, "").replace(STEPS_END, "") : "";
  return { text, without: Message.make({ ...message, content: message.content.filter((_, at) => at !== index) }) };
}

interface StepsOptions extends SummaryCall {
  history: Message[];
  /** Messages before this index are the conversation; the steps follow. */
  from: number;
  contextWindow?: number;
  /** The output kept free (budget.reserve). */
  reserve?: number;
  /** Files the task changed, kept in the ledger. */
  written: string[];
  /** What the app puts back after the summary: the current state of changed files, the plan and the to-do list. */
  state?: string;
}

/**
 * Summarizes a task's steps so far, as Codex summarizes everything but the user's messages: the request's last user
 * message carries the summary from then on. Returns the new history, or undefined when there were no steps or the
 * summary failed.
 */
export async function compactSteps({ history, from, contextWindow, reserve, written, state, ...call }: StepsOptions): Promise<Message[] | undefined> {
  const steps = history.slice(from);
  if (!steps.some((message) => message.role === "assistant")) return undefined;
  const ratio = call.ratio ?? 1;
  const prefix = history.slice(0, from);
  const carried = stepsNoteOf(prefix.at(-1));
  const earlier = splitSummary(carried?.text);
  const items = steps.flatMap((message) => {
    const text = stepLine(message);
    return text ? [{ text, tokens: tokensOf(message, ratio) }] : [];
  });
  const prose = await summarize(items, earlier.prose, contextWindow, reserve, call);
  if (!prose) return undefined;
  const said = [...earlier.ledger.said, ...answersIn(steps)].map((text) => ({ text, tokens: Math.ceil(estimateText(text) * ratio) }));
  const ledger: Ledger = { said: keepSaid(said, contextWindow ?? UNKNOWN_WINDOW), changed: [...new Set([...earlier.ledger.changed, ...written])] };
  const note = `${STEPS_NOTE} Summary:\n${prose}${ledgerText(ledger)}${state ? `\n\n${state}` : ""}${STEPS_END}`;
  const last = carried?.without ?? prefix.at(-1);
  // Riding on the last user message keeps the roles in turn, as chat templates expect.
  return last?.role === "user" ? [...prefix.slice(0, -1), Message.make({ ...last, content: [...last.content, Message.text(note)] })] : [...prefix, Message.user(note)];
}

// ------------------------------------------------------------------ what is put back

/** Recently changed files put back after a summary, and each one's share of the window, as claude-code does (5 files, 5K of 200K). */
const FILES_BACK = 5;
const FILE_SHARE = 5000 / 200_000;

export interface State {
  /** Changed files, newest last. */
  changed: string[];
  /** The file's text from its start, at most `chars` characters, and whether more of it was left out. */
  read: (path: string, chars: number) => Promise<{ content: string; truncated: boolean; lines: number } | undefined>;
  plan?: string;
  todos?: { title: string; status: string }[];
  contextWindow?: number;
  ratio?: number;
}

/**
 * What the app puts back with a summary, so the model goes on from the current state rather than from memory: the
 * approved plan, the to-do list and the recently changed files as they are now.
 */
export async function stateNote({ changed, read, plan, todos, contextWindow, ratio = 1 }: State) {
  const window = contextWindow ?? UNKNOWN_WINDOW;
  const chars = charsFor(window * FILE_SHARE, ratio);
  const files = [...new Set([...changed].reverse())].slice(0, FILES_BACK);
  const shown: string[] = [];
  for (const file of files) {
    const text = await read(file, chars).catch(() => undefined);
    if (!text) continue;
    shown.push(`${file}${text.truncated ? ` (its start; ${text.lines} lines in all)` : ""}:\n${text.content}`);
  }
  const sections = [
    plan ? `The approved plan:\n${plan}` : "",
    todos?.length ? `The to-do list:\n${todos.map((todo) => `- [${todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : " "}] ${todo.title}`).join("\n")}` : "",
    shown.length ? `Recently changed files as they are now:\n\n${shown.join("\n\n")}` : "",
  ].filter(Boolean);
  return sections.length ? `The current state, put back by the app after the summary:\n${sections.join("\n\n")}` : "";
}
