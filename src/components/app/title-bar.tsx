"use client";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStore, type Thread } from "@/lib/store";
import { cn } from "@/lib/utils";
import { GhostIcon, PanelLeftIcon, PanelRightIcon, SquarePenIcon } from "lucide-react";
import type { ReactNode } from "react";

export function TitleBarButton({
  label,
  shortcut,
  onClick,
  pressed,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  /** A toggle that is on shows the full fill, as open and selected controls do (DESIGN.md: States). */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pressed}
            className={cn("size-7 text-muted-foreground [&_svg]:size-[15px]", pressed && "bg-muted text-foreground hover:bg-muted")}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut && <Kbd className="ml-1">{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

export function WindowControls() {
  const { setSidebarOpen, newThread, settingsSection } = useStore();
  return (
    <>
      {window.endurance?.platform === "darwin" ? <div aria-hidden className="mr-3 h-3 w-[52px] shrink-0" /> : <div className="mr-3 flex items-center gap-2">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>}
      <TitleBarButton label="Toggle sidebar" onClick={() => setSidebarOpen((v) => !v)} shortcut="⌘B">
        <PanelLeftIcon />
      </TitleBarButton>
      {/* Settings replace the chat list; the Library page keeps it, so New chat stays. */}
      {settingsSection === null && (
        <TitleBarButton label="New chat" onClick={() => newThread()} shortcut="⌘⇧O">
          <SquarePenIcon />
        </TitleBarButton>
      )}
    </>
  );
}

export function WorkspaceToggle() {
  const { setWorkspaceOpen, workspaceOpen } = useStore();
  return (
    <TitleBarButton label="Toggle workspace" onClick={() => setWorkspaceOpen((v) => !v)} pressed={workspaceOpen} shortcut="⌘J">
      <PanelRightIcon />
    </TitleBarButton>
  );
}

export function ChatTitleBar({
  thread,
  showWindowControls,
  end,
}: {
  thread: Thread;
  showWindowControls: boolean;
  end?: ReactNode;
}) {
  const { statuses } = useStore();
  const activeStatus = statuses[thread.id];
  const running = Object.values(statuses).filter((s) => s === "streaming").length;
  const awaiting = Object.values(statuses).filter((s) => s === "awaiting").length;

  return (
    <header className="desktop-drag flex h-10 shrink-0 select-none items-center gap-0.5 px-3">
      {showWindowControls && <WindowControls />}
      <div className={cn("flex min-w-0 flex-1 items-center gap-2", showWindowControls ? "ml-3" : "ml-1")}>
        {thread.temporary && <GhostIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate font-medium text-[13px]">{thread.title}</span>
        {activeStatus === "streaming" && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" />}
      </div>
      {(running > 0 || awaiting > 0) && (
        <div className="mr-2 flex items-center gap-2 text-xs">
          {running > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-600 dark:text-sky-300">
              <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
              {running} running
            </span>
          )}
          {awaiting > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600 dark:text-amber-300">
              <span className="size-1.5 rounded-full bg-amber-500" />
              {awaiting} waiting for you
            </span>
          )}
        </div>
      )}
      {end}
    </header>
  );
}
