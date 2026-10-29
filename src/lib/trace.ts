/**
 * How a turn's work reads while it runs and after it ends. These are pure functions over the parts the
 * chat worker streams, so a live reply and a reloaded chat are described the same way.
 * The worker reports what happened and when; the wording of states, phases and summaries lives here.
 */
import type { AppUIMessage, CotData, CotKind, CotPhase, CotStep } from "./types";

type Part = AppUIMessage["parts"][number];

/**
 * running: the trace can still change. waiting: paused on an approval. stopped: ended without finishing,
 * such as after Stop or an error. done: the work finished and the answer follows.
 */
export type TraceState = "running" | "waiting" | "stopped" | "done";

/**
 * `asking`: the reply holds an approval that can still be answered. That decides waiting, not the trace's
 * phase, which a later snapshot can overwrite and which stays "waiting" after the approval expired or was skipped.
 */
export function traceState(cot: CotData, streaming: boolean, asking: boolean): TraceState {
  if (cot.finishedAt) return "done";
  if (streaming) return "running";
  return asking ? "waiting" : "stopped";
}

/** Steps other than skills and reasoning: a run that has only followed skills or thought has not chosen any work yet. */
export const workSteps = (cot: CotData) => cot.steps.filter((step) => step.kind !== "skill" && step.kind !== "reasoning");

export const activeStep = (cot: CotData) => cot.steps.findLast((step) => step.status === "active");

const PHASES: Record<CotPhase, string> = {
  deciding: "Choosing the next step",
  acting: "Working",
  checking: "Checking the work",
  waiting: "Waiting for approval",
  answering: "Writing the answer",
};

/** What the agent is doing when no single step describes it. */
export function phaseLabel(cot: CotData) {
  // Before any step the model may still answer directly, so "next step" would promise too much.
  if (cot.phase === "deciding" && workSteps(cot).length === 0) return "Thinking";
  return cot.phase ? PHASES[cot.phase] : "Working";
}

/** The header of a trace that is no longer running. */
export function traceHeadline(cot: CotData, state: Exclude<TraceState, "running">) {
  if (state === "waiting") return "Waiting for approval";
  if (state === "stopped") return "Stopped";
  const took = cot.startedAt && cot.finishedAt ? visibleElapsed(cot.finishedAt - cot.startedAt) : undefined;
  return took ? `Worked for ${took}` : "Worked";
}

export const stepTitle = (step: CotStep) => {
  if (step.status === "complete") return step.doneLabel ?? step.label;
  // While the model thinks, its latest heading says what about.
  return (step.kind === "reasoning" && step.reasoning && reasoningHeading(step.reasoning)) || step.label;
};

/** How long a step took, or has taken so far when `now` is given. Undefined when there is nothing to show. */
export function stepElapsed(step: CotStep, now?: number) {
  if (!step.startedAt) return undefined;
  const end = step.finishedAt ?? (step.status === "active" ? now : undefined);
  return end === undefined ? undefined : Math.max(0, end - step.startedAt);
}

export const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Times under a second read as noise in a trace row. */
export const visibleElapsed = (ms: number | undefined) => (ms !== undefined && ms >= 1000 ? formatElapsed(ms) : undefined);

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** One phrase per kind of work, in lower case so phrases can be joined into a sentence. */
const SUMMARY: Partial<Record<CotKind, (n: number) => string>> = {
  list: (n) => `looked in ${count(n, "folder")}`,
  search: (n) => `ran ${count(n, "search", "searches")}`,
  read: (n) => `read ${count(n, "file")}`,
  write: (n) => `wrote ${count(n, "file")}`,
  web: (n) => `searched the web ${times(n)}`,
  page: (n) => `read ${count(n, "web page")}`,
  delegate: (n) => `asked subagents ${times(n)}`,
  verify: (n) => `ran ${count(n, "command")}`,
  blocked: (n) => `${n} blocked`,
  skill: (n) => `used ${count(n, "skill")}`,
};

/** "Read 3 files, ran 2 searches", in the order the work happened. */
export function summarizeSteps(steps: CotStep[]) {
  const counts = new Map<CotKind, number>();
  let failed = 0;
  for (const step of steps) {
    // Thinking is how the work was chosen, not work of its own.
    if (step.kind === "reasoning") continue;
    if (step.failed) failed++;
    else counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  }
  let other = 0;
  const phrases: string[] = [];
  for (const [kind, n] of counts) {
    const phrase = SUMMARY[kind];
    if (phrase) phrases.push(phrase(n));
    else other += n;
  }
  if (other) phrases.push(count(other, phrases.length ? "other step" : "step"));
  if (failed) phrases.push(`${failed} failed`);
  const sentence = phrases.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const plain = (value: string) =>
  value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim();

/**
 * The latest heading a model wrote in its reasoning, such as "## Checking the config" or a line that is
 * only "**Comparing options**". Models that think in plain prose have none, and the caller says "Thinking".
 */
export function reasoningHeading(text: string) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/) ?? line.match(/^\*\*([^*]+)\*\*:?$/);
    const value = match && plain(match[1]);
    if (value && value.length <= 80) return value;
  }
  return undefined;
}

/** Parts that draw something. Agent traces without steps draw nothing; the status line covers them. */
export function isShown(part: Part) {
  if (part.type === "step-start" || part.type === "data-suggestions") return false;
  if (part.type === "text" || part.type === "reasoning") return Boolean(part.text);
  if (part.type === "data-cot" && part.data.agent) return part.data.steps.length > 0;
  return true;
}

export const agentTrace = (parts: Part[]) =>
  parts.findLast((part): part is Extract<Part, { type: "data-cot" }> => part.type === "data-cot" && Boolean(part.data.agent))?.data;

/**
 * The one status line under a streaming reply, or null when something else already shows progress:
 * streaming text, a streaming thought, or a running agent trace with its own header and timer.
 */
export function turnStatus(parts: Part[], streaming: boolean) {
  if (!streaming) return null;
  const last = parts.findLast(isShown);
  if (last?.type === "text" || (last?.type === "reasoning" && last.state === "streaming")) return null;
  const cot = agentTrace(parts);
  if (!cot) return last?.type === "reasoning" ? "Writing the answer" : "Thinking";
  if (!cot.finishedAt && cot.steps.length > 0) return null;
  return phaseLabel(cot);
}
