/**
 * Project agent for local models: one conversation and one loop. Each call sends the conversation, what this
 * request has done so far and the tools; the model answers with tool calls, which run and come back as results
 * in the same conversation, or with text, which is the answer as it streams. Nothing is copied into a separate
 * context for the answer, so the model answers from what it actually read.
 *
 * A model that cannot call tools natively (its runtime does not support them, or the call fails as unsupported)
 * calls them by writing one JSON object per turn, still in the same conversation, and then answers in it.
 *
 * The context is kept to the window by budget: a request goes whole while it fits; when it would not, the
 * oldest results of this request are cleared first, then the earlier conversation is summarized once; if it
 * still does not fit, the model answers from what it has. Nothing here repeats a compaction or asks the model
 * to do the same thing again.
 *
 * File access goes through Workspace, which enforces the project's folder permissions. Delegation is one level
 * deep: subagents run the same loop in their own conversation and report back once. With Internet Access in Ask
 * for approval mode, the first online call pauses the reply; the approval resumes the same run. A plan, and a
 * shell command the approval mode does not let through (./shell), pause it the same way.
 */
import { createUIMessageStream, createUIMessageStreamResponse, type FinishReason, type UIMessageStreamWriter } from "ai";
import { Message, ToolCallPart, type ContentPart, type LLMEvent } from "./vendor/llm/schema";
import { request as makeRequest } from "./vendor/llm/llm";
import { addSideUsage, identity, imageNote, imageRejected, IMAGES_LEFT_OUT, layer, modelFor, requestText, thinkingOff, toMessages, validate, withoutNewImages, type ChatRequest } from "./chat";
import { thinkingRequest } from "./thinking";
import { learnOutput, learnRatio, measure, modelProfile, recheckWindow, windowFromError, withLiveWindow } from "./profile/models";
import { findSkill, readSkill, skillBudget, skillCatalog } from "./skills";
import { AccessDenied, Workspace } from "./workspace-tools";
import { needsApproval, runShell, shellAvailable, TIMEOUT_MS } from "./shell";
import { carryCounts, compactHistory, compactSteps, stateNote, summaryMessage, type State } from "./compaction";
import { budgetFor, calibrate, charsFor, LEAST_RESULT, clearResults, countedTokens, inputLimit, isCleared, isEstimatedPrompt, measuredTokens, messageTokens, resultRoom, RESULT_PREFIX, wholePrompt, type Anchor, type Budget } from "./budget";
import { guardedStream, type CallInfo, type StreamedToolCall } from "./guarded";
import { outputPlan, withBody } from "./output";
import { tuned } from "./sampling";
import { Stopped } from "./loop-guard";
import { thinkingCall } from "./reasoning";
import { streamReply } from "./reply";
import { concurrency, currentCall, runAs } from "./limit";
import { continueAnswer } from "./continuation";
import { documentize, hasLarge, type Document } from "./documents";
import { hasAttachments, readAttachments } from "./attachments";
import { endpoint } from "./runtime";
import { brokenArguments, markupStart, recoverCalls, unsupportedTools } from "./tool-support";
import { describeFailure } from "./failure";
import { argsOf, definitions, isTool, kindOf, LEAST_TODOS, MAX_QUESTIONS, MAX_SUBAGENTS, missing, planOf, questionOf, runTool, toolGuide, wording, type Args, type Outcome, type Source, type ToolName } from "./tools";
import { estimateText } from "../lib/token-estimate";
import { fitInstructions } from "./instructions";
import { breakdownOf, type SystemParts } from "./breakdown";
import { accessFor, sanitizePolicy, type WorkspacePolicy } from "../lib/workspace-policy";
import type { AppUIMessage, CotData, CotPhase, CotStep, SubagentData, Usage } from "../lib/types";

export interface AgentRequest extends ChatRequest {
  workspace?: WorkspacePolicy;
  skills?: { name: string; description: string; content: string }[];
  projectName?: string;
}

/** Model calls one request may make before it answers from what it found. */
const MAX_TURNS = 20;
const MAX_SUBAGENT_TURNS = 12;
/** Calls in a row that failed or could not run before tools are put away and the model answers. */
const FAILURES = 3;
/** Summaries one answer may make after its first call (claude-code and Hermes stop after a few as well). */
const MAX_COMPACTIONS = 3;
/** A summary must bring the request under this share of its size before, or no further one is tried. */
const SHRINK = 0.9;
/** Skills one request may follow, whether named by the person or chosen by the agent. */
const MAX_SKILLS = 3;
/** Reasoning kept per trace row for display; the model's own conversation keeps all of it. */
const MAX_REASONING = 20_000;
/** The project outline's share of the window, in tokens. */
const OUTLINE = 0.08;

const ANSWER_NOW = "Answer the user now from what you found so far. Do not call tools. Say what is left unfinished.";

type FinishUsage = Extract<LLMEvent, { type: "finish" }>["usage"];

/** Turns whose first answering call is counted already, so later calls do not move `first`. */
const counted = new WeakSet<Usage>();

function addUsage(total: Usage, usage: FinishUsage | undefined, call?: CallInfo) {
  if (!usage) return;
  if (!counted.has(total)) {
    counted.add(total);
    if (usage.inputTokens !== undefined && !isEstimatedPrompt(usage)) total.first = usage.inputTokens;
  }
  const visible = Math.max(0, (usage.outputTokens ?? 0) - (usage.reasoningTokens ?? 0));
  total.input += usage.inputTokens ?? 0;
  total.reasoning += usage.reasoningTokens ?? 0;
  total.output += visible;
  total.cached += usage.cacheReadInputTokens ?? 0;
  total.context = (usage.inputTokens ?? 0) + visible;
  // The latest call's reply count, only when neither thinking nor tool arguments are folded into it.
  const exact = !!call && usage.outputTokens !== undefined && (usage.reasoningTokens !== undefined || !call.thought) && !call.tools;
  total.reply = exact ? visible : undefined;
  if (call?.decodeMs) total.decodeMs = (total.decodeMs ?? 0) + call.decodeMs;
  total.calls = (total.calls ?? 0) + 1;
  if (isEstimatedPrompt(usage)) total.estimated = true;
}

/**
 * A call's count, kept for the next request: what the prompt grew by since the last call is put on the messages added
 * in between (tool results), shared by their estimated size, and the call's prompt and output become the new anchor,
 * which the message its output turns into completes.
 */
function settle(run: Run, usage: FinishUsage) {
  const input = usage?.inputTokens;
  if (input === undefined) return;
  const anchor = run.anchor;
  if (anchor && anchor.length <= run.history.length) {
    const added = run.history.slice(anchor.length);
    const grown = input - anchor.tokens;
    const estimated = added.reduce((total, message) => total + messageTokens(message), 0);
    if (added.length && grown > 0 && estimated > 0)
      for (const message of added) measuredTokens.set(message, Math.round((grown * messageTokens(message)) / estimated));
  }
  const output = usage?.outputTokens ?? 0;
  run.lastOutput = output;
  run.anchor = { tokens: input + output, length: run.history.length + 1 };
}

/**
 * Whether a model calls tools natively. Ollama says so per model; other runtimes are tried, and a model whose
 * calls fail as unsupported twice is remembered as one that writes JSON instead, for the worker's lifetime.
 */
const strikes = new Map<string, number>();
const toolKey = (body: ChatRequest) => `${endpoint(body.connection)}|${body.runtimeModelId}`;
export const resetToolModes = () => strikes.clear();
async function nativeTools(body: ChatRequest) {
  if ((strikes.get(toolKey(body)) ?? 0) >= 2) return false;
  const { facts } = await modelProfile(body);
  return body.runtime === "ollama" && facts.capabilities ? facts.capabilities.includes("tools") : true;
}

const JSON_STEP = {
  type: "object",
  properties: { tool: { type: "string" }, arguments: { type: "object" } },
  required: ["tool"],
};
const jsonGuide = (names: readonly ToolName[]) =>
  [
    "Tools:",
    toolGuide(names),
    'To use a tool, reply with only one JSON object: {"tool": "<name>", "arguments": {...}}. When you are ready to answer, reply {"tool": "answer"}.',
  ].join("\n");
const parseJsonStep = (text: string): { tool?: string; arguments?: unknown } | undefined => {
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.tool === "string") return value;
    } catch {
      /* the next candidate */
    }
  }
  return undefined;
};

/** The project folders, written for the system prompt within their share of the window. */
const outlineChars = (window: number | undefined) => (window ? charsFor(window * OUTLINE) : 6000);

