"use client";

import { Button } from "@/components/ui/button";
import { ipcMessage } from "@/lib/desktop";
import type { UpdateState } from "@/lib/updates-api";
import { cn } from "@/lib/utils";
import { ArrowDownToLineIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** The main process's update state, live. Undefined outside the desktop app. */
function useUpdates() {
  const [state, setState] = useState<UpdateState>();
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    const api = window.enduranceUpdates;
    if (!api) return;
    let live = true;
    void api.state().then((value) => live && setState(value));
    void api.version().then((value) => live && setVersion(value));
    const stop = api.onState(setState);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return { state, version };
}

const run = (action: () => Promise<void>) => action().catch((error: Error) => toast.error(ipcMessage(error)));

/** The one action the state offers, or none. */
function action(state: UpdateState): { label: string; onClick: () => void } | undefined {
  const api = window.enduranceUpdates;
  if (!api) return undefined;
  switch (state.status) {
    case "available":
      return state.mode === "install" ? { label: "Download", onClick: () => run(api.download) } : { label: "Download", onClick: api.openRelease };
    case "ready":
      return { label: "Restart to Update", onClick: api.install };
    case "error":
      return state.version ? { label: "Try Again", onClick: () => run(api.download) } : { label: "Check for Updates", onClick: () => run(api.check) };
    case "idle":
    case "current":
      return { label: "Check for Updates", onClick: () => run(api.check) };
    default:
      return undefined;
  }
}

function describe(state: UpdateState) {
  switch (state.status) {
    case "off":
      return "Updates are turned off in development builds.";
    case "idle":
      return "Endurance checks for a new version every hour.";
    case "checking":
      return "Checking for updates.";
    case "current":
      return "You have the latest version.";
    case "available":
      return state.mode === "install" ? `Version ${state.version} is available.` : `Version ${state.version} is available. Download it from the release page.`;
    case "downloading":
      return `Downloading version ${state.version}. ${state.percent}% done.`;
    case "ready":
      return `Version ${state.version} is ready. Restart to finish the update.`;
    case "error":
      return state.message;
  }
}

/** Settings → General: the running version and the update action. */
export function UpdateRow() {
  const { state, version } = useUpdates();
  if (!state || !version) return null;
  const next = action(state);
  return (
    <div className="flex items-center gap-6 px-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-[13px] leading-[1.4]">Version {version}</div>
        <div className="text-[12px] leading-[1.35] text-muted-foreground">{describe(state)}</div>
      </div>
      {next && (
        <button className="flex h-7 shrink-0 items-center rounded-md border px-2 text-[13px] outline-none hover:bg-muted/50" onClick={next.onClick} type="button">
          {next.label}
        </button>
      )}
      {(state.status === "checking" || state.status === "downloading") && (
        <span className="flex h-7 shrink-0 items-center px-2 text-[13px] text-muted-foreground">{state.status === "checking" ? "Checking" : `${state.percent}%`}</span>
      )}
    </div>
  );
}

/** Sidebar footer: shown only while there is an update to get or finish. */
export function SidebarUpdate({ className }: { className?: string }) {
  const { state } = useUpdates();
  const api = typeof window !== "undefined" ? window.enduranceUpdates : undefined;
  if (!state || !api) return null;
  let label: string;
  let onClick: (() => void) | undefined;
  let icon = <ArrowDownToLineIcon />;
  if (state.status === "available") {
    label = `Update to ${state.version}`;
    onClick = state.mode === "install" ? () => void run(api.download) : api.openRelease;
  } else if (state.status === "downloading") {
    label = `Downloading ${state.percent}%`;
  } else if (state.status === "ready") {
    label = "Restart to Update";
    onClick = api.install;
    icon = <RotateCwIcon />;
  } else if (state.status === "error" && state.version) {
    label = "Retry Update";
    onClick = () => void run(api.download);
  } else return null;
  return (
    <Button
      className={cn("h-7 min-w-0 justify-start gap-2 rounded-[6px] px-2 font-normal text-[13px] [&_svg]:size-[15px]", className)}
      disabled={!onClick}
      onClick={onClick}
      size="sm"
      variant="ghost"
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}
