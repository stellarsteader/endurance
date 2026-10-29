"use client";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { deriveWorkspace } from "@/lib/derive";
import { getModel } from "@/lib/models";
import { formatElapsed } from "@/lib/trace";
import type { SubagentData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CheckCircle2Icon, ChevronLeftIcon, ChevronRightIcon, CircleDashedIcon, CircleXIcon, LoaderCircleIcon, WrenchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "./session-context";

export function useNow(active: boolean, interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [active, interval]);
  return now;
}

export function SubagentStatusIcon({ status, className }: { status: SubagentData["status"]; className?: string }) {
  if (status === "done") return <CheckCircle2Icon className={cn("size-4 text-emerald-500", className)} />;
  if (status === "error") return <CircleXIcon className={cn("size-4 text-red-500", className)} />;
  if (status === "running") return <LoaderCircleIcon className={cn("size-4 animate-spin text-sky-500", className)} />;
  return <CircleDashedIcon className={cn("size-4 text-muted-foreground", className)} />;
}

export function elapsedOf(agent: SubagentData, now: number) {
  if (!agent.startedAt) return 0;
  return (agent.finishedAt ?? now) - agent.startedAt;
}

function statusPlate(status: SubagentData["status"]) {
  if (status === "done") return "bg-emerald-500/15";
  if (status === "running") return "bg-sky-500/15";
  if (status === "error") return "bg-red-500/15";
  return "bg-muted";
}

function AgentMark({ status }: { status: SubagentData["status"] }) {
  return (
    <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", statusPlate(status))}>
      <SubagentStatusIcon className="size-3.5" status={status} />
    </span>
  );
}

/** An explore subagent only reads and searches (harness/agent runSubagent); a worker may change files and has no mark. */
function ReadOnlyMark({ agent }: { agent: SubagentData }) {
  if (agent.role !== "explore") return null;
  return <span className="shrink-0 rounded-[4px] border px-1 text-[11px] leading-[1.45] text-muted-foreground">Read only</span>;
}

function AgentRow({ agent }: { agent: SubagentData }) {
  const { agentId, openAgent } = useSession();
  const now = useNow(agent.status === "running");
  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 rounded-[6px] px-2 py-2 text-left hover:bg-muted/60",
        agentId === agent.id && "bg-muted"
      )}
      onClick={() => openAgent(agent.id)}
      type="button"
    >
      <AgentMark status={agent.status} />
      <span className="min-w-0 flex-1 truncate font-medium text-[15px] leading-[1.6]">{agent.name}</span>
      <ReadOnlyMark agent={agent} />
      {agent.startedAt && (
        <span className="shrink-0 text-[13px] leading-[1.4] text-muted-foreground tabular-nums">
          {formatElapsed(elapsedOf(agent, now))}
        </span>
      )}
    </button>
  );
}

function AgentGroup({ label, agents, empty }: { label: string; agents: SubagentData[]; empty?: string }) {
  return (
    <div>
      <div className="px-2 pb-2 text-[13px] leading-[1.4] text-muted-foreground">{label}</div>
      {agents.length === 0 && empty ? (
        <p className="px-2 py-2 text-[13px] leading-[1.4] text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {agents.map((agent) => (
            <AgentRow agent={agent} key={agent.id} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentList({ agents }: { agents: SubagentData[] }) {
  const active = agents.filter((agent) => agent.status === "running" || agent.status === "queued");
  const done = agents.filter((agent) => agent.status === "done" || agent.status === "error");
  return (
    <div className="flex flex-col gap-6">
      <AgentGroup agents={active} empty="No active agents" label={`Active · ${active.length}`} />
      {done.length > 0 && <AgentGroup agents={done} label={`Done · ${done.length}`} />}
    </div>
  );
}

export function SubagentTrace({ agents }: { agents: SubagentData[] }) {
  const { openAgent } = useSession();
  const now = useNow(agents.some((agent) => agent.status === "running"));
  return (
    <div className="not-prose">
      {agents.map((agent) => {
        const line =
          agent.status === "running" ? agent.currentStep : agent.status === "queued" ? "Waiting" : agent.result;
        return (
          <button
            className="flex h-7 w-full items-center gap-2 rounded-[6px] px-1 text-left hover:bg-muted/50"
            key={agent.id}
            onClick={() => openAgent(agent.id)}
            type="button"
          >
            <SubagentStatusIcon className="size-[15px]" status={agent.status} />
            <span className="shrink-0 text-[13px] leading-[1.4]">{agent.name}</span>
            <ReadOnlyMark agent={agent} />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4] text-muted-foreground">{line}</span>
            {agent.startedAt && (
              <span className="shrink-0 text-[12px] leading-[1.35] text-muted-foreground tabular-nums">
                {formatElapsed(elapsedOf(agent, now))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function AgentThread() {
  const { agentId, openAgent, chat, thread } = useSession();
  const agents = useMemo(() => deriveWorkspace(chat.messages).subagents, [chat.messages]);
  const agent = agents.find((item) => item.id === agentId);
  const now = useNow(agent?.status === "running");

  const model = agent ? getModel(agent.model) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          aria-label="Back to agents"
          className="size-7 rounded-[6px] text-muted-foreground"
          onClick={() => openAgent(null)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
        {agent && <AgentMark status={agent.status} />}
        <span className="min-w-0 truncate font-medium text-[15px] leading-[1.6]">{agent?.name ?? "Agent"}</span>
        {model && <span className="ml-auto shrink-0 pl-3 text-[13px] leading-[1.4] text-muted-foreground">{model.name}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full flex-col gap-6 px-4 pt-6 pb-8">
          {agent ? <AgentTranscript agent={agent} now={now} /> : <p className="text-[15px] leading-[1.6] text-muted-foreground">This agent is not in {thread.title}.</p>}
        </div>
      </div>
    </div>
  );
}

function AgentTranscript({ agent, now }: { agent: SubagentData; now: number }) {
  const [open, setOpen] = useState(true);
  const current = agent.status === "running" ? agent.logs.length - 1 : -1;
  const when = agent.finishedAt
    ? new Date(agent.finishedAt).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <>
      <p className="text-[15px] leading-[1.6]">{agent.task}</p>
      {agent.startedAt && (
        <div>
          <button className="flex items-center gap-2 text-[13px] leading-[1.4] text-muted-foreground" onClick={() => setOpen((value) => !value)} type="button">
            <ChevronRightIcon className={cn("size-3.5", open && "rotate-90")} />
            Worked for {formatElapsed(elapsedOf(agent, now))}
          </button>
          {open && agent.logs.length > 0 && (
            <div className="mt-3 flex flex-col gap-3 pl-6">
              {agent.logs.map((log, index) => (
                <div className="flex items-start gap-3 text-[13px] leading-[1.4]" key={`${log}-${index}`}>
                  <WrenchIcon className="mt-0.5 size-[15px] shrink-0 text-muted-foreground" />
                  {index === current ? <Shimmer duration={1.4}>{log}</Shimmer> : <span>{log}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {agent.status === "queued" && <p className="text-[15px] leading-[1.6] text-muted-foreground">Waiting to start.</p>}
      {agent.result && <p className="whitespace-pre-wrap text-[15px] leading-[1.6]">{agent.result}</p>}
      {when && <p className="text-[13px] leading-[1.4] text-muted-foreground">{when}</p>}
    </>
  );
}