interface Abilities {
  files: boolean;
  web: boolean;
  /** Whether the coordinator may load installed skills. Subagents work from their assignment. */
  skills?: boolean;
  /** Text in the conversation too long to send whole, read through document tools (./documents). */
  documents?: boolean;
  /** The run can change something (a Read & write folder), so work with several changes may keep a to-do list. */
  changes?: boolean;
  /** Shell commands, sandboxed to the project's folders (./shell). */
  shell?: boolean;
}
const toolsFor = (abilities: Abilities, coordinator: boolean): ToolName[] => [
  ...(abilities.files ? (["list", "search", "read", "edit", "write", "delete"] as ToolName[]) : []),
  ...(abilities.shell ? (["run_shell"] as ToolName[]) : []),
  ...(abilities.web ? (["web_search", "fetch"] as ToolName[]) : []),
  ...(abilities.documents ? (["read_document", "search_document"] as ToolName[]) : []),
  ...(coordinator && abilities.changes ? (["update_todos", "propose_plan"] as ToolName[]) : []),
  ...(coordinator && abilities.skills ? (["use_skill"] as ToolName[]) : []),
  ...(coordinator ? (["ask_user", "delegate"] as ToolName[]) : []),
];

/**
 * How to read the folder list. Small models took "(read only)" for "cannot open" and never looked
 * past the list, so the labels are stated as what they let the model do, what is missing from the list is explained,
 * and the list is said to be names only. The same text every time, so the prompt stays cached.
 */
const FILE_NOTES = [
  "How to read the folder list: (read & write) means you can open, change, create and delete the files in that folder; (read only) means you can open and read them but not change them. A folder with no label has the same access as the folder above it. Every file and folder in the list can be opened and read, except secrets (below).",
  "Files and folders the user set to No access are left out of the list entirely; you cannot open them, and you do not need to mention them unless asked.",
  "The list shows names only. To answer anything about what a file says, or to check that a file can be read, open it with read (or list a folder with list) first; never describe a file you have not read.",
  "Files such as .env and private keys are secrets: they can be listed but never opened or changed. Use paths exactly as listed, starting with the folder name. Access is set by the user and can change between messages; this list shows it as it is now.",
].join(" ");
/** Holds for the main agent and its subagents alike. */
const HONESTY = "Never claim to have read, searched or written something you did not.";
const ANSWER_NOTES = [
  "Finish every part of the request before you answer: if the user asks you to search, search; if they ask for a file, write it.",
  HONESTY,
  "Answer at the length the request needs: in full when asked to explain, summarize or list what was read; briefly for a simple question.",
].join(" ");
/** For a run with web tools, the main agent's and its subagents'. */
const webNote = () => `Internet access is on. Today is ${new Date().toISOString().slice(0, 10)}. Cite web facts with their source number, as [n].`;

/** What one run keeps between its calls, and across an approval pause. */
interface Run {
  chatId: string;
  started: number;
  usage: Usage;
  cot: CotData;
  system: string;
  /** Messages before this index are the conversation; after it, what this request did. */
  from: number;
  history: Message[];
  /** Each call's trace wording, for the line left when its result is cleared. */
  labels: Map<string, string>;
  /** Calls already run, by name and arguments, with the ID of their result. */
  seen: Map<string, string>;
  written: string[];
  sources: Source[];
  subagents: SubagentData[];
  skills: { name: string; content: string }[];
  /** Text in the conversation too long to send whole, in pieces the tools read. */
  documents: Document[];
  ratio: number;
  /** Web access for this run: undefined until asked when approval is required. */
  web?: boolean;
  /** Compactions made since the run's first call (MAX_COMPACTIONS). */
  compactions: number;
  /** The conversation before this request was summarized already, so the next compaction goes to the run's steps. */
  conversationCompacted: boolean;
  /** The runtime refused the last request as too long for its window, so the next one is made smaller first. */
  overflowed?: boolean;
  /** The last call's count, which the next request's size starts from (budget.countedTokens); gone once the history before it changes. */
  anchor?: Anchor;
  /** The last call's output as counted, put on the message it becomes. */
  lastOutput?: number;
  /** The plan the user approved in this request, and the to-do list as it stands, for what a summary puts back. */
  plan?: string;
  todos?: { title: string; status: string }[];
  failures: number;
  turn: number;
  /** Tools are called natively, or by writing JSON. Decided once per run. */
  native: boolean;
  /** Thinking was stopped for looping, so the rest of the run asks for none. */
  thinkingOff: boolean;
  cleared: number;
  /** The run already fitted itself once to a window the runtime named. */
  refitted?: boolean;
  /** What the person answered when a call asked for approval (a plan, a shell command), by the call's ID. */
  decisions: Map<string, Decision>;
  /** Questions this request asked the user, so the same one is not asked again (MAX_QUESTIONS). */
  questions?: string[];
  /** The system prompt by part and the summary message, for the context meter (./breakdown). A subagent has none. */
  parts?: SystemParts;
  summary?: Message;
}

/** What a run can pause to ask: going online, a plan, a shell command, a question for the user. */
type ApprovalKind = "web_access" | "plan_approval" | "run_shell" | "user_question";
const APPROVALS: readonly ApprovalKind[] = ["web_access", "plan_approval", "run_shell", "user_question"];

interface Decision {
  approved: boolean;
  always: boolean;
  /** For a plan: "cancel", or what to change. For a question: the answer. */
  reason?: string;
  /** The card that asked, which the call's outcome is shown on. */
  toolCallId: string;
}

interface Pending {
  run: Run;
  /** Calls of the paused turn not run yet, the one that asked first. */
  calls: StreamedToolCall[];
  kind: ApprovalKind;
  expires: number;
}
const paused = new Map<string, Pending>();
/** Chats where the person chose Always allow for web access. Process-local, like the original's approvals. */
const alwaysOnline = new Set<string>();
/** Chats where the person chose Always allow for shell commands. */
const alwaysShell = new Set<string>();
const PAUSE_MS = 30 * 60_000;

type Part = AppUIMessage["parts"][number];
function approvalResponse(messages: AppUIMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return undefined;
  const part = last.parts.find(
    (item: Part) => item.type === "dynamic-tool" && APPROVALS.includes(item.toolName as ApprovalKind) && item.state === "approval-responded"
  ) as Extract<Part, { type: "dynamic-tool" }> | undefined;
  if (!part || part.state !== "approval-responded") return undefined;
  const reason = part.approval.reason;
  return { messageId: last.id, toolCallId: part.toolCallId, kind: part.toolName as ApprovalKind, approved: part.approval.approved, always: reason === "always", reason };
}

/** How a loop shows what it does: the coordinator in the trace and the reply, a subagent in its card. */
interface View {
  text?: (delta: string) => void;
  reasoning: (delta: string) => void;
  thoughtDone: () => void;
  toolStart: (name: ToolName, args: Args) => { done: (outcome: Outcome) => void };
  note: (stopped: Stopped, retried: boolean) => void;
  room?: (cleared: number) => void;
  /** The runtime named a smaller window; the step is fitted to it and sent again. */
  refit?: (fit: { window: number; runtime?: number }) => void;
  blocked?: (label: string, note: string) => void;
  /** A command's own card, placed in the trace where it ran (CotStep.card). The main agent's commands only. */
  card?: (toolCallId: string, label: string) => void;
}

interface Env {
  body: AgentRequest;
  workspace: Workspace;
  writer: UIMessageStreamWriter<AppUIMessage>;
  signal: AbortSignal;
  abilities: Abilities;
  coordinator: boolean;
  maxTurns: number;
  view: View;
  /**
   * Makes the request smaller with a summary, oldest first: the conversation before this request, once, then the
   * run's earlier steps. Changes the run's history; false when there was nothing left to summarize.
   */
  compact?: (run: Run, budget: Budget) => Promise<boolean>;
  /** Runs delegate and use_skill, which need the coordinator's state. */
  special?: (call: StreamedToolCall, name: ToolName, args: Args, room: number) => Promise<Outcome>;
  /**
   * For a call that needs approval first (going online, a plan, a shell command): shows the card, pauses the run
   * and returns true. The answer resumes the run from that call.
   */
  ask?: (calls: StreamedToolCall[], request?: { kind: Exclude<ApprovalKind, "web_access">; input: unknown }) => boolean;
}

type LoopEnd = { kind: "answered"; text: string } | { kind: "paused" } | { kind: "stopped"; text: string };

const signatureOf = (name: string, args: Args) => `${name}:${JSON.stringify(args)}`;
const online = (name: ToolName, abilities: Abilities) => name === "web_search" || name === "fetch" || (name === "delegate" && abilities.web);

