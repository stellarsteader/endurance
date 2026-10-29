import type { UIMessage } from "ai";

/** "none" turns thinking off, for models that can. */
export type Effort = "none" | "low" | "medium" | "high" | "xhigh";
export type Approval = "ask" | "auto" | "full";
export const EFFORTS: readonly Effort[] = ["none", "low", "medium", "high", "xhigh"];
export const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort);

/**
 * What a chat keeps for itself. The model it runs on, once chosen for it; until then it follows the model of its
 * replies, else the one last chosen. The effort only when the person chose one in this chat, for this model;
 * otherwise the model's thinking default from Models settings applies. The approval mode it was given when its first
 * message went out, or the one the person chose in it since.
 */
export interface ChatChoice {
  model?: string;
  effort?: Effort;
  approval?: Approval;
  /** The agent proposes a plan and waits for approval before it changes anything (harness/agent planGate). */
  planFirst?: boolean;
}

export const APPROVAL_MODES: readonly Approval[] = ["ask", "auto", "full"];
export const isApproval = (value: unknown): value is Approval => APPROVAL_MODES.includes(value as Approval);

export interface ChatSettings {
  model: string;
  effort: Effort;
  /** The approval mode a new chat starts with (Settings → Permissions); each chat then keeps its own. */
  defaultApproval: Approval;
  webSearch: boolean;
}

export interface Usage {
  /** Totals across every model call in the turn, subagents included. */
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  /** Prompt plus visible reply of the turn's latest main call: what now occupies the context window. */
  context?: number;
  /** Model calls the turn made. */
  calls?: number;
  /**
   * The prompt the runtime counted for the turn's first answering call: the system prompt and the conversation up to
   * the message answered. Later turns take each message's tokens from how this grew (lib/message-tokens). Unset when
   * that count was the harness's estimate.
   */
  first?: number;
  /**
   * The visible reply of the turn's latest main call, as the runtime counted it. Unset when that count cannot be
   * told apart from thinking: a runtime that reports no thinking count (Ollama) folds thinking into its output.
   */
  reply?: number;
  /** Time the turn's calls spent writing, from each call's first piece to its finish: the base of generation speed. */
  decodeMs?: number;
  /** Context window the turn ran with. */
  window?: number;
  /**
   * Output the next request on this model keeps free, as the harness planned it when the turn ended (harness/budget):
   * older turns are summarized once a request passes `window − reserve`.
   */
  reserve?: number;
  /** The prompt count is the harness's estimate: the runtime's own count left out its cached part (harness/budget). */
  estimated?: boolean;
}

/** The parts of a request's prompt, as the context meter names them. */
export type ContextSection = "system" | "instructions" | "skills" | "project" | "tools" | "attachments" | "conversation" | "toolResults" | "summary" | "reply";

export interface ChatMeta {
  model?: string;
  createdAt?: number;
  durationMs?: number;
  usage?: Usage;
  /** How the reply ended when it did not finish (lib/interrupted); the renderer writes it on Stop or an error. */
  interrupted?: "stopped" | "error";
  /** On a user message: a line for the model sent with it and not shown, such as what an interrupted reply left unknown. */
  note?: string;
  /** Estimated tokens of each part of the latest main call's prompt, by the same estimator as the budget. */
  breakdown?: Partial<Record<ContextSection, number>>;
}

export type StepStatus = "pending" | "active" | "complete";

export type CotKind =
  | "search"
  | "read"
  | "think"
  | "verify"
  | "list"
  | "write"
  | "skill"
  | "delegate"
  | "blocked"
  | "web"
  | "page"
  /** The local agent's reasoning while it chose its next step. */
  | "reasoning";

/** What the local agent is doing between steps. */
export type CotPhase = "deciding" | "acting" | "checking" | "waiting" | "answering";

export interface CotStep {
  id: string;
  kind: CotKind;
  /** Shown while the step runs, such as "Reading notes.md". */
  label: string;
  /** Shown once it is complete, such as "Read notes.md" or "Couldn't read notes.md". Falls back to label. */
  doneLabel?: string;
  status: StepStatus;
  startedAt?: number;
  finishedAt?: number;
  results?: string[];
  files?: string[];
  /** Why a step was blocked or failed, such as "No access". */
  note?: string;
  /** The whole message when the note is only its start, opened from the note. */
  detail?: string;
  /** The step ran but did not work, such as a file that does not exist. Not counted as done work. */
  failed?: boolean;
  /** For a reasoning row: what the model thought, streamed while it chose the next step. */
  reasoning?: string;
  /**
   * The tool call whose own card (a command with its approval and output) is shown at this step, so the trace reads in
   * the order things happened. The card is drawn here instead of after the trace.
   */
  card?: string;
}

