/**
 * A reply that ended without finishing, and the steps whose outcome nobody saw. Pure functions
 * over the saved message, so a reply stopped a moment ago and one found after the app restarted read the same.
 */
import { isToolPart, toolNameOf } from "./derive";
import { stepTitle } from "./trace";
import type { AppUIMessage, ShellOutput } from "./types";

/** stopped: the person pressed Stop. error: the request failed. closed: the app or its chat process ended mid-reply. expired: an approval it waited for can no longer be answered. */
export type InterruptCause = "stopped" | "error" | "closed" | "expired";

export interface Interruption {
  cause: InterruptCause;
  /** Steps that had started and whose result was never saved: a command may have run, a file may be half-written. */
  unknown: string[];
}

/** The worker keeps a paused run this long (agent.ts PAUSE_MS); an approval older than that has nothing to resume. */
export const PAUSE_MS = 30 * 60_000;
/** The worker's paused runs live only as long as the app; approvals asked before this start are gone. */
const APP_STARTED = Date.now();

/** An approval card that can no longer be answered: asked before this app started, or longer ago than the worker waits. */
export function approvalExpired(message: AppUIMessage, now = Date.now()) {
  const asked = (message.metadata?.createdAt ?? 0) + (message.metadata?.durationMs ?? 0);
  return asked < APP_STARTED || now - asked > PAUSE_MS;
}

const waitsOnApproval = (message: AppUIMessage) => message.parts.some((part) => isToolPart(part) && part.state === "approval-requested");

/** A tool part that started and has no saved result. A running command's last saved output still says "running". */
export function outcomeUnknown(part: AppUIMessage["parts"][number]) {
  if (!isToolPart(part)) return false;
  if (part.state === "input-streaming" || part.state === "input-available") return true;
  return toolNameOf(part) === "run_shell" && part.state === "output-available" && Boolean((part.output as ShellOutput | undefined)?.running);
}

function unknownSteps(message: AppUIMessage) {
  const steps: string[] = [];
  for (const part of message.parts) {
    if (part.type === "data-cot") {
      for (const step of part.data.steps) if (step.status === "active" && step.kind !== "reasoning" && step.kind !== "think") steps.push(stepTitle(step));
    } else if (outcomeUnknown(part) && isToolPart(part)) {
      const name = toolNameOf(part);
      const input = part.input as { command?: string; path?: string } | undefined;
      steps.push(name === "run_shell" && input?.command ? `Ran \`${input.command}\`` : name === "edit_file" && input?.path ? `Changing ${input.path}` : name);
    }
  }
  return [...new Set(steps)];
}

/**
 * How the reply ended when it did not finish, or undefined when it finished or is still live. A finished reply carries
 * its duration (the worker's finish event); a reply paused on approval also does, and is interrupted only once that
 * approval has expired.
 */
export function interruptionOf(message: AppUIMessage, live: boolean, now = Date.now()): Interruption | undefined {
  if (live || message.role !== "assistant") return undefined;
  const marked = message.metadata?.interrupted;
  if (message.metadata?.durationMs !== undefined && !marked) {
    if (!waitsOnApproval(message) || !approvalExpired(message, now)) return undefined;
    return { cause: "expired", unknown: unknownSteps(message) };
  }
  return { cause: marked ?? "closed", unknown: unknownSteps(message) };
}

/** The note the next request carries, so the model checks before repeating what may already have happened. */
export function interruptionNote(interruption: Interruption) {
  if (interruption.unknown.length === 0) return "The previous reply was interrupted before it finished. Continue from where it stopped without repeating what is already written.";
  return `The previous reply was interrupted before it finished. These steps had started and their outcome is unknown: ${interruption.unknown.join("; ")}. Check the current state (read the files, look before rerunning commands) before repeating any of them, then continue.`;
}

/** The approval ID of a question from the agent that still waits for an answer, so the composer can answer it. */
export function waitingQuestion(messages: AppUIMessage[], now = Date.now()) {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || approvalExpired(last, now)) return undefined;
  for (const part of last.parts)
    if (isToolPart(part) && toolNameOf(part) === "user_question" && part.state === "approval-requested" && "approval" in part && part.approval) return part.approval.id;
  return undefined;
}

/** Runtimes that go on writing a trailing assistant message (harness/continuation CONTINUES lists the same). */
const CONTINUES_IN_PLACE: readonly string[] = ["ollama", "llamacpp", "vllm", "sglang"];
/** Parts a reply that was only writing can hold; anything else means it used tools or the agent. */
const WRITING_ONLY = new Set(["text", "reasoning", "step-start", "data-fit", "data-instructions"]);

/**
 * Whether Continue can go on in the same reply (harness/resume): it was only writing, has text to go on from, left
 * nothing uncertain, and its runtime continues a trailing reply. Otherwise Continue asks in a new turn.
 */
export function continuesInPlace(message: AppUIMessage, interruption: Interruption, runtime: string | undefined) {
  if (!runtime || !CONTINUES_IN_PLACE.includes(runtime) || interruption.cause === "expired" || interruption.unknown.length) return false;
  if (!message.parts.every((part) => WRITING_ONLY.has(part.type))) return false;
  return message.parts.some((part) => part.type === "text" && part.text.trim());
}

/** A reply continued in place is whole again: its pieces of text become one and it no longer reads as interrupted. */
export function settleResumed(message: AppUIMessage): AppUIMessage {
  const parts: AppUIMessage["parts"] = [];
  for (const part of message.parts) {
    const previous = parts.at(-1);
    if (part.type === "text" && previous?.type === "text") parts[parts.length - 1] = { ...previous, text: previous.text + part.text };
    else parts.push(part);
  }
  const metadata = { ...message.metadata };
  delete metadata.interrupted;
  return { ...message, parts, metadata };
}

/** What the last reply is waiting for approval on, in the model's words: a command, going online, a plan, a question. */
export function unansweredApprovals(messages: AppUIMessage[]) {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return [];
  return last.parts.flatMap((part) => {
    if (!isToolPart(part) || part.state !== "approval-requested") return [];
    const name = toolNameOf(part);
    const input = part.input as { command?: string; question?: string; title?: string } | undefined;
    if (name === "run_shell") return [`running \`${input?.command ?? "a command"}\``];
    if (name === "web_access") return ["going online"];
    if (name === "plan_approval") return [`the plan${input?.title ? ` "${input.title}"` : ""}`];
    if (name === "user_question") return [`your question${input?.question ? ` "${input.question}"` : ""}`];
    return [name];
  });
}

/** The waiting cards of a reply, closed as not run, so no button on them can resume a run that has moved on. */
export function declineApprovals(message: AppUIMessage): AppUIMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      isToolPart(part) && part.state === "approval-requested" ? { ...part, state: "output-denied" as const, approval: { ...part.approval, approved: false as const } } : part
    ),
  };
}

/** The note sent with a message that went past an unanswered approval. */
export const skippedNote = (skipped: string[]) =>
  skipped.length
    ? `The user sent this message instead of answering the approval for ${skipped.join(" and ")}, so that was not done. Follow this message.`
    : undefined;