/** A plan as text, for what a summary puts back. */
const planText = (plan: ReturnType<typeof planOf>) =>
  [plan.title, plan.summary, ...plan.steps.map((step, index) => `${index + 1}. ${step.title}${step.detail ? `: ${step.detail}` : ""}`)].filter(Boolean).join("\n");

/** What earlier replies left that a summary puts back: the files they changed, the plan approved last, the latest to-do list. */
function earlierState(messages: AppUIMessage[]): Pick<State, "changed" | "plan" | "todos"> {
  const state: Pick<State, "changed" | "plan" | "todos"> = { changed: [] };
  for (const message of messages)
    for (const part of message.parts) {
      if (part.type === "data-todos") state.todos = part.data.items;
      if (part.type !== "dynamic-tool") continue;
      const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
      if (part.toolName === "edit_file" && typeof input.path === "string") state.changed.push(input.path);
      if (part.toolName === "plan_approval" && "approval" in part && part.approval?.approved) state.plan = planText(planOf(input as Args));
    }
  return state;
}

/** Reads a file's start through the workspace, as the read tool would, for what a summary puts back. */
const readerOf = (workspace: Workspace): State["read"] => async (file, chars) => {
  const text = await workspace.read(file, 1, chars);
  return text.binary ? undefined : { content: text.content, truncated: text.truncated, lines: text.lines };
};

/**
 * What the model is told once the person answered its plan: carry it out (its steps become the to-do list when
 * there are enough of them), change it as asked, or stop.
 */
function planOutcome(writer: UIMessageStreamWriter<AppUIMessage>, decision: Decision | undefined, args: Args): Outcome {
  if (!decision) return { text: "Not run: a plan needs the user's approval, which only the main agent can ask for.", failed: "No approval" };
  if (decision.approved) {
    const steps = planOf(args).steps;
    if (steps.length >= LEAST_TODOS)
      writer.write({ type: "data-todos", id: "todos", data: { items: steps.map((step, index) => ({ id: `todo-${index + 1}`, title: step.title, status: "pending" as const })) } });
    return { text: `The user approved the plan. Carry it out now, step by step${steps.length >= LEAST_TODOS ? ", marking each step in the to-do list with update_todos as you go" : ""}.` };
  }
  if (decision.reason && decision.reason !== "cancel")
    return { text: `The user asked for changes to the plan: ${decision.reason.slice(0, 2000)}\nPropose a revised plan with propose_plan.` };
  return { text: "The user cancelled the plan. Do not carry it out; answer briefly and ask what they would like instead." };
}

/** What the model is told once the person answered its question, or skipped it. */
function questionOutcome(decision: Decision | undefined): Outcome {
  if (!decision) return { text: "Not asked: only the main agent can ask the user, and only up to its limit. Go on with your best judgment and say what you assumed.", failed: "Not asked" };
  if (decision.approved && decision.reason?.trim()) return { text: `The user answered: ${decision.reason.trim().slice(0, 2000)}` };
  return { text: "The user skipped the question. Go on with your best judgment and say briefly what you assumed." };
}

/** Output the chat keeps of a command, and how often it shows more while the command runs. */
const SHOWN_OUTPUT = 100_000;
const SHELL_UPDATE_MS = 200;

/** Where a command runs, as the approval card and the sandbox need it; throws AccessDenied for a folder without access. */
function shellTarget(run: Run, env: Env, args: Args) {
  const { workspace } = env;
  const cwd = args.cwd ? workspace.resolve(args.cwd) : workspace.policy.folders.find((folder) => folder.access !== "none")?.path;
  if (!cwd || accessFor(workspace.policy, cwd) === "none") throw new AccessDenied(`${args.cwd ?? "This project"} has no access.`, args.cwd ?? "");
  // The network follows Internet Access, and a run where going online was refused stays off it.
  return { command: args.command ?? "", cwd, label: workspace.label(cwd), network: env.abilities.web && run.web !== false };
}

/** The command's target for its approval card, or undefined when it cannot run anyway (runCall says why). */
function askableTarget(run: Run, env: Env, args: Args) {
  try {
    return shellTarget(run, env, args);
  } catch {
    return undefined;
  }
}

/**
 * Runs a shell command once it may: asked and allowed, or let through by the approval mode. Its
 * output streams to its own row and the Terminal tab; the model gets the end of it, as much as its room allows.
 */
