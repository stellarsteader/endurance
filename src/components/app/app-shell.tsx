"use client";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StoreProvider, useStore } from "@/lib/store";
import { useEffect, useState } from "react";
import { AppearanceSettings } from "./appearance-settings";
import { ConnectionsSettings } from "./connections-settings";
import { ModelsSettings } from "@/features/model-settings/models-settings";
import { ModelSettingsSync } from "@/features/model-settings/use-chat-models";
import { DownloadsSync } from "@/features/model-settings/downloads";
import { ChatSession } from "./chat-session";
import { LibraryPage } from "./library";
import { HistorySettings, RecoveryNudge } from "./history-settings";
import { VoiceSettings } from "./voice-settings";
import { GeneralSettings } from "./general-settings";
import { VaultGate } from "./vault-gate";
import { CommandPalette } from "./command-palette";
import { openFindInChat } from "./find-bar";
import { NewProjectHost, ProjectSettingsHost, Sidebar } from "./sidebar";
import { WindowControls, WorkspaceToggle } from "./title-bar";

function SidebarTopBar() {
  return (
    <header className="desktop-drag flex h-10 shrink-0 select-none items-center gap-0.5 px-3">
      <WindowControls />
    </header>
  );
}

function SettingsTitleBar({ withWindowControls }: { withWindowControls: boolean }) {
  return (
    <header className="desktop-drag flex h-10 shrink-0 select-none items-center gap-0.5 px-3">
      {withWindowControls && <WindowControls />}
      <div className="min-w-0 flex-1" />
      <WorkspaceToggle />
    </header>
  );
}

function Shortcuts() {
  const { setSidebarOpen, setWorkspaceOpen, setPaletteOpen, setModelPickerOpen, newThread, paletteOpen } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      } else if (key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (key === "j") {
        e.preventDefault();
        setWorkspaceOpen((v) => !v);
      } else if (key === "/") {
        e.preventDefault();
        setModelPickerOpen(true);
      } else if (key === "o" && e.shiftKey) {
        e.preventDefault();
        newThread();
      } else if (key === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openFindInChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarOpen, setWorkspaceOpen, setPaletteOpen, setModelPickerOpen, newThread, paletteOpen]);
  return null;
}

/** A clicked notification opens the chat it was about (Settings → General). */
function NotificationOpener() {
  const { selectThread, setSettingsSection, setLibrarySection } = useStore();
  useEffect(
    () =>
      window.endurance?.onOpenChat((chatId) => {
        setSettingsSection(null);
        setLibrarySection(null);
        selectThread(chatId);
      }),
    [selectThread, setSettingsSection, setLibrarySection]
  );
  return null;
}

const MAX_MOUNTED = 6;

function Sessions() {
  const { threads, activeId } = useStore();
  const [mounted, setMounted] = useState<string[]>([activeId]);
  if (!mounted.includes(activeId)) {
    setMounted([activeId, ...mounted].slice(0, MAX_MOUNTED));
  }

  return (
    <>
      {mounted.map((id) => {
        const thread = threads.find((t) => t.id === id);
        // A saved chat shows once its messages are read (lib/store), so the conversation starts with all of them.
        if (!thread || thread.loaded === false) return null;
        return <ChatSession active={id === activeId} key={id} thread={thread} />;
      })}
    </>
  );
}

function Layout() {
  const { sidebarOpen, settingsSection, librarySection } = useStore();
  const page = settingsSection ?? librarySection;
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup className="min-h-0 flex-1" orientation="horizontal">
        {sidebarOpen && (
          <>
            <ResizablePanel
              defaultSize={248}
              groupResizeBehavior="preserve-pixel-size"
              id="sidebar"
              maxSize={420}
              minSize={200}
            >
              <div className="flex h-full flex-col">
                <SidebarTopBar />
                <div className="min-h-0 flex-1">
                  <Sidebar />
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle className="bg-border" />
          </>
        )}
        <ResizablePanel id="main" minSize="480px">
          <div className="flex h-full min-w-0 flex-col">
            {page !== null && <SettingsTitleBar withWindowControls={!sidebarOpen} />}
            <main className="min-h-0 flex-1 bg-background">
              {librarySection !== null ? (
                <LibraryPage />
              ) : settingsSection === null ? (
                <Sessions />
              ) : settingsSection === "general" ? (
                <GeneralSettings />
              ) : settingsSection === "appearance" ? (
                <AppearanceSettings />
              ) : settingsSection === "connections" ? (
                <ConnectionsSettings />
              ) : settingsSection === "models" ? (
                <ModelsSettings />
              ) : settingsSection === "history" ? (
                <HistorySettings />
              ) : settingsSection === "voice" ? (
                <VoiceSettings />
              ) : (
                <div className="h-full" />
              )}
            </main>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <CommandPalette />
      <ProjectSettingsHost />
      <NewProjectHost />
      <Shortcuts />
      <NotificationOpener />
    </div>
  );
}

export function AppShell() {
  return (
    <TooltipProvider delay={300}>
      <VaultGate>
        <StoreProvider>
          <ModelSettingsSync />
          <DownloadsSync />
          <Layout />
          <RecoveryNudge />
          <Toaster position="bottom-right" />
        </StoreProvider>
      </VaultGate>
    </TooltipProvider>
  );
}
