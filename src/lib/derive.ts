import type {
  AppUIMessage,
  CommitData,
  EditFileOutput,
  PlanData,
  ShellOutput,
  SubagentData,
  TestRunOutput,
  TodosData,
  Usage,
} from "./types";
import { combineChanges, type FileChanges } from "./combined-diff";

type Part = AppUIMessage["parts"][number];

export type ToolPartLike = Extract<Part, { toolCallId: string }>;

export const isToolPart = (part: Part): part is ToolPartLike =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool";

export const toolNameOf = (part: ToolPartLike) =>
  part.type === "dynamic-tool" ? (part as { toolName: string }).toolName : part.type.slice(5);

export interface WorkspaceData {
  subagents: SubagentData[];
  todos?: TodosData;
  plan?: PlanData;
  commit?: CommitData;
  /** Each file the agent changed, all its changes in this chat as one diff. */
  edits: FileChanges[];
  shell: { command: string; stdout?: string; exitCode?: number | null; running: boolean; denied?: boolean }[];
  tests?: TestRunOutput;
  sources: { url: string; title?: string }[];
  usage?: Usage;
  model?: string;
}

export function deriveWorkspace(messages: AppUIMessage[]): WorkspaceData {
  const subagents = new Map<string, SubagentData>();
  const edits = new Map<string, EditFileOutput[]>();
  const shell: WorkspaceData["shell"] = [];
  const sources = new Map<string, { url: string; title?: string }>();
  const data: WorkspaceData = { subagents: [], edits: [], shell, sources: [] };

  for (const message of messages) {
    if (message.role === "assistant" && message.metadata?.usage) {
      data.usage = message.metadata.usage;
      data.model = message.metadata.model;
    }
    for (const part of message.parts) {
      switch (part.type) {
        case "data-subagent":
          subagents.set(part.data.id, part.data);
          break;
        case "data-todos":
          data.todos = part.data;
          break;
        case "data-plan":
          data.plan = part.data;
          break;
        case "data-commit":
          data.commit = part.data;
          break;
        case "source-url":
          sources.set(part.url, { url: part.url, title: part.title });
          break;
        default:
          if (!isToolPart(part)) break;
          {
            const name = toolNameOf(part);
            if (name === "plan_approval") {
              const plan = part.input as { title?: string; summary?: string; steps?: { title: string; detail: string }[] } | undefined;
              data.plan = { title: plan?.title ?? "Plan", description: plan?.summary ?? "", steps: plan?.steps ?? [], streaming: false };
            }
            if (name === "edit_file" && part.state === "output-available") {
              const out = part.output as EditFileOutput;
              edits.set(out.path, [...(edits.get(out.path) ?? []), out]);
            }
            if (name === "run_shell") {
              const input = part.input as { command?: string } | undefined;
              const out = part.state === "output-available" ? (part.output as ShellOutput) : undefined;
              shell.push({
                command: input?.command ?? "",
                stdout: out?.stdout,
                exitCode: out?.exitCode,
                running: part.state === "input-available" || part.state === "approval-responded" || Boolean(out?.running),
                denied: part.state === "output-denied",
              });
            }
            if (name === "run_tests") {
              if (part.state === "output-available") data.tests = part.output as TestRunOutput;
              shell.push({
                command: "pnpm vitest run",
                stdout:
                  part.state === "output-available"
                    ? formatTests(part.output as TestRunOutput)
                    : undefined,
                exitCode: part.state === "output-available" ? 0 : undefined,
                running: part.state === "input-available",
              });
            }
          }
      }
    }
  }

  data.subagents = [...subagents.values()];
  data.edits = [...edits.values()].map(combineChanges);
  data.sources = [...sources.values()];
  return data;
}

function formatTests(out: TestRunOutput) {
  const lines: string[] = [];
  for (const suite of out.suites) {
    lines.push(`\n ${suite.name}`);
    for (const t of suite.tests) {
      const mark = t.status === "passed" ? "\x1b[32m✓\x1b[0m" : t.status === "failed" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m↓\x1b[0m";
      lines.push(`   ${mark} ${t.name} \x1b[2m${t.durationMs}ms\x1b[0m`);
    }
  }
  lines.push(
    `\n Tests  \x1b[32m${out.passed} passed\x1b[0m | \x1b[33m${out.skipped} skipped\x1b[0m (${out.passed + out.failed + out.skipped})`
  );
  lines.push(` Duration  ${(out.durationMs / 1000).toFixed(2)}s`);
  return lines.join("\n");
}

/** The agent's changes to files in these messages, oldest first. */
export const agentEdits = (messages: AppUIMessage[]) =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      isToolPart(part) && toolNameOf(part) === "edit_file" && part.state === "output-available" ? [part.output as EditFileOutput] : []
    )
  );

export const hasPendingApproval = (messages: AppUIMessage[]) => {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  return last.parts.some(
    (p) => isToolPart(p) && (p.state === "approval-requested" || p.state === "approval-responded")
  );
};

export const messageText = (message: AppUIMessage) =>
  message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