async function shellCall(run: Run, env: Env, call: StreamedToolCall, args: Args, room: number): Promise<Outcome> {
  const decision = run.decisions.get(call.id);
  if (decision && !decision.approved) return { text: "Not run: the user denied this command. Do not run it again; continue without it or ask what they would like instead.", blocked: "Command denied" };
  if (!decision && needsApproval(env.body.approval, args.command ?? "", alwaysShell.has(run.chatId)))
    return { text: "Not run: this command needs the user's approval, which only the main agent can ask for. Report that it needs running instead.", failed: "Needs approval" };
  if (room < LEAST_RESULT) return { text: "Not run: the context has no room left for its output. Answer with what you have.", failed: "No room left" };
  let target: ReturnType<typeof shellTarget>;
  try {
    target = shellTarget(run, env, args);
  } catch (error) {
    if (error instanceof AccessDenied) return { text: `Denied: ${error.message}`, blocked: error.message, level: error.level };
    throw error;
  }
  const { command, cwd, label, network } = target;
  // An approved command shows on the card that asked; one that needed no approval gets its own row.
  const toolCallId = decision?.toolCallId ?? `run_shell-${crypto.randomUUID()}`;
  if (!decision) {
    env.writer.write({ type: "tool-input-available", toolCallId, toolName: "run_shell", input: { command, cwd: label, network }, dynamic: true });
    env.view.card?.(toolCallId, wording("run_shell", args).done);
  }
  const show = (output: string, done?: { exitCode: number | null; timedOut?: boolean }) =>
    env.writer.write({
      type: "tool-output-available",
      toolCallId,
      output: { command, stdout: output.slice(-SHOWN_OUTPUT), ...(done ? done : { running: true }) },
      dynamic: true,
      ...(done ? {} : { preliminary: true }),
    });
  let shown = 0;
  let result;
  try {
    result = await runShell({
      command,
      cwd,
      policy: env.workspace.policy,
      network,
      signal: env.signal,
      onOutput: (output) => {
        if (Date.now() - shown < SHELL_UPDATE_MS) return;
        shown = Date.now();
        show(output);
      },
    });
  } catch (error) {
    if (env.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : "The command could not start.";
    show(message, { exitCode: null });
    return { text: `Failed: ${message}`, failed: message.slice(0, 120) };
  }
  show(result.output, { exitCode: result.exitCode, timedOut: result.timedOut });
  // A failing command is a result like any other; only what kept it from running counts as a failure.
  const status = result.timedOut ? `stopped after ${TIMEOUT_MS / 60_000} minutes` : result.exitCode === null ? "stopped" : `exit code ${result.exitCode}`;
  const header = `$ ${command}\n(${status}${cwd === env.workspace.policy.folders[0]?.path ? "" : `, in ${label}`})\n`;
  const keep = Math.max(200, charsFor(room, run.ratio) - header.length - 80);
  const output = result.output.length > keep ? `… ${result.output.length - keep} earlier characters left out\n${result.output.slice(-keep)}` : result.output || "(no output)";
  return { text: header + output };
}

/** Runs one tool call and returns its result for the model. */
async function runCall(run: Run, env: Env, call: StreamedToolCall, room: number): Promise<string> {
  const allowed = toolsFor(env.abilities, env.coordinator);
  if (!isTool(call.name) || !allowed.includes(call.name)) {
    run.failures++;
    return `Not run: there is no tool named "${call.name}". Tools: ${allowed.join(", ")}.`;
  }
  const name = call.name;
  const args = argsOf(call.input);
  const label = wording(name, args);
  run.labels.set(call.id, label.done);
  const problem = missing(name, args);
  if (problem) {
    run.failures++;
    return problem;
  }
  const signature = signatureOf(name, args);
  const earlier = run.seen.get(signature);
  // The same call again, while its result is still in the conversation, is answered from that result.
  if (earlier && name !== "write" && name !== "edit" && name !== "run_shell" && !clearedResult(run, earlier)) {
    run.failures++;
    return `Not run: this exact call already ran in this request. Its result is above.`;
  }
  if (online(name, env.abilities) && run.web === false) {
    env.view.blocked?.(label.failed, "Web access not allowed");
    return "Not run: web access was not allowed for this request.";
  }
  // The to-do list and the main agent's commands show as their own rows, so they add no trace step.
  const trace = name === "update_todos" || (name === "run_shell" && env.coordinator) ? { done: () => {} } : env.view.toolStart(name, args);
  const outcome =
    name === "run_shell"
      ? await shellCall(run, env, call, args, room)
      : name === "use_skill" || name === "delegate" || name === "propose_plan" || name === "ask_user"
      ? await env.special!(call, name, args, room)
      : await runTool({ workspace: env.workspace, writer: env.writer, signal: env.signal, sources: run.sources, room, ratio: run.ratio, documents: run.documents }, name, args);
  trace.done(outcome);
  run.seen.set(signature, call.id);
  const wrote = [outcome.wrote ?? []].flat();
  run.written.push(...wrote);
  if (wrote.length || name === "run_shell") {
    // Files may have changed: reading, listing or searching again shows something new.
    for (const [key] of run.seen) if (/^(read|list|search):/.test(key)) run.seen.delete(key);
  }
  run.failures = outcome.failed || outcome.blocked ? run.failures + 1 : 0;
  return outcome.text;
}

function clearedResult(run: Run, id: string) {
  const message = run.history.find((item) => item.role === "tool" && item.content[0]?.type === "tool-result" && item.content[0].id === id);
  const part = message?.content[0];
  return part?.type === "tool-result" && isCleared(String(part.result.value));
}

/** Fits the next call into the window: clears old results, then compacts once. False when it still does not fit. */
/**
 * Fits the next request in the window, right before it is sent: old tool results of the run are cleared first,
 * then summaries are made, a few at most per answer, each one required to shrink the request.
 */
async function makeRoom(run: Run, env: Env, budget: Budget, extra: number, added = 0) {
  const size = () => countedTokens(run.system, run.history, run.ratio, extra, run.anchor, added);
  const fit = () => {
    const fitted = clearResults(run.system, run.history, run.from, budget, run.ratio, (id) => run.labels.get(id) ?? "A tool ran", extra, run.anchor, added);
    run.history = fitted.history;
    if (fitted.cleared) {
      run.cleared += fitted.cleared;
      run.anchor = undefined;
      env.view.room?.(run.cleared);
    }
    return fitted.fits;
  };
  // A request the runtime refused is made smaller even where the estimate says it fits: the estimate was low.
  let fits = fit() && !(run.overflowed && env.compact);
  run.overflowed = false;
  while (!fits && env.compact && run.compactions < MAX_COMPACTIONS) {
    run.compactions++;
    const before = size();
    if (!(await env.compact(run, budget))) break;
    run.anchor = undefined;
    fits = fit();
    // A summary that barely shrank the request would only be followed by another like it.
    if (!fits && size() > before * SHRINK) break;
  }
  return fits;
}

/** The loop: one call per turn until the model answers, the turns run out or the context is full. */
async function drive(run: Run, env: Env, pending: StreamedToolCall[] = []): Promise<LoopEnd> {
  const { body, signal } = env;
  const names = toolsFor(env.abilities, env.coordinator);
  const skillNames = (body.skillCatalog ?? []).map((skill) => skill.name);
  const defs = definitions(names, skillNames);
  const extra = estimateText(JSON.stringify(defs));
  // A paused turn's remaining calls run first, then the loop goes on.
  if (pending.length && !(await runCalls(run, env, pending))) return { kind: "paused" };
  while (true) {
    const final = run.turn >= env.maxTurns || run.failures >= FAILURES || !names.length;
    const thinks = !run.thinkingOff && !thinkingOff(body) && Boolean(body.reasoningSupported);
    const system = run.native || final ? run.system : `${run.system}\n\n${jsonGuide(names)}`;
    const plan = await measure(body, system, run.history, thinks, final ? 0 : extra, run.anchor);
    const fits = await makeRoom(run, env, plan.budget, final ? 0 : extra);
    const last = final || !fits;
    if (!fits) env.view.blocked?.("Context window full", "Answering with what was found so far");
    run.turn++;
    if (!run.native && !last) {
      const step = await jsonTurn(run, env, system, names).catch(async (error: unknown) => {
        if (await refit(run, env, error instanceof Error ? error.message : String(error))) return "retry" as const;
        throw error;
      });
      if (step === "retry") {
        run.turn--;
        continue;
      }
      if (step === "answer") return answerAfterJson(run, env);
      if (step === "paused") return { kind: "paused" };
      continue;
    }
    const outcome = await nativeTurn(run, env, last ? `${run.system}\n\n${ANSWER_NOW}` : run.system, last ? undefined : defs, thinks, last ? 0 : extra);
    if (outcome === "unsupported") {
      // The runtime refused native tools: this run goes on writing JSON, from the same conversation.
      strikes.set(toolKey(body), (strikes.get(toolKey(body)) ?? 0) + 1);
      run.native = false;
      run.turn--;
      continue;
    }
    if (outcome === "retry") {
      run.turn--;
      continue;
    }
    if (outcome.kind !== "calls") return outcome;
    // Offered no tools, a model may still write a call; what it wrote besides is its answer.
    if (last) return { kind: "answered", text: outcome.text };
    if (!(await runCalls(run, env, outcome.calls))) return { kind: "paused" };
    if (signal.aborted) throw signal.reason;
  }
}

/** New results need at least this share of the input budget; older results are cleared to give it. */
const RESULT_SHARE = 1 / 4;

/** Runs a turn's calls in order. False when an online call paused the run for approval. */
async function runCalls(run: Run, env: Env, calls: StreamedToolCall[]) {
  const { budget } = await measure(env.body, run.system, run.history, true, 0, run.anchor);
  // Clearing older results for this turn's results beats shrinking each new one toward nothing.
  if (budget.window) {
    const need = Math.floor(inputLimit(budget) * RESULT_SHARE);
    const fitted = clearResults(run.system, run.history, run.from, budget, run.ratio, (id) => run.labels.get(id) ?? "A tool ran", 0, run.anchor, need);
    run.history = fitted.history;
    if (fitted.cleared) {
      run.cleared += fitted.cleared;
      run.anchor = undefined;
      env.view.room?.(run.cleared);
    }
  }
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    const name = isTool(call.name) ? call.name : undefined;
    if (name && online(name, env.abilities) && run.web === undefined && env.ask?.(calls.slice(index))) return false;
    // A plan waits for the person's answer before anything else runs.
    if (name === "propose_plan" && !run.decisions.has(call.id) && !missing(name, argsOf(call.input)) && env.ask?.(calls.slice(index), { kind: "plan_approval", input: planOf(argsOf(call.input)) }))
      return false;
    // A question waits for the answer; past the limit, or asked before, it is not asked and the model is told so.
    if (name === "ask_user" && !run.decisions.has(call.id) && !missing(name, argsOf(call.input)) && env.ask) {
      const question = questionOf(argsOf(call.input));
      const asked = run.questions ?? [];
      const again = asked.some((item) => item.toLowerCase() === question.question.toLowerCase());
      if (!again && asked.length < MAX_QUESTIONS && env.ask(calls.slice(index), { kind: "user_question", input: question })) {
        run.questions = [...asked, question.question];
        return false;
      }
    }
    // A command the approval mode does not let through asks first; one with nowhere to run is refused by runCall.
    if (name === "run_shell" && !run.decisions.has(call.id) && env.ask) {
      const args = argsOf(call.input);
      const target = missing(name, args) ? undefined : askableTarget(run, env, args);
      if (target && needsApproval(env.body.approval, target.command, alwaysShell.has(run.chatId)) && env.ask(calls.slice(index), { kind: "run_shell", input: { command: target.command, cwd: target.label, network: target.network } }))
        return false;
    }
    // Each call of the turn gets an equal share of what the request leaves.
    const used = countedTokens(run.system, run.history, run.ratio, 0, run.anchor);
    const room = Math.floor(resultRoom(budget, used) / (calls.length - index));
    const text = await runCall(run, env, call, room);
    run.history.push(
      run.native
        ? Message.tool({ id: call.id, name: call.name, result: text, resultType: "text" })
        : Message.user(`${RESULT_PREFIX}${run.labels.get(call.id) ?? call.name}:\n${text}`)
    );
  }
  return true;
}

