"use client";

import { useStore } from "@/lib/store";
import {
  CodeXmlIcon,
  GitBranchIcon,
  GlobeIcon,
  InfinityIcon,
  ListChecksIcon,
  WorkflowIcon,
} from "lucide-react";
import { useSession } from "./session-context";

const STARTERS: {
  icon: typeof InfinityIcon;
  title: string;
  prompt: string;
  webSearch?: boolean;
  tag: string;
}[] = [
  {
    icon: InfinityIcon,
    title: "Ship a feature with subagents",
    prompt: "Add rate limiting to the /api routes and write tests",
    tag: "Agent",
  },
  {
    icon: ListChecksIcon,
    title: "Plan before building",
    prompt: "Plan how we should add rate limiting to our API",
    tag: "Plan",
  },
  {
    icon: GlobeIcon,
    title: "Deep research with sources",
    prompt: "What's the latest on solid-state batteries?",
    webSearch: true,
    tag: "Search",
  },
  {
    icon: CodeXmlIcon,
    title: "Write some code",
    prompt: "Write a typed debounce function in TypeScript",
    tag: "Code",
  },
  {
    icon: WorkflowIcon,
    title: "Explain with a diagram",
    prompt: "Draw a sequence diagram of how a rate-limited request flows",
    tag: "Diagram",
  },
  {
    icon: GitBranchIcon,
    title: "Compare approaches",
    prompt: "Compare fixed window vs sliding window vs token bucket in a table",
    tag: "Compare",
  },
];

export function Welcome() {
  const { setSettings } = useStore();
  const { send } = useSession();

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-8 py-10">
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {STARTERS.map((s) => (
          <button
            className="group flex flex-col gap-2 rounded-xl border bg-background p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm"
            key={s.title}
            onClick={() => {
              const overrides = { webSearch: Boolean(s.webSearch) };
              setSettings(overrides);
              send({ text: s.prompt }, overrides);
            }}
            type="button"
          >
            <div className="flex items-center justify-between">
              <s.icon className="size-4 text-muted-foreground group-hover:text-foreground" />
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{s.tag}</span>
            </div>
            <div className="font-medium text-sm">{s.title}</div>
            <div className="line-clamp-2 text-muted-foreground text-xs">{s.prompt}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
