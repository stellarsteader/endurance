"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { SkillFolder, SkillSummary } from "@/lib/workspace-api";
import { ChevronRightIcon, LoaderCircleIcon, PuzzleIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PageScroll } from "./page-scroll";

/**
 * The Library is a page, like a chat: the sidebar keeps the chat list and marks Library as open, and the
 * page switches between sections with the same line tabs as the workspace panel. A section is listed here
 * only when it does something real in this build.
 */
const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "skills", label: "Skills", icon: SparklesIcon },
  { id: "plugins", label: "Plugins", icon: PuzzleIcon },
];

let lastSection = SECTIONS[0].id;
/** The section to show when Library opens: the one used last in this session. */
export const librarySectionToOpen = () => lastSection;

const smallButton = "h-7 shrink-0 rounded-[6px] px-2.5 text-[12px]";

export function LibraryPage() {
  const { librarySection, setLibrarySection } = useStore();
  const section = SECTIONS.some((item) => item.id === librarySection) ? librarySection! : SECTIONS[0].id;
  const skills = useSkillFolders();
  const show = (id: string) => {
    lastSection = id;
    setLibrarySection(id);
  };

  // Each section's main action sits at the right of the title row, where Add folder always was.
  const action: Record<string, ReactNode> = {
    skills: !skills.empty && skills.desktop && (
      <Button className={smallButton} disabled={skills.adding} onClick={skills.add} variant="secondary">
        Add folder
      </Button>
    ),
  };

  return (
    <PageScroll>
      <Tabs className="mx-auto w-full max-w-xl gap-0" onValueChange={(value) => show(String(value))} value={section}>
        <div className="flex h-7 items-center justify-between pl-2">
          <h1 className="font-medium text-[15px] leading-[1.6]">Library</h1>
          {action[section]}
        </div>
        <TabsList aria-label="Library sections" className="mt-2 mb-6 h-7 w-max gap-0.5 bg-transparent p-0" variant="line">
          {SECTIONS.map((item) => (
            <TabsTrigger className="h-6 flex-none gap-1.5 px-2 text-[13px] leading-[1.4]" key={item.id} value={item.id}>
              <item.icon className="size-3.5" />
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="skills">
          <SkillsSection skills={skills} />
        </TabsContent>
        <TabsContent value="plugins">
          <PluginsSection onShowSkills={() => show("skills")} />
        </TabsContent>
      </Tabs>
    </PageScroll>
  );
}

/** Plugins are not in this build. The page says so plainly and offers no controls that would pretend. */
function PluginsSection({ onShowSkills }: { onShowSkills: () => void }) {
  return (
    <section className="flex items-center gap-6 rounded-[12px] border bg-card p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-[13px] leading-[1.4]">Plugins aren't available yet</div>
        <div className="text-[12px] leading-[1.35] text-muted-foreground">
          A plugin will bundle skills, tools and settings you turn on together. Skills from a folder work today.
        </div>
      </div>
      <Button className={smallButton} onClick={onShowSkills} variant="secondary">
        Open Skills
      </Button>
    </section>
  );
}

function SkillRow({ skill, onChange }: { skill: SkillSummary; onChange: (folders: SkillFolder[]) => void }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    if (!open || content !== null) return;
    window.enduranceWorkspace
      ?.readSkill(skill.path)
      .then(setContent)
      .catch(() => setContent(""));
  }, [open, content, skill.path]);
  return (
    <div>
      <div className="flex items-center gap-6 p-3">
        <button aria-expanded={open} className="group/skill flex min-w-0 flex-1 items-start gap-2 text-left outline-none" onClick={() => setOpen((value) => !value)} type="button">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-1.5 text-[13px] leading-[1.4]">
              {skill.name}
              <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
            </div>
            {skill.description && <p className="line-clamp-2 text-[12px] leading-[1.35] text-muted-foreground">{skill.description}</p>}
          </div>
        </button>
        <Switch
          aria-label={`Use ${skill.name}`}
          checked={skill.enabled}
          onCheckedChange={async (enabled) => {
            try {
              onChange(await window.enduranceWorkspace!.setSkillEnabled(skill.path, enabled));
            } catch {
              toast("Couldn't update this skill");
            }
          }}
          size="sm"
        />
      </div>
      {open && (
        <div className="px-3 pb-3">
          <div className="max-h-80 overflow-y-auto rounded-[6px] bg-muted/40 px-3 py-2 text-[13px] leading-[1.4]">
            {content === null ? (
              <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
            ) : content ? (
              <MessageResponse className="[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px]">{content}</MessageResponse>
            ) : (
              <span className="text-muted-foreground">This skill file is unavailable.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function useSkillFolders() {
  const desktop = Boolean(window.enduranceWorkspace);
  const [folders, setFolders] = useState<SkillFolder[] | null>(desktop ? null : []);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    window.enduranceWorkspace?.skills().then(setFolders).catch(() => setFolders([]));
  }, []);
  const add = async () => {
    if (!window.enduranceWorkspace) return;
    setAdding(true);
    try {
      setFolders(await window.enduranceWorkspace.addSkillFolder());
    } catch {
      toast("Couldn't add that folder");
    } finally {
      setAdding(false);
    }
  };
  return { desktop, folders, setFolders, adding, add, empty: folders !== null && folders.length === 0 };
}

function SkillsSection({ skills }: { skills: ReturnType<typeof useSkillFolders> }) {
  const { desktop, folders, setFolders, adding, add, empty } = skills;
  return (
    <div className="flex flex-col">
      {folders === null && <LoaderCircleIcon className="ml-2 size-4 animate-spin text-muted-foreground" />}
      {empty && (
        <section className="flex items-center gap-6 rounded-[12px] border bg-card p-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-[13px] leading-[1.4]">No skills folder</div>
            <div className="text-[12px] leading-[1.35] text-muted-foreground">
              {desktop ? "Add a folder that contains SKILL.md files." : "Skills folders need the desktop app."}
            </div>
          </div>
          {desktop && (
            <Button className={smallButton} disabled={adding} onClick={add} variant="secondary">
              Add folder
            </Button>
          )}
        </section>
      )}
      <div className="flex flex-col gap-7">
        {folders?.map((folder) => (
          <section aria-label={folder.name} className="group/folder" key={folder.path}>
            <div className="mb-2 flex items-center justify-between px-2">
              <h2 className="text-[12px] leading-[1.35] text-muted-foreground" title={folder.path}>
                {folder.name}
              </h2>
              <button
                className="text-[12px] leading-[1.35] text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
                onClick={async () => setFolders(await window.enduranceWorkspace!.removeSkillFolder(folder.path))}
                type="button"
              >
                Remove
              </button>
            </div>
            <div className="divide-y overflow-hidden rounded-[12px] border bg-card">
              {folder.error && <p className="p-3 text-[12px] leading-[1.35] text-muted-foreground">{folder.error}</p>}
              {!folder.error && folder.skills.length === 0 && <p className="p-3 text-[12px] leading-[1.35] text-muted-foreground">No SKILL.md files in this folder.</p>}
              {folder.skills.map((skill) => (
                <SkillRow key={skill.path} onChange={setFolders} skill={skill} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {folders && folders.some((folder) => folder.skills.length > 0) && (
        <p className="mt-4 px-2 text-[12px] leading-[1.35] text-muted-foreground">Name a skill in a message to use it.</p>
      )}
    </div>
  );
}