/** One native call. Its text streams as it comes; its tool calls are returned to run. */
async function nativeTurn(
  run: Run,
  env: Env,
  system: string,
  tools: ReturnType<typeof definitions> | undefined,
  thinks: boolean,
  extra: number
): Promise<{ kind: "calls"; calls: StreamedToolCall[]; text: string } | LoopEnd | "unsupported" | "retry"> {
  const { body } = env;
  run.lastOutput = undefined;
  const plan = await measure(body, system, run.history, thinks, extra, run.anchor);
  const output = outputPlan(body.runtime, plan.budget, plan.input, plan.cap, thinks);
  const sent = tuned(body, thinks, output);
  const input = makeRequest(
    withBody(
      {
        model: modelFor(body),
        system,
        messages: run.history,
        ...(tools ? { tools } : {}),
        ...(await thinkingRequest(body, thinks, run.thinkingOff)),
        ...(sent.generation ? { generation: sent.generation } : {}),
      },
      sent.body
    )
  );
  let reasoning = "";
  let text = "";
  // Text up to here went to the screen. When tools were offered, tool-call markup a runtime left in the text
  // is held back from where it starts, until the call ends shows whether it was a call.
  let shown = 0;
  const show = (upTo: number) => {
    if (upTo <= shown) return;
    env.view.text?.(text.slice(shown, upTo));
    shown = upTo;
  };
  let result;
  try {
    result = await guardedStream({
      input,
      layer,
      connection: body.connection,
      signal: env.signal,
      caps: output.caps,
      maxTokens: output.maxTokens,
      onUsage: (reported, call) => {
        // A count that left out the cached prompt is replaced by the estimate and teaches nothing (budget.wholePrompt).
        const { usage, trusted } = wholePrompt(reported, plan.estimated);
        addUsage(run.usage, usage, call);
        if (trusted) settle(run, usage);
        if (trusted) {
          learnRatio(body, plan.estimated, usage?.inputTokens);
          run.ratio = calibrate(run.ratio, plan.estimated, usage?.inputTokens);
        }
        learnOutput(body, thinks, usage?.outputTokens);
      },
      onPart: (part, delta) => {
        if (part === "reasoning") {
          reasoning += delta;
          env.view.reasoning(delta);
        } else {
          text += delta;
          const held = tools ? markupStart(text.slice(shown)) : -1;
          show(held < 0 ? text.length : shown + held);
        }
      },
    });
  } catch (error) {
    // A runtime that refuses tools, or calls the harness could not repair, moves this run to JSON.
    const message = error instanceof Error ? error.message : String(error);
    if (tools && run.native && !env.signal.aborted && (unsupportedTools(message) || brokenArguments(message))) return "unsupported";
    if (await refit(run, env, message)) return "retry";
    throw error;
  } finally {
    env.view.thoughtDone();
  }
  if (result.stopped) {
    // Thinking that looped is asked for again once, with thinking off for the rest of the run.
    if (result.stopped.part === "reasoning" && !run.thinkingOff) {
      run.thinkingOff = true;
      env.view.note(result.stopped, true);
      return "retry";
    }
    show(text.length);
    env.view.note(result.stopped, false);
    return { kind: "stopped", text };
  }
  // The runtime stopped at the window. Thinking that used it all is asked again without thinking; an answer
  // cut there goes on in the same answer once room is made.
  if (result.finishReason === "length" && !result.toolCalls.length) {
    if (!text.trim() && reasoning.trim() && !run.thinkingOff) {
      run.thinkingOff = true;
      env.view.note(new Stopped("reasoning", "limit"), true);
      return "retry";
    }
    show(text.length);
    const end = await continueAnswer({
      body,
      system,
      messages: run.history,
      answer: text,
      signal: env.signal,
      onText: (delta) => {
        text += delta;
        show(text.length);
      },
      // A continued answer's last call counts only the part it wrote, so the reply's own count is not known.
      onUsage: (usage, call) => {
        addUsage(run.usage, usage, call);
        run.usage.reply = undefined;
      },
      makeRoom: (answer) => roomToContinue(run, env, system, answer),
    });
    if (!end.stopped && !end.full) return { kind: "answered", text };
    env.view.note(end.stopped ?? new Stopped("text", "limit"), false);
    return { kind: "stopped", text };
  }
  // Calls the runtime left in the text are read back out of it, and their markup is never shown.
  const recovered = tools && !result.toolCalls.length ? recoverCalls(text, tools.map((tool) => tool.name)) : undefined;
  if (recovered?.calls.length) {
    text = recovered.text;
    result.toolCalls.push(...recovered.calls.map((call) => ({ id: `call-${crypto.randomUUID()}`, ...call })));
  } else show(text.length);
  if (!result.toolCalls.length) return { kind: "answered", text };
  const content: ContentPart[] = [
    ...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []),
    ...(text ? [{ type: "text" as const, text }] : []),
    ...result.toolCalls.map((call) => ToolCallPart.make({ id: call.id, name: call.name, input: call.input })),
  ];
  const step = Message.assistant(content);
  if (run.lastOutput !== undefined) measuredTokens.set(step, run.lastOutput);
  run.history.push(step);
  return { kind: "calls", calls: result.toolCalls, text };
}

/** Room to continue an answer of `answer` tokens: older results cleared, then the conversation summarized once. */
async function roomToContinue(run: Run, env: Env, system: string, answer: number) {
  const { budget } = await measure(env.body, system, run.history, false, 0, run.anchor);
  await makeRoom(run, env, budget, 0, answer);
  return run.history;
}

/**
 * A request the runtime said did not fit teaches the window it named; the run fits itself to it and sends the
 * same step again, once. A second refusal is reported.
 */
async function refit(run: Run, env: Env, message: string) {
  const named = windowFromError(message);
  if (!named || run.refitted || env.signal.aborted) return false;
  run.refitted = true;
  run.overflowed = true;
  run.anchor = undefined;
  // The runtime is asked again, so the window has one source (see recheckWindow).
  const fit = await recheckWindow(env.body, named);
  run.usage.window = fit.window;
  env.view.refit?.(fit);
  return true;
}

/** One turn for a model that writes its tool calls as JSON. Returns "answer" when it is ready to answer. */
async function jsonTurn(run: Run, env: Env, system: string, names: readonly ToolName[]): Promise<"answer" | "paused" | "ran"> {
  const { body } = env;
  run.lastOutput = undefined;
  const chosen = await thinkingCall({
    body,
    system,
    messages: run.history,
    schema: JSON_STEP,
    parse: (text) => parseJsonStep(text),
    signal: env.signal,
    onReasoning: env.view.reasoning,
    addUsage: (usage, call) => {
      addUsage(run.usage, usage as FinishUsage, call);
      // The JSON written back is the call, not the thinking before it, so the count over-states it a little.
      if (usage && !isEstimatedPrompt(usage as FinishUsage)) settle(run, usage as FinishUsage);
    },
  }).finally(() => env.view.thoughtDone());
  const step = chosen.value;
  if (!step || step.tool === "answer" || !names.includes(step.tool as ToolName)) {
    if (step && step.tool !== "answer") run.failures++;
    return step && step.tool !== "answer" && run.failures < FAILURES ? "ran" : "answer";
  }
  const call: StreamedToolCall = { id: `call-${crypto.randomUUID()}`, name: step.tool!, input: step.arguments ?? {} };
  const written = Message.assistant(JSON.stringify({ tool: call.name, arguments: call.input }));
  if (run.lastOutput !== undefined) measuredTokens.set(written, run.lastOutput);
  run.history.push(written);
  return (await runCalls(run, env, [call])) ? "ran" : "paused";
}

/** The answer for a model that called tools as JSON: one more call, in the same conversation, without a format. */
async function answerAfterJson(run: Run, env: Env): Promise<LoopEnd> {
  if (!env.view.text) {
    // A subagent's report is its last call's text; nothing streams to the reply.
    const end = await nativeTurn(run, env, `${run.system}\n\n${ANSWER_NOW}`, undefined, false, 0);
    return typeof end === "string" ? { kind: "answered", text: "" } : end.kind === "calls" ? { kind: "answered", text: end.text } : end;
  }
  const system = `${run.system}\n\n${ANSWER_NOW}`;
  await streamReply({
    body: env.body,
    system,
    messages: run.history,
    writer: env.writer,
    signal: env.signal,
    onUsage: (usage, call) => addUsage(run.usage, usage, call),
    makeRoom: (answer) => roomToContinue(run, env, system, answer),
  });
  return { kind: "answered", text: "" };
}

/** Loads a skill the agent chose. Its instructions come back once, as the call's result. */
async function loadSkill(run: Run, body: AgentRequest, name: string | undefined, room: number): Promise<Outcome> {
  const entry = findSkill(body.skillCatalog, name);
  if (!entry) return { text: `No installed skill is named "${name ?? ""}".`, failed: "Not installed" };
  if (run.skills.some((skill) => skill.name === entry.name)) return { text: `The ${entry.name} skill is already loaded above.` };
  if (run.skills.length >= MAX_SKILLS) return { text: "No more skills can be loaded for this request.", failed: "Skill limit reached" };
  try {
    const content = (await readSkill(entry.path)).content;
    const size = charsFor(room, run.ratio);
    const kept = content.length > size ? `${content.slice(0, size)}\n… the rest of this skill did not fit in the context.` : content;
    run.skills.push({ name: entry.name, content: kept });
    return { text: `Instructions of the ${entry.name} skill. Follow them for the rest of this request:\n${kept}` };
  } catch {
    return { text: `The ${entry.name} skill could not be read.`, failed: "Unavailable" };
  }
}

