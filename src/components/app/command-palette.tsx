"use client";

import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useChatModels } from "@/features/model-settings/use-chat-models";
import { hasMessages, useStore } from "@/lib/store";
import { chatModelId } from "@/lib/chat-choice";
import {
  DownloadIcon,
  GhostIcon,
  GlobeIcon,
  MessageSquareIcon,
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SquarePenIcon,
  TextSearchIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { openFindInChat } from "./find-bar";
import { canExportChat, exportChat } from "./export-chat";

export function CommandPalette() {
  const models = useChatModels();
  const {
    paletteOpen,
    setPaletteOpen,
    newThread,
    threads,
    selectThread,
    setSidebarOpen,
    setWorkspaceOpen,
    setSettings,
    settings,
    activeId,
    chooseForChat,
  } = useStore();
  // Models picked here go to the open chat.
  const active = threads.find((t) => t.id === activeId);
  const current = active ? chatModelId(active, settings.model) : settings.model;
  const { resolvedTheme, setTheme } = useTheme();
  // Find works on the chat on screen, so it is offered only while one is.
  const { settingsSection, librarySection } = useStore();
  const chatOnScreen = settingsSection === null && librarySection === null;

  const run = (fn: () => void) => {
    fn();
    setPaletteOpen(false);
  };

  return (
    <CommandDialog onOpenChange={setPaletteOpen} open={paletteOpen}>
      <Command>
        <CommandInput placeholder="Search chats, switch models, run commands…" />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => run(() => newThread())}>
              <SquarePenIcon /> New chat <CommandShortcut>⌘⇧O</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(() => newThread({ temporary: true }))}>
              <GhostIcon /> New temporary chat
            </CommandItem>
            <CommandItem onSelect={() => run(() => setSidebarOpen((v) => !v))}>
              <PanelLeftIcon /> Toggle sidebar <CommandShortcut>⌘B</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => run(() => setWorkspaceOpen((v) => !v))}>
              <PanelRightIcon /> Toggle workspace <CommandShortcut>⌘J</CommandShortcut>
            </CommandItem>
            {chatOnScreen && (
              <CommandItem onSelect={() => run(openFindInChat)}>
                <TextSearchIcon /> Find in chat <CommandShortcut>⌘F</CommandShortcut>
              </CommandItem>
            )}
            {active && hasMessages(active) && canExportChat() && (
              <>
                <CommandItem onSelect={() => run(() => void exportChat(active, "markdown"))}>
                  <DownloadIcon /> Export chat as Markdown
                </CommandItem>
                <CommandItem onSelect={() => run(() => void exportChat(active, "json"))}>
                  <DownloadIcon /> Export chat as JSON
                </CommandItem>
              </>
            )}
            <CommandItem onSelect={() => run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}>
              <MoonIcon /> Toggle theme
            </CommandItem>
            <CommandItem onSelect={() => run(() => setSettings({ webSearch: !settings.webSearch }))}>
              <GlobeIcon /> {settings.webSearch ? "Disable" : "Enable"} web search
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Models">
            {models.map((m) => (
              <CommandItem key={m.id} onSelect={() => run(() => (active ? chooseForChat(active.id, { model: m.id }) : setSettings({ model: m.id })))} value={`model ${m.name}`}>
                <ModelSelectorLogo className="size-3.5" provider={m.provider} />
                {m.name}
                {current === m.id && <CommandShortcut>current</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Chats">
            {threads
              .filter(hasMessages)
              .map((t) => (
                <CommandItem key={t.id} onSelect={() => run(() => selectThread(t.id))} value={`chat ${t.title} ${t.id}`}>
                  <MessageSquareIcon /> {t.title}
                </CommandItem>
              ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
