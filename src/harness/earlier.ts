/**
 * What earlier replies did, read back from the parts the chat keeps. The conversation sent to the model holds each
 * reply's text only, not its tool calls and results, so without this a model would not know on the next message
 * which files it changed, what it ran, which plan was approved or where its to-do list stood. Shared by the chat and
 * the agent; pure, so a note comes out the same on every request and the prompt before it stays cached.
 */
import { charsFor } from "./budget";
import { planOf, type Args } from "./tools";
import { appNote } from "./app-note";
import type { AppUIMessage } from "../lib/types";

type Part = AppUIMessage["parts"][number];
type ToolPart = Extract<Part, { type: "dynamic-tool" }>;
type Todo = { title: string; status: string };

/**
 * A note's share of the window. Every reply leaves one and they stay until the conversation is summarized, so the
 * share is small; within it a note says what matters most first (./replyNote). The floor still names a few files
 * in a small window; the ceiling keeps a large window from carrying a long list in every later message, as Hermes
 * Agent bounds its window shares.
 */
const NOTE_SHARE = 1 / 50;
const LEAST_NOTE = 400;
const MOST_NOTE = 3000;
/** The window assumed when none is known, as compaction assumes it. */
const UNKNOWN_WINDOW = 4096;

/** Characters one reply's note may take in a request to a window of `window` tokens. */
export const noteChars = (window: number | undefined, ratio = 1) =>
  Math.min(MOST_NOTE, Math.max(LEAST_NOTE, charsFor((window || UNKNOWN_WINDOW) * NOTE_SHARE, ratio)));

/** As many of `items` as fit in `room` characters, newest kept, then how many were left out. */
function fitList(items: string[], room: number, separator: string) {
  const whole = items.join(separator);
  if (whole.length <= room) return whole;
  // Room is kept for saying how many were left out.
  const limit = room - `${separator}and ${items.length} more`.length;
  const kept: string[] = [];
  let used = 0;
  for (const item of [...items].reverse()) {
    if (used + item.length + separator.length > limit) break;
    kept.unshift(item);
    used += item.length + separator.length;
  }
  const left = items.length - kept.length;
  return kept.join(separator) + (left ? `${kept.length ? separator : ""}and ${left} more` : "");
}

const HEADER = "What your previous reply did:";
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}…` : text);

/** A plan as text, for what a summary or a note puts back. */
export const planText = (plan: ReturnType<typeof planOf>) =>
  [plan.title, plan.summary, ...plan.steps.map((step, index) => `${index + 1}. ${step.title}${step.detail ? `: ${step.detail}` : ""}`)].filter(Boolean).join("\n");

const approvedPlan = (part: ToolPart) =>
  part.toolName === "plan_approval" && "approval" in part && part.approval?.approved ? planText(planOf(record(part.input) as Args)) : undefined;

/**
 * Whether the last reply left an approved plan with steps still open on its to-do list, so the next message can go
 * on with it. A plan whose steps are all done, or that had no list, is finished: the next request is new work.
 */
export function openPlanFromLastReply(messages: AppUIMessage[]) {
  const reply = messages.findLast((message) => message.role === "assistant");
  if (!reply?.parts.some((part) => part.type === "dynamic-tool" && approvedPlan(part))) return false;
  const todos = reply.parts.findLast((part) => part.type === "data-todos");
  return todos?.type === "data-todos" && todos.data.items.some((item) => item.status !== "completed");
}

/**
 * What earlier replies left that a summary puts back: the files they changed, the plan approved last, and the to-do
 * list only when the last reply made it. A list belongs to the request it was made for: carried into a later, unrelated
 * one, a model marked its old steps done and added new ones.
 */
export function earlierState(messages: AppUIMessage[]): { changed: string[]; plan?: string; todos?: Todo[] } {
  const state: { changed: string[]; plan?: string; todos?: Todo[] } = { changed: [] };
  const lastReply = messages.findLast((message) => message.role === "assistant");
  for (const message of messages)
    for (const part of message.parts) {
      if (part.type === "data-todos" && message === lastReply) state.todos = part.data.items;
      if (part.type !== "dynamic-tool") continue;
      const path = record(part.input).path;
      if (part.toolName === "edit_file" && typeof path === "string") state.changed.push(path);
      state.plan = approvedPlan(part) ?? state.plan;
    }
  return state;
}

/**
 * One reply's actions as a short note for the message that follows it: questions asked and answered, the plan
 * approved, files changed, commands run and how they ended — in that order, within `chars` (noteChars), the latest of
 * each list kept when it does not all fit. Names only, never file contents; undefined for a reply that did none of
 * these. Its to-do list is left out: it was that request's, and the approved plan says what was meant to be done.
 */
export function replyNote(reply: AppUIMessage, chars = noteChars(undefined)): string | undefined {
  const changed = new Map<string, boolean>();
  const commands: string[] = [];
  const questions: string[] = [];
  let plan: string | undefined;
  for (const part of reply.parts) {
    if (part.type !== "dynamic-tool") continue;
    const input = record(part.input);
    const output = "output" in part ? record(part.output) : {};
    if (part.toolName === "edit_file" && typeof input.path === "string") changed.set(input.path, output.deleted === true);
    // Only a command that ran has an exit code (or a time-out); one denied or still waiting did nothing.
    if (part.toolName === "run_shell" && typeof input.command === "string" && ("exitCode" in output || output.timedOut)) {
      const end = output.timedOut ? "timed out" : typeof output.exitCode === "number" ? `exit code ${output.exitCode}` : "stopped";
      commands.push(`\`${clip(input.command.replace(/\s+/g, " "), 160)}\` (${end})`);
    }
    if (part.toolName === "user_question" && typeof input.question === "string" && ("answer" in output || output.skipped)) {
      const answer = typeof output.answer === "string" && output.answer.trim() ? `they answered: ${clip(output.answer.trim(), 600)}` : "they skipped it";
      questions.push(`${clip(input.question, 300)} — ${answer}`);
    }
    plan = approvedPlan(part) ?? plan;
  }
  const files = [...changed].map(([path, deleted]) => (deleted ? `${path} (deleted)` : path));
  const lines: string[] = [];
  // The app-note tag around it counts too.
  let room = chars - HEADER.length - appNote("\n").length;
  // Each line takes its own length and the line break before it.
  const add = (line: string) => {
    const space = room - 1;
    if (!line || space <= 1) return;
    const fitted = line.length <= space ? line : `${line.slice(0, space - 1)}…`;
    lines.push(fitted);
    room -= fitted.length + 1;
  };
  // What the person said comes first; then what was agreed and where it stands; then what was done.
  if (questions.length) add(`Asked the user: ${fitList(questions, room - 16, "; ")}`);
  // Framed as what happened, not what to do: written as "approved this plan", a model took an unrelated message as
  // the next step of it.
  if (plan) add(`It worked to a plan the user approved; take it up again only if the new message asks:\n${plan}`);
  if (files.length) add(`Files changed: ${fitList(files, room - 16, ", ")}.`);
  if (commands.length) add(`Commands run: ${fitList(commands, room - 16, "; ")}.`);
  return lines.length ? appNote(`${HEADER}\n${lines.join("\n")}`) : undefined;
}
