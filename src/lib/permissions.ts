/**
 * Always allow rules and the answers given on command and web access cards.
 * - A rule lets a command key (lib/command-key) or going online run without asking. Always allow on a card in a
 *   project's chat adds a rule to the project (Project.alwaysAllowed), which holds for every chat in the project from
 *   the next request on, until it is removed in Project settings. A chat in no project, such as a side chat, keeps
 *   its rules to itself: they are its own Always allow answers, read back from its cards.
 * - Every request sends the rules that apply (allowedBy), so they hold after a restart; the harness asks for anything
 *   else (harness/agent `allowed`).
 * - Every answer is stored on its card (the approval: reason "always" for Always allow, "User denied" for Deny), so
 *   the chat's messages are the history of decisions (decisionsIn).
 * Pure, shared by the renderer (the request body, Project settings) and the history store (cleanRules).
 */
import { commandKeys } from "./command-key";
import type { AppUIMessage } from "./types";

/** How a card was answered: Run once (or Allow), Always allow, Deny, or passed over by sending a new message. */
export type Outcome = "once" | "always" | "denied" | "skipped";

/** One answered card. `at` is when the reply that asked started; a card keeps no time of its own. */
export interface Decision {
  /** The card's tool call ID, unique in the chat. */
  id: string;
  kind: "command" | "web";
  /** The whole command, for a command card. */
  command?: string;
  /** The folder the command ran in, as the card named it. */
  cwd?: string;
  /** Why the agent wanted to go online, for a web access card. */
  purpose?: string;
  outcome: Outcome;
  at?: number;
}

/** What runs without asking: a command key, or going online. Given on `command` in chat `chatId` at `at`. */
export type AllowRule =
  | { kind: "command"; key: string; command: string; at: number; chatId?: string }
  | { kind: "web"; at: number; chatId?: string };

/** Rules a project keeps; past this the oldest go first. */
export const MAX_RULES = 500;
const MAX_COMMAND = 4000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

type Part = AppUIMessage["parts"][number];
const KINDS: Record<string, Decision["kind"]> = { run_shell: "command", web_access: "web" };

function decisionOf(part: Part, at: number | undefined): Decision | undefined {
  if (part.type !== "dynamic-tool" || !(part.toolName in KINDS)) return undefined;
  const approval = "approval" in part ? part.approval : undefined;
  if (!approval || approval.approved === undefined) return undefined;
  // A card left waiting when the person sent a new message is closed without a reason (lib/interrupted).
  const outcome: Outcome = approval.approved ? (approval.reason === "always" ? "always" : "once") : approval.reason ? "denied" : "skipped";
  const input = (part.input ?? {}) as { command?: unknown; cwd?: unknown; purpose?: unknown };
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    id: part.toolCallId,
    kind: KINDS[part.toolName],
    ...(text(input.command) ? { command: text(input.command) } : {}),
    ...(text(input.cwd) ? { cwd: text(input.cwd) } : {}),
    ...(text(input.purpose) ? { purpose: text(input.purpose) } : {}),
    outcome,
    ...(at ? { at } : {}),
  };
}

/** Every answered command and web access card in the messages, oldest first. */
export function decisionsIn(messages: readonly AppUIMessage[]): Decision[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.parts.flatMap((part) => decisionOf(part, message.metadata?.createdAt) ?? []) : []
  );
}

/** The rules Always allow answers give: each key the card's button named, so the command it allowed runs. */
function rulesOf(decisions: Decision[], chatId: string | undefined, at?: number): AllowRule[] {
  return decisions.flatMap((decision): AllowRule[] => {
    if (decision.outcome !== "always") return [];
    const when = at ?? decision.at ?? 0;
    const chat = chatId ? { chatId } : {};
    if (decision.kind === "web") return [{ kind: "web", at: when, ...chat }];
    const command = decision.command ?? "";
    return commandKeys(command).map((key) => ({ kind: "command", key, command, at: when, ...chat }));
  });
}

/** A chat's own rules, for a chat in no project: its Always allow answers, one per key. */
export const chatRules = (messages: readonly AppUIMessage[], chatId?: string) => withRules([], rulesOf(decisionsIn(messages), chatId));

/**
 * The Always allow answers the request now being sent carries: cards of the last reply answered and not yet sent,
 * as the harness reads them (harness/agent approvalResponse). Timed now, which is when the person answered.
 */
export function answeredNow(messages: readonly AppUIMessage[], chatId: string, now = Date.now()): AllowRule[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [];
  const answered = last.parts.filter((part) => part.type === "dynamic-tool" && part.state === "approval-responded");
  return rulesOf(answered.flatMap((part) => decisionOf(part, undefined) ?? []), chatId, now);
}

const sameRule = (a: AllowRule, b: AllowRule) => a.kind === b.kind && (a.kind === "web" || a.key === (b as typeof a).key);

/** The rules with `added` that are new: a rule already there keeps when and where it was first given. */
export function withRules(rules: readonly AllowRule[], added: readonly AllowRule[]): AllowRule[] {
  const next = [...rules];
  for (const rule of added) if (!next.some((known) => sameRule(known, rule))) next.push(rule);
  return next.slice(-MAX_RULES);
}

export const withoutRules = (rules: readonly AllowRule[], removed: readonly AllowRule[]) => rules.filter((rule) => !removed.some((item) => sameRule(item, rule)));

/** What a request says runs without asking (harness/agent `allowed`). */
export const allowedBy = (rules: readonly AllowRule[]) => ({
  commands: [...new Set(rules.flatMap((rule) => (rule.kind === "command" ? [rule.key] : [])))],
  web: rules.some((rule) => rule.kind === "web"),
});

/** A project's rules as stored: well-formed ones only, at most MAX_RULES, or nothing. */
export function cleanRules(value: unknown): AllowRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules = value.flatMap((item): AllowRule[] => {
    if (!item || typeof item !== "object") return [];
    const { kind, key, command, at, chatId } = item as Record<string, unknown>;
    const when = typeof at === "number" && Number.isFinite(at) && at > 0 ? Math.round(at) : 0;
    const chat = typeof chatId === "string" && ID.test(chatId) ? { chatId } : {};
    if (kind === "web") return [{ kind, at: when, ...chat }];
    if (kind !== "command" || typeof key !== "string" || !key || key.length > 300) return [];
    return [{ kind, key, command: typeof command === "string" ? command.slice(0, MAX_COMMAND) : key, at: when, ...chat }];
  });
  const kept = withRules([], rules);
  return kept.length ? kept : undefined;
}