/** Runs `work` over the items, at most `width` at a time, and returns the results in the items' order. */
async function inTurns<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, lane));
  return results;
}

/** A subagent: the same loop in its own conversation, reporting back once. */
async function runSubagent(parent: Run, env: Env, agent: SubagentData, context: string, words: number, update: (agent: SubagentData) => void) {
  const abilities: Abilities = {
    files: env.abilities.files,
    web: env.abilities.web && parent.web === true,
    documents: env.abilities.documents,
    // A subagent cannot ask, so it runs commands only where nothing would ask.
    shell: env.abilities.shell && (env.body.approval !== "ask" || alwaysShell.has(parent.chatId)),
  };
  const system = [
    `You are ${agent.name}, a subagent working for Endurance on one bounded assignment.`,
    // The project's own rules hold for its subagents too; any cut was already reported by the main agent.
    fitInstructions(env.body.projectInstructions, env.body.contextWindow).text,
    abilities.files ? `${FILE_NOTES}\n\nProject folders:\n${context}` : "",
    abilities.web ? webNote() : "",
    HONESTY,
    `When the assignment is done, reply with your report: what you found or made, with sources or file paths, and anything missing or uncertain. Keep it within about ${words} words.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const own: Usage = { input: 0, output: 0, reasoning: 0, cached: 0 };
  const run: Run = {
    ...parent,
    usage: own,
    system,
    from: 0,
    history: [Message.user(`Assignment: ${agent.task}`)],
    labels: new Map(),
    seen: new Map(),
    written: [],
    subagents: [],
    skills: [],
    documents: parent.documents,
    decisions: new Map(),
    compactions: 0,
    conversationCompacted: true,
    failures: 0,
    turn: 0,
    native: parent.native,
    thinkingOff: parent.thinkingOff,
    cleared: 0,
  };
  agent.status = "running";
  agent.startedAt = Date.now();
  update(agent);
  const view: View = {
    reasoning: () => {
      if (agent.currentStep === "Thinking") return;
      agent.currentStep = "Thinking";
      update(agent);
    },
    thoughtDone: () => {},
    toolStart: (name, args) => {
      const label = wording(name, args);
      agent.currentStep = label.active;
      agent.logs = [...agent.logs, label.active];
      agent.toolCalls++;
      agent.progress = Math.min(90, Math.round((run.turn / MAX_SUBAGENT_TURNS) * 100));
      update(agent);
      return {
        done: (outcome) => {
          if (outcome.blocked) agent.logs = [...agent.logs, outcome.blocked];
          update(agent);
        },
      };
    },
    note: () => {},
  };
  try {
    // A subagent's calls wait behind the chats' own (see ./limit).
    const end = await runAs({ chat: currentCall()?.chat, kind: "subagent" }, () => drive(run, { ...env, abilities, coordinator: false, maxTurns: MAX_SUBAGENT_TURNS, view, compact: undefined, special: undefined, ask: undefined }));
    agent.result = (end.kind === "paused" ? "" : end.text).trim() || "Finished without a report.";
    agent.status = "done";
  } catch (error) {
    if (env.signal.aborted) throw error;
    agent.status = "error";
    agent.result = error instanceof Error ? error.message : "The subagent failed.";
  }
  agent.progress = 100;
  agent.currentStep = undefined;
  agent.finishedAt = Date.now();
  agent.tokens = own.input + own.output;
  update(agent);
  for (const key of ["input", "output", "reasoning", "cached"] as const) parent.usage[key] += own[key];
  parent.usage.calls = (parent.usage.calls ?? 0) + (own.calls ?? 0);
  // Its writing time joins the parent's with its tokens, so the turn's speed stays tokens over time.
  if (own.decodeMs) parent.usage.decodeMs = (parent.usage.decodeMs ?? 0) + own.decodeMs;
  return { agent, written: run.written };
}

export async function agentResponse(request: Request) {
  const raw = (await request.json()) as AgentRequest;
  validate(raw);
  toMessages(raw.messages, { vision: raw.visionSupported });
  const workspace = new Workspace(sanitizePolicy(raw.workspace));
  const abilities: Abilities = {
    files: !workspace.empty,
    web: Boolean(raw.webSearch),
    skills: Boolean(raw.skillCatalog?.length),
    changes: workspace.policy.folders.some((folder) => folder.access === "write"),
    shell: shellAvailable() && workspace.policy.folders.some((folder) => folder.access !== "none"),
  };
  const asked = requestText(raw.messages);
  const chatId = typeof raw.id === "string" ? raw.id : "";
  for (const [key, value] of paused) if (value.expires < Date.now()) paused.delete(key);
  const response = approvalResponse(raw.messages);
  const resumed = response ? paused.get(response.toolCallId) : undefined;
  if (response) paused.delete(response.toolCallId);
  if (response?.kind === "web_access" && response.always && response.approved) alwaysOnline.add(chatId);
  if (response?.kind === "run_shell" && response.always && response.approved) alwaysShell.add(chatId);
  let finishReason: FinishReason = "stop";

  const stream = createUIMessageStream<AppUIMessage>({
    originalMessages: raw.messages,
    onError: describeFailure,
    execute: ({ writer }) =>
      runAs({ chat: chatId, kind: "chat" }, async () => {
      const started = resumed?.run.started ?? Date.now();
      // A resumed run continues the assistant message that asked for approval.
      writer.write({ type: "start", messageMetadata: { model: raw.model, createdAt: started }, ...(response ? { messageId: response.messageId } : {}) });
      // An answer to a run this process no longer holds (the app restarted, or it waited past PAUSE_MS): starting
      // over would drop the decision, so the card says it expired and nothing it asked about runs.
      if (response && !resumed) {
        writer.write({ type: "tool-output-error", toolCallId: response.toolCallId, errorText: "Expired: the paused work was no longer kept, so nothing was run.", dynamic: true });
        writer.write({ type: "finish", finishReason: "other", messageMetadata: { model: raw.model, durationMs: Date.now() - started } });
        return;
      }
      // The window the runtime holds now, loading the model first when only loading tells it.
      const body = await withLiveWindow(
        raw,
        () => writer.write({ type: "data-status", data: { state: "loading" }, transient: true }),
        (window) => writer.write({ type: "data-window", data: { window }, transient: true }),
      );
      const perSkill = Math.floor(skillBudget(body.contextWindow) / MAX_SKILLS);
      const named = (Array.isArray(body.skills) ? body.skills.slice(0, MAX_SKILLS) : []).map((skill) => ({
        name: skill.name,
        content: skill.content.length > perSkill ? `${skill.content.slice(0, perSkill)}\n… the rest of this skill did not fit in the context.` : skill.content,
      }));
      let run: Run;
      let pending: StreamedToolCall[] = [];
      if (resumed) {
        run = resumed.run;
        pending = resumed.calls;
        const answer = response!;
        if (resumed.kind === "web_access") run.web = answer.approved;
        // A plan or command remembers the answer for the call that asked; that call runs next.
        else run.decisions.set(pending[0].id, { approved: answer.approved, always: answer.always, reason: answer.reason, toolCallId: answer.toolCallId });
        // A question's card shows the answer, or that it was skipped.
        if (resumed.kind === "user_question")
          writer.write({ type: "tool-output-available", toolCallId: answer.toolCallId, output: answer.approved ? { answer: answer.reason ?? "" } : { skipped: true }, dynamic: true });
        // An allowed command's card shows its output instead, once it runs.
        else if (!answer.approved) writer.write({ type: "tool-output-denied", toolCallId: answer.toolCallId });
        else if (resumed.kind !== "run_shell") writer.write({ type: "tool-output-available", toolCallId: answer.toolCallId, output: { allowed: true }, dynamic: true });
      } else {
        const cot: CotData = { agent: true, startedAt: started, steps: [] };
        for (const skill of named)
          cot.steps.push({ id: `skill-${skill.name}`, kind: "skill", label: `Using ${skill.name}`, doneLabel: `Used ${skill.name}`, status: "complete" });
        const context = abilities.files ? await workspace.outline(outlineChars(body.contextWindow)) : "";
        const instructions = fitInstructions(body.projectInstructions, body.contextWindow);
        if (instructions.cut) writer.write({ type: "data-instructions", data: instructions.cut });
        const opening = `${identity(body)} You are working${body.projectName ? ` in the project "${body.projectName}"` : ""} as Endurance's agent, with tools. Reply to the user in their language.`;
        const catalog = skillCatalog(body.skillCatalog, asked, body.contextWindow, "To follow one, call use_skill with its name.");
        // The notes come first: a small model attends least to what follows the long list.
        const folders = abilities.files ? `${FILE_NOTES}\n\nProject folders and access:\n${context}` : "";
        const web = abilities.web ? webNote() : "";
        const invoked = named.map((skill) => `The user invoked the ${skill.name} skill. Follow it:\n${skill.content}`);
        const imageGuide = imageNote(body);
        const system = [
          opening,
          // Right after the identity: the person's own rules, and the same text on every request, so it stays cached.
          instructions.text,
          // Before the long lists, where a small model still attends: whether it sees the chat's images.
          imageGuide,
          // Skills come before the project's folders, which are long; a small model attends least to what follows them.
          catalog,
          folders,
          web,
          ANSWER_NOTES,
          ...invoked,
        ]
          .filter(Boolean)
          .join("\n\n");
        // The same text, by part, for the context meter (./breakdown).
        const parts: SystemParts = { system: [opening, imageGuide, web, ANSWER_NOTES].filter(Boolean).join("\n\n"), instructions: instructions.text, skills: [catalog, ...invoked].join("\n\n"), project: folders };
        const usage: Usage = { input: 0, output: 0, reasoning: 0, cached: 0, ...(body.contextWindow ? { window: body.contextWindow } : {}) };
        const native = await nativeTools(body);
        const thinks = !thinkingOff(body) && Boolean(body.reasoningSupported);
        // Attached documents become their text, taken out once and kept (./attachments).
        body.messages = await readAttachments(body.messages, {
          signal: request.signal,
          reader: body.reader,
          onProgress: (progress) => writer.write({ type: "data-status", data: { state: "reading", ...progress }, transient: true }),
        });
        const plan = await measure(body, system, [], thinks);
        // Text too long to send whole is read as a document before anything is summarized, so a summary never
        // has to take in a whole long paste.
        const { messages: readable, documents } = documentize(body.messages, plan.budget);
        abilities.documents = documents.length > 0;
        for (const document of documents) {
          const label = `Opened ${document.name.replace(/^The /, "the ")} as a document`;
          cot.steps.push({ id: `document-${document.id}`, kind: "read", label, doneLabel: label, status: "complete", note: `${document.pieces.length} pieces` });
        }
        const ratio = (await modelProfile(body)).ratio;
        const compacted = await compactHistory({
          messages: readable,
          contextWindow: body.contextWindow,
          system: estimateText(system) + estimateText(JSON.stringify(definitions(toolsFor(abilities, true)))),
          reserve: plan.budget.reserve,
          model: modelFor(body),
          layer,
          signal: request.signal,
          writer,
          thinking: await thinkingRequest(body, thinks),
          thinks,
          ratio,
          connection: body.connection,
          tune: (maxTokens) => tuned(body, thinks, { maxTokens }),
          onUsage: (reported, call) => addSideUsage(usage, reported, call),
        });
        // A summary comes with the current state of what it covered, read now rather than remembered.
        const earlier = earlierState(body.messages);
        const restored = compacted.summary ? await stateNote({ ...earlier, read: readerOf(workspace), contextWindow: body.contextWindow, ratio }) : "";
        const summary = compacted.summary ? summaryMessage([compacted.summary, restored].filter(Boolean).join("\n\n")) : undefined;
        const conversation = [...(summary ? [summary] : []), ...toMessages(compacted.rest, { vision: body.visionSupported })];
        carryCounts(conversation, body.messages);
        run = {
          chatId,
          started,
          usage,
          cot,
          system,
          parts,
          summary,
          from: conversation.length,
          history: [...conversation],
          labels: new Map(),
          seen: new Map(),
          written: [],
          sources: [],
          subagents: [],
          skills: named,
          documents,
          // What earlier requests taught about the runtime's token counts, so the first call already fits.
          ratio,
          // Approve for me and Full access treat turning Internet Access on as consent.
          web: !abilities.web ? false : body.approval === "ask" && !alwaysOnline.has(chatId) ? undefined : true,
          compactions: 0,
          conversationCompacted: Boolean(compacted.data),
          failures: 0,
          turn: 0,
          native,
          thinkingOff: false,
          cleared: 0,
          decisions: new Map(),
        };
      }
      abilities.documents = run.documents.length > 0;
      const { cot, usage } = run;
      // Every change goes out as a full snapshot under one ID; the renderer words it from the phase and step times.
      const publish = () => writer.write({ type: "data-cot", id: "agent-cot", data: { ...cot, steps: cot.steps.map((step) => ({ ...step })) } });
      const enter = (phase: CotPhase) => {
        if (cot.phase === phase) return;
        cot.phase = phase;
        publish();
      };
      const complete = (trace: CotStep) => {
        trace.status = "complete";
        trace.finishedAt = Date.now();
        publish();
      };
      // Reasoning becomes its own row per call. Deltas arrive per token, so snapshots are throttled.
      let thought: CotStep | undefined;
      let lastPublish = 0;
      // The reply text streams as parts; a new part after each tool call keeps the order readable.
      let textPart: string | undefined;
      const closeText = () => {
        if (textPart) writer.write({ type: "text-end", id: textPart });
        textPart = undefined;
      };
      const view: View = {
        text: (delta) => {
          if (!textPart) {
            textPart = `text-${crypto.randomUUID()}`;
            writer.write({ type: "text-start", id: textPart });
          }
          writer.write({ type: "text-delta", id: textPart, delta });
        },
        reasoning: (delta) => {
          if (!thought) {
            thought = { id: `step-${cot.steps.length}`, kind: "reasoning", label: "Thinking", doneLabel: "Thought", status: "active", startedAt: Date.now(), reasoning: "" };
            cot.steps.push(thought);
            enter("deciding");
          }
          const next = `${thought.reasoning ?? ""}${delta}`;
          thought.reasoning = next.length > MAX_REASONING ? next.slice(0, MAX_REASONING) : next;
          if (Date.now() - lastPublish < 150) return;
          lastPublish = Date.now();
          publish();
        },
        thoughtDone: () => {
          if (!thought) return;
          thought.reasoning = thought.reasoning?.trim();
          complete(thought);
          thought = undefined;
        },
        card: (toolCallId, label) => {
          closeText();
          const at = Date.now();
          cot.steps.push({ id: `step-${cot.steps.length}`, kind: "verify", label, doneLabel: label, status: "complete", startedAt: at, finishedAt: at, card: toolCallId });
          cot.phase = "acting";
          publish();
        },
        toolStart: (name, args) => {
          closeText();
          const words = wording(name, args);
          const trace: CotStep = { id: `step-${cot.steps.length}`, kind: kindOf(name), label: words.active, doneLabel: words.done, status: "active", startedAt: Date.now() };
          cot.steps.push(trace);
          cot.phase = "acting";
          publish();
          return {
            done: (outcome) => {
              if (outcome.files?.length) trace.files = outcome.files.map((file) => file.split("/").at(-1) ?? file);
              if (outcome.blocked) {
                trace.kind = "blocked";
                trace.doneLabel = words.failed;
                trace.note = outcome.level === "read" ? "Read only" : outcome.level === "none" ? "No access" : outcome.level === "secret" ? "Secret file" : outcome.blocked;
              } else if (outcome.failed) {
                trace.doneLabel = words.failed;
                trace.failed = true;
                trace.note = outcome.failed;
              }
              complete(trace);
            },
          };
        },
        note: (stopped, retried) => {
          writer.write({ type: "data-loop", data: { part: stopped.part, reason: stopped.reason, ...(retried ? { retried } : {}) } });
        },
        room: (count) => {
          const note = `Cleared ${count} earlier result${count === 1 ? "" : "s"}`;
          const row = cot.steps.find((item) => item.id === "room");
          if (row) row.note = note;
          else cot.steps.push({ id: "room", kind: "think", label: "Making room in the context window", doneLabel: "Made room in the context window", status: "complete", startedAt: Date.now(), finishedAt: Date.now(), note });
          publish();
        },
        refit: (fit) => {
          closeText();
          writer.write({ type: "data-fit", data: fit });
        },
        blocked: (label, note) => {
          cot.steps.push({ id: `step-${cot.steps.length}`, kind: "blocked", label, doneLabel: label, status: "complete", note });
          publish();
        },
      };
      const env: Env = {
        body,
        workspace,
        // The to-do list as the model keeps it, for what a summary puts back.
        writer: {
          ...writer,
          write: (part) => {
            if (part.type === "data-todos") run.todos = part.data.items;
            writer.write(part);
          },
        },
        signal: request.signal,
        abilities,
        coordinator: true,
        maxTurns: MAX_TURNS,
        view,
        compact: async (run, budget) => {
          // A summary made for this answer counts in what the answer took; the window stays the answer's own.
          const thinks = !run.thinkingOff && !thinkingOff(body) && Boolean(body.reasoningSupported);
          const call = {
            model: modelFor(body),
            layer,
            signal: request.signal,
            thinking: await thinkingRequest(body, thinks, run.thinkingOff),
            thinks,
            ratio: run.ratio,
            connection: body.connection,
            tune: (maxTokens?: number) => tuned(body, thinks, { maxTokens }),
            onUsage: (reported: Parameters<typeof addSideUsage>[1], info: Parameters<typeof addSideUsage>[2]) => addSideUsage(run.usage, reported, info),
          };
          const earlier = earlierState(body.messages);
          const state = () =>
            stateNote({
              changed: [...earlier.changed, ...run.written],
              plan: run.plan ?? earlier.plan,
              todos: run.todos ?? earlier.todos,
              read: readerOf(workspace),
              contextWindow: body.contextWindow,
              ratio: run.ratio,
            });
          // The conversation before this request is the oldest part, so it goes first, once.
          if (!run.conversationCompacted) {
            run.conversationCompacted = true;
            const result = await compactHistory({ ...call, messages: body.messages, contextWindow: body.contextWindow, system: estimateText(run.system), reserve: budget.reserve, writer, force: true });
            if (result.data) {
              const conversation = [summaryMessage([result.summary!, await state()].filter(Boolean).join("\n\n")), ...toMessages(result.rest, { vision: body.visionSupported })];
              carryCounts(conversation, body.messages);
              run.history = [...conversation, ...run.history.slice(run.from)];
              run.from = conversation.length;
              return true;
            }
          }
          // Then the run's own steps, as Codex keeps only the user's messages.
          const history = await compactSteps({ ...call, history: run.history, from: run.from, contextWindow: body.contextWindow, reserve: budget.reserve, written: run.written, state: await state() });
          if (!history) return false;
          run.history = history;
          const label = "Summarized earlier steps to make room";
          cot.steps.push({ id: `step-${cot.steps.length}`, kind: "think", label, doneLabel: label, status: "complete", startedAt: Date.now(), finishedAt: Date.now() });
          publish();
          return true;
        },
        special: async (call, name, args, room) => {
          if (name === "use_skill") return loadSkill(run, body, args.skill, room);
          if (name === "propose_plan") {
            const decision = run.decisions.get(call.id);
            // An approved plan and its steps as the to-do list are what a later summary puts back.
            if (decision?.approved) {
              const plan = planOf(args);
              run.plan = planText(plan);
              if (plan.steps.length >= LEAST_TODOS) run.todos = plan.steps.map((step) => ({ title: step.title, status: "pending" }));
            }
            return planOutcome(writer, decision, args);
          }
          if (name === "ask_user") return questionOutcome(run.decisions.get(call.id));
          const assignments = (args.assignments ?? []).filter((item) => item.task?.trim()).slice(0, MAX_SUBAGENTS);
          if (run.subagents.length >= MAX_SUBAGENTS) return { text: "Not run: the subagent limit for this request is reached.", failed: "Subagent limit reached" };
          const created = assignments.map((item, index): SubagentData => ({
            id: `subagent-${run.subagents.length + index + 1}`,
            // Models often name subagents like identifiers; show them as words.
            name: (item.name || `Subagent ${run.subagents.length + index + 1}`).replace(/[_-]+/g, " ").trim().slice(0, 40),
            role: "subagent",
            task: [item.task!.trim(), item.paths?.length ? `Paths: ${item.paths.join(", ")}` : ""].filter(Boolean).join("\n"),
            model: body.model,
            status: "queued",
            progress: 0,
            logs: [],
            tokens: 0,
            toolCalls: 0,
          }));
          run.subagents.push(...created);
          const show = (agent: SubagentData) => writer.write({ type: "data-subagent", id: agent.id, data: { ...agent, logs: [...agent.logs] } });
          created.forEach(show);
          const context = abilities.files ? await workspace.outline(outlineChars(body.contextWindow)) : "";
          // The reports come back together as this call's result, so each gets an equal share of its room.
          const words = Math.max(60, Math.floor((room / Math.max(1, created.length)) * 0.6));
          // A model that serves one request at a time runs them one after another, each to its end, so the runtime
          // keeps that conversation cached; one that serves more runs as many at once (see limit.concurrency). One
          // subagent waits beside nothing, so it needs no measuring.
          const width = created.length > 1 ? await concurrency({ connection: body.connection, runtime: body.runtime, model: body.runtimeModelId }) : 1;
          const results = await inTurns(created, width, (agent) => runSubagent(run, env, agent, context, words, show));
          for (const result of results) run.written.push(...result.written);
          return { text: results.map(({ agent, written }) => `${agent.name} (${agent.status}): ${agent.result}${written.length ? `\nFiles written: ${written.join(", ")}` : ""}`).join("\n\n") };
        },
        ask: (calls, request) => {
          // Ask, then end this reply; the answer resumes the run from this call.
          const call = calls[0];
          const args = argsOf(call.input);
          const kind = request?.kind ?? "web_access";
          const toolCallId = `${kind}-${crypto.randomUUID()}`;
          const purpose = call.name === "delegate" ? "Let subagents search and read the web" : isTool(call.name) ? wording(call.name, args).active : call.name;
          closeText();
          writer.write({ type: "tool-input-available", toolCallId, toolName: kind, input: request?.input ?? { purpose, query: args.query, url: args.url }, dynamic: true });
          // A command that asks shows its card where it is in the trace; the same card later shows its output.
          if (kind === "run_shell") view.card?.(toolCallId, wording("run_shell", args).done);
          // After the card, which marks the trace as acting: the pause has to be the last phase sent, or the
          // paused trace reads as stopped, folds, and unfolds with its finished thoughts closed.
          enter("waiting");
          writer.write({ type: "tool-approval-request", approvalId: `approval-${crypto.randomUUID()}`, toolCallId });
          paused.set(toolCallId, { run, calls, kind, expires: Date.now() + PAUSE_MS });
          return true;
        },
      };

      let end: Awaited<ReturnType<typeof drive>>;
      try {
        end = await drive(run, env, pending);
      } catch (error) {
        // The runtime could not take an image before any tool ran: the newest message goes once more with notes in
        // its images' place (./chat imageRejected).
        const last = body.messages.findLast((message) => message.role === "user");
        const at = last ? run.history.findIndex((message) => message.id === last.id) : -1;
        if (request.signal.aborted || resumed || run.seen.size > 0 || at < 0 || !imageRejected(error, body.messages)) throw error;
        run.history[at] = toMessages(withoutNewImages([last!]), { vision: body.visionSupported })[0];
        writer.write({ type: "data-toast", data: { message: IMAGES_LEFT_OUT }, transient: true });
        end = await drive(run, env, pending);
      }
      closeText();
      if (end.kind === "paused") {
        writer.write({ type: "finish", finishReason: "tool-calls", messageMetadata: { model: body.model, durationMs: Date.now() - started, usage } });
        return;
      }
      if (end.kind === "stopped") finishReason = "other";
      cot.finishedAt = Date.now();
      cot.phase = "answering";
      if (cot.steps.length) publish();
      // What the latest main call's prompt held, part by part, with the tools it was offered.
      const tools = estimateText(JSON.stringify(definitions(toolsFor(abilities, true), (body.skillCatalog ?? []).map((skill) => skill.name))));
      const breakdown = run.parts ? breakdownOf(run.parts, tools, run.history, run.from, run.summary, end.text) : undefined;
      writer.write({ type: "finish", finishReason, messageMetadata: { model: body.model, durationMs: Date.now() - started, usage, ...(breakdown ? { breakdown } : {}) } });
    }),
  });
  return createUIMessageStreamResponse({ stream });
}

export const usesAgent = (body: Partial<AgentRequest>) =>
  Boolean(
    body.runtime &&
      (body.webSearch ||
      (body.workspace?.folders?.length ?? 0) > 0 ||
      (body.skills?.length ?? 0) > 0 ||
      hasAttachments(body.messages ?? []) ||
      hasLarge(body.messages ?? [], budgetFor(body.contextWindow, undefined, false)))
  );