export interface CotData {
  /** Set by the local agent harness. */
  agent?: boolean;
  phase?: CotPhase;
  startedAt?: number;
  /** Set when the work is done, before the answer streams. A trace without it ended early or is paused. */
  finishedAt?: number;
  steps: CotStep[];
}

export type SubagentStatus = "queued" | "running" | "done" | "error";

export interface SubagentData {
  id: string;
  name: string;
  role: string;
  task: string;
  model: string;
  status: SubagentStatus;
  progress: number;
  currentStep?: string;
  logs: string[];
  tokens: number;
  toolCalls: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
}

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodosData {
  items: TodoItem[];
}

export interface PlanData {
  title: string;
  description: string;
  steps: { title: string; detail: string }[];
  streaming: boolean;
}

export interface CommitData {
  hash: string;
  message: string;
  branch: string;
  files: {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    additions: number;
    deletions: number;
  }[];
}

export interface CompactionData {
  summary: string;
  /** Messages replaced by the summary. */
  compacted: number;
  /** Estimated request tokens before and after, against the model's context window. */
  before: number;
  after: number;
  limit: number;
  /** ID of the last message the summary covers. */
  upTo: string;
  /** What a /compact took. A summary made during a reply counts in that reply's usage instead. */
  usage?: Usage;
}

export type DataTypes = {
  cot: CotData;
  compaction: CompactionData;
  subagent: SubagentData;
  todos: TodosData;
  plan: PlanData;
  commit: CommitData;
  suggestions: { items: string[] };
  toast: { message: string; tone?: "info" | "success" };
  loop: LoopData;
  /** Sent while the reply waits, never stored: the model is being loaded first, or an attached document is being read. */
  status: { state: "loading" } | { state: "reading"; file: string; done: number; total: number };
  /**
   * The runtime named a smaller window than expected; the request was fitted to it and sent again. `runtime` is
   * set when the runtime, asked again, still reports a larger window than the one it refused at.
   */
  fit: { window: number; runtime?: number };
  /** Sent, never stored, when the runtime holds a different window than the app knew (a model it just loaded). */
  window: { window: number };
  /** The project's instructions did not fit their share of the window and were cut: characters sent and written. */
  instructions: { kept: number; total: number };
};

/**
 * Output the harness stopped: thinking or a reply that kept repeating itself, thinking that used its share of
 * the window, or a reply that filled the window and could not be continued in place.
 */
export interface LoopData {
  /** What was stopped: the model's thinking or its reply. */
  part: "reasoning" | "text";
  /** Why: it kept repeating itself, or it reached the window (its cap, in notes saved earlier). Older notes have none. */
  reason?: "loop" | "limit";
  /** The reply was asked for again without thinking. */
  retried?: boolean;
}

export type AppUIMessage = UIMessage<ChatMeta, DataTypes>;

export interface EditFileOutput {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  created?: boolean;
  /**
   * For undoing (lib/file-undo): the file before this change, kept encrypted as `attachment:<id>`, or null when the
   * change created it. Left out when no copy was kept, as in chats from before copies were kept.
   */
  before?: string | null;
  /** SHA-256 of the file before this change; left out when it did not exist. */
  beforeHash?: string;
  /** SHA-256 of what the agent wrote (lib/file-undo ABSENT when it deleted the file); left out in chats from before copies were kept. */
  after?: string;
  /** The agent deleted the file. */
  deleted?: boolean;
}

export interface ShellOutput {
  command: string;
  stdout: string;
  /** Null when the command was stopped; undefined while it runs. */
  exitCode?: number | null;
  /** The output so far, while the command still runs. */
  running?: boolean;
  /** Stopped at the time limit. */
  timedOut?: boolean;
}

export interface TestRunOutput {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  suites: {
    name: string;
    tests: { name: string; status: "passed" | "failed" | "skipped"; durationMs: number }[];
  }[];
}
