"use client";

import { parseModelId } from "@/lib/models";
import { useStore } from "@/lib/store";
import { CloudOffIcon, FolderOutputIcon, LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useSession } from "./session-context";

/**
 * One line above the composer about where this chat's model runs, when it matters now: its server ended,
 * is starting or was removed, or a project's folder contents go to another machine.
 */
export function ServerNotice() {
  const { runtimeCatalog, connections, projects, setModelPickerOpen } = useStore();
  const { thread, model } = useSession();
  // Before the first catalog arrives the list is the preview default, not what the main process saved.
  if (!model.runtime || runtimeCatalog.length === 0) return null;
  const connectionId = model.connectionId ?? parseModelId(model.id)?.connectionId ?? model.runtime;
  const connection = connections.find((item) => item.id === connectionId);
  const result = runtimeCatalog.find((item) => item.connectionId === connectionId);
  const project = projects.find((item) => item.id === thread.projectId);
  const folders = Boolean(project?.access?.folders.length || project?.folders?.length);
  const pick = (label: string) => (
    <button className="shrink-0 text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:underline" onClick={() => setModelPickerOpen(true)} type="button">
      {label}
    </button>
  );

  let icon: ReactNode = null;
  let text = "";
  let action: ReactNode = null;
  if (!connection) {
    icon = <CloudOffIcon />;
    text = "This model's server is no longer listed.";
    action = pick("Choose another model");
  } else if (result?.state === "ended") {
    icon = <CloudOffIcon />;
    text = `${connection.label} has ended.`;
    action = pick("Choose another model");
  } else if (result?.state === "starting") {
    icon = <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />;
    text = `${connection.label} is starting. It's checked again on its own.`;
    action = pick("Choose another model");
  } else if (folders && connection.location !== "this-computer") {
    icon = <FolderOutputIcon />;
    text = `Folder contents are sent to ${connection.host}.`;
    action = pick("Change model");
  }
  if (!text) return null;
  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-2 text-[12px] leading-[1.35] text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0" role="status">
      {icon}
      <span className="min-w-0 truncate">{text}</span>
      {action}
    </div>
  );
}
