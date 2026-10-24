"use client";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  ArrowLeftIcon,
  AudioLinesIcon,
  CableIcon,
  CpuIcon,
  FolderGit2Icon,
  HistoryIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SunMoonIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { downloadProgress, ProgressRing, useDownloads } from "@/features/model-settings/downloads";
import { useMemo, useState } from "react";

const ITEMS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "permissions", label: "Permissions", icon: ShieldIcon },
  { id: "connections", label: "Connections", icon: CableIcon },
  { id: "models", label: "Models", icon: CpuIcon },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "profile", label: "Profile", icon: UserRoundIcon },
  { id: "appearance", label: "Appearance", icon: SunMoonIcon },
  { id: "voice", label: "Voice", icon: AudioLinesIcon },
  { id: "projects", label: "Projects", icon: FolderGit2Icon },
];

const row =
  "flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] outline-none transition-colors focus-visible:bg-sidebar-accent/60 [&_svg]:size-[15px] [&_svg]:shrink-0";
const idle = "text-sidebar-foreground/80 hover:bg-sidebar-accent/60";

export function SettingsNav({ onBack }: { onBack: () => void }) {
  const { settingsSection, setSettingsSection } = useStore();
  const [query, setQuery] = useState("");
  const selected = settingsSection ?? "general";
  const q = query.trim().toLowerCase();
  const items = useMemo(() => (q ? ITEMS.filter((item) => item.label.toLowerCase().includes(q)) : ITEMS), [q]);
  const downloads = useDownloads();
  const percent = downloadProgress(downloads).percent;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <button className={cn(row, idle)} onClick={onBack} type="button">
        <ArrowLeftIcon />
        Back
      </button>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-7 rounded-[6px] border-transparent bg-sidebar-accent/50 pl-7 text-[13px] shadow-none focus-visible:border-transparent"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings"
          value={query}
        />
      </div>
      <ScrollArea className="-mr-2 min-h-0 flex-1" scrollbarClassName="w-1 p-0">
        <div className="flex flex-col gap-0.5 pr-2 pb-2">
          {items.map((item) => {
            const Icon = item.icon;
            const active = selected === item.id;
            return (
              <button
                aria-current={active ? "page" : undefined}
                className={cn(row, active ? "bg-sidebar-accent text-sidebar-accent-foreground" : idle)}
                key={item.id}
                onClick={() => setSettingsSection(item.id)}
                type="button"
              >
                <Icon />
                <span className="truncate">{item.label}</span>
                {item.id === "models" && downloads.length > 0 && (
                  <span
                    aria-label={percent === undefined ? "Downloading" : `Downloading, ${percent}%`}
                    className="ml-auto flex items-center text-muted-foreground"
                    role="img"
                    title={percent === undefined ? "Downloading" : `Downloading · ${percent}%`}
                  >
                    <ProgressRing list={downloads} />
                  </span>
                )}
              </button>
            );
          })}
          {items.length === 0 && <p className="px-2 py-6 text-center text-muted-foreground text-xs">No settings match.</p>}
        </div>
      </ScrollArea>
    </div>
  );
}
