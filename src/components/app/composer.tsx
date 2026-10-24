"use client";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ipcMessage } from "@/lib/desktop";
import { attachableImage, attachmentUrl, claimedImageFormat, documentFormat, MAC_IMAGE_FORMATS } from "@/lib/attachments";
import { ImageError, prepareImage } from "@/lib/prepare-image";
import { waitingQuestion } from "@/lib/interrupted";
import { NOT_BROWSING, recall, sentPrompts, type Recall } from "@/lib/prompt-recall";
import { useStore } from "@/lib/store";
import type { Approval } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ArrowUpIcon,
  AtSignIcon,
  FileCodeIcon,
  GlobeIcon,
  ImageIcon,
  ListOrderedIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderXIcon,
  XIcon,
  HandIcon,
  ListPlusIcon,
  MessageCirclePlusIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  MicIcon,
  MonitorIcon,
  PaperclipIcon,
  PlusIcon,
  SlashIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { ContextMeter } from "./context-meter";
import { SafeImage, useImageViewer } from "./image-viewer";
import { ModelPicker } from "./model-picker";
import { ComposerQueue } from "./composer-queue";
import { ServerNotice } from "./server-notice";
import { useSession } from "./session-context";
import { ModelEffortMenu, POPUP_GAP } from "./model-menu";
import { RecordingBar, useVoiceRecording } from "./voice-recorder";

interface MenuItem {
  id: string;
  label: string;
  hint: string;
  icon: typeof SlashIcon;
}

/** The slash commands. /compact needs a model from a connected runtime. */
function slashCommands(runtime: boolean): MenuItem[] {
  return [
    { id: "side", label: "side", hint: "Start a side chat for this conversation", icon: MessageCirclePlusIcon },
    { id: "model", label: "model", hint: "Choose a different model", icon: SparklesIcon },
    { id: "internet", label: "internet", hint: "Toggle internet access", icon: GlobeIcon },
    ...(runtime ? [{ id: "compact", label: "compact", hint: "Summarize turns before the latest one to free context", icon: ListOrderedIcon }] : []),
    { id: "clear", label: "clear", hint: "Clear this conversation", icon: Trash2Icon },
  ];
}

/** What the agent asks first in each mode: going online (src/harness/agent.ts) and shell commands (needsApproval in src/harness/shell.ts). */
export const APPROVALS: { id: Approval; label: string; hint: string; icon: typeof HandIcon; danger?: boolean }[] = [
  { id: "ask", label: "Ask for approval", hint: "Asks before running a command or going online", icon: HandIcon },
  { id: "auto", label: "Approve for me", hint: "Goes online and runs reads, tests and builds without asking. Asks before other commands.", icon: ShieldCheckIcon },
  { id: "full", label: "Full access", hint: "Runs any command and goes online without asking", icon: ShieldAlertIcon, danger: true },
];

/** This chat's approval mode, kept with the chat; Internet Access stays app-wide. */
function PermissionsMenu() {
  const { settings, setSettings, threads, activeId, projects, openProjectSettings } = useStore();
  const { approval, choose } = useSession();
  const current = APPROVALS.find((a) => a.id === approval) ?? APPROVALS[0];
  const project = projects.find((p) => p.id === threads.find((t) => t.id === activeId)?.projectId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton
            aria-label={`Permissions: ${current.label}`}
            className={cn(
              "relative size-7 rounded-[8px] text-muted-foreground",
              current.danger && "text-orange-500 hover:text-orange-500 dark:text-orange-400"
            )}
            size="icon-sm"
            tooltip={`Permissions · ${current.label}`}
          >
            <current.icon className="size-4" />
            {settings.webSearch && (
              <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-sky-500 ring-2 ring-background" />
            )}
          </PromptInputButton>
        }
      />
      <DropdownMenuContent align="start" className="w-[27rem] p-1" side="top" sideOffset={POPUP_GAP}>
        <DropdownMenuRadioGroup
          onValueChange={(v) => choose({ approval: v as Approval })}
          value={approval}
        >
          {APPROVALS.map((a) => (
            <DropdownMenuRadioItem
              className="items-center gap-2 rounded-md py-1 pr-8 pl-2 text-[13px] font-normal leading-none focus:bg-muted focus:text-foreground data-checked:bg-muted [&_[data-slot=dropdown-menu-radio-item-indicator]]:inset-y-0"
              key={a.id}
              value={a.id}
            >
              <a.icon className={cn("size-4", a.danger ? "text-orange-500!" : "text-muted-foreground!")} />
              <span className="flex min-w-0 flex-col">
                <span className={cn("leading-4", a.danger ? "text-orange-500! dark:text-orange-400!" : "text-foreground!")}>
                  {a.label}
                </span>
                <span className={cn("text-[12px] leading-4", a.danger ? "text-orange-500/80!" : "text-muted-foreground!")}>
                  {a.hint}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-2 pt-1 pb-1.5 text-[12px] leading-4 text-muted-foreground">
          In every mode, files change only in Read &amp; write folders, and edits aren&apos;t asked about. Going online
          needs Internet Access. Plans and questions always wait for you.
        </p>
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuItem
          className="h-[26px] gap-2 rounded-md py-0 pr-2 pl-2 text-[13px] font-normal leading-none"
          closeOnClick={false}
          onClick={() => setSettings({ webSearch: !settings.webSearch })}
        >
          <GlobeIcon className="size-4 text-muted-foreground" />
          <span className="flex-1">Internet Access</span>
          <Toggle checked={settings.webSearch} />
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuItem
          className="h-[26px] gap-2 rounded-md py-0 pr-2 pl-2 text-[13px] font-normal leading-none"
          disabled={!project}
          onClick={() => project && openProjectSettings(project.id)}
        >
          <Settings2Icon className="size-4 text-muted-foreground" />
          <span className="flex-1">Go to project settings</span>
          <span className="text-muted-foreground text-xs">{project ? project.name : "No project"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Toggle({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200",
        checked ? "bg-sky-500" : "bg-foreground/15"
      )}
    >
      <span
        className={cn(
          "size-3 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.28)] transition-transform duration-200 ease-[cubic-bezier(.3,1.4,.6,1)]",
          checked ? "translate-x-3" : "translate-x-0"
        )}
      />
    </span>
  );
}

const MAX_MENTIONS = 30;

/**
 * Files from the thread's project folders for an @ mention, searched by the main process, which applies folder
 * access, ignored folders, .gitignore and secrets files. `notice` explains an empty list.
 */
function useMentionFiles(query: string | null, isSide: boolean, projectId?: string): { items: MenuItem[]; notice?: string; more?: boolean } {
  const { projects } = useStore();
  const project = isSide ? undefined : projects.find((p) => p.id === projectId);
  const folders = project?.access?.folders.length ?? 0;
  const api = typeof window === "undefined" ? undefined : window.enduranceWorkspace;
  const [found, setFound] = useState<{ key: string; files: string[]; more: boolean; error?: string } | null>(null);
  const id = project?.id;
  const key = id && query !== null ? `${id}\n${query}` : null;
  useEffect(() => {
    if (!key || !id || !api || !folders || query === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.mentionFiles(id, query).then(
        (result) => !cancelled && setFound({ key, files: result.files.slice(0, MAX_MENTIONS), more: result.more }),
        (error: Error) => !cancelled && setFound({ key, files: [], more: false, error: ipcMessage(error) })
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, id, api, folders, query]);

  if (query === null) return { items: [] };
  const notice = (text: string) => ({ items: [], notice: text });
  if (isSide) return notice("Side chats have no project folders to mention.");
  if (!project) return notice("Add a project folder to mention files.");
  if (!api) return notice("File mentions need the desktop app.");
  if (!folders) return notice("Add a folder to this project to mention its files.");
  // Results for an earlier query stay up until the new ones arrive, so the list doesn't flicker.
  if (!found || !found.key.startsWith(`${id}\n`)) return notice("Searching project files…");
  if (found.error) return notice(found.error);
  const items = found.files.map((path) => ({ id: path, label: path, hint: "File", icon: FileCodeIcon }));
  if (!items.length) return notice(found.key === key && query ? `No project files match “${query}”.` : found.key === key ? "No files in this project's folders." : "Searching project files…");
  return { items, more: found.more };
}

const isImage = (file: { mediaType?: string }) => Boolean(file.mediaType?.startsWith("image/"));
/** HEIC and TIFF are converted when sent, but the window cannot draw them, so until then they show as files. */
const previewable = (file: { mediaType?: string; filename?: string }) => {
  const format = claimedImageFormat(file.mediaType ?? "", file.filename);
  return isImage(file) && !(format && MAC_IMAGE_FORMATS.has(format));
};

function AttachmentChips() {
  const attachments = usePromptInputAttachments();
  const images = attachments.files.filter(previewable).map((file) => ({ id: file.id, url: file.url, name: file.filename }));
  const { open, viewer } = useImageViewer(images);
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader className="px-3 pt-3">
      <Attachments className="items-end" variant="inline">
        {attachments.files.map((file) =>
          previewable(file) ? (
            <div className="group relative size-14 shrink-0" key={file.id}>
              <button
                aria-label={`Preview ${file.filename ?? "image"}`}
                className="size-full cursor-zoom-in overflow-hidden rounded-[10px] bg-muted outline-none ring-1 ring-foreground/10 transition hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => open(images.findIndex((image) => image.id === file.id))}
                type="button"
              >
                <SafeImage alt={file.filename ?? "Image"} className="size-full object-cover" src={file.url} />
              </button>
              <button
                aria-label={`Remove ${file.filename ?? "image"}`}
                className="-top-1.5 -right-1.5 absolute flex size-5 items-center justify-center rounded-full bg-foreground text-background opacity-0 shadow-sm outline-none ring-2 ring-background transition-opacity hover:bg-foreground/85 focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => attachments.remove(file.id)}
                type="button"
              >
                <XIcon className="size-3" strokeWidth={2.5} />
              </button>
            </div>
          ) : (
            <Attachment className="h-14 rounded-[10px] px-2.5" data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
              {isImage(file) ? (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-muted">
                  <ImageIcon className="size-4 text-muted-foreground" />
                </div>
              ) : (
                <AttachmentPreview className="size-8 rounded-[6px] bg-muted" />
              )}
              <AttachmentInfo className="max-w-40 text-[13px]" showMediaType />
              <AttachmentRemove />
            </Attachment>
          )
        )}
      </Attachments>
      {viewer}
    </PromptInputHeader>
  );
}

function AddMenu() {
  const attachments = usePromptInputAttachments();
  const { setInput, value } = usePromptInputController().textInput;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputButton aria-label="Add" className="size-7 rounded-[8px]" tooltip="Add files, screenshots, context">
            <PlusIcon className="size-4" />
          </PromptInputButton>
        }
      />
      <DropdownMenuContent align="start" className="w-60 p-1" side="top" sideOffset={POPUP_GAP}>
        <DropdownMenuItem onClick={() => attachments.openFileDialog()}>
          <PaperclipIcon /> Upload files
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => attachments.openFileDialog()}>
          <ImageIcon /> Add images
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={async () => {
            try {
              const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
              const track = stream.getVideoTracks()[0];
              const video = document.createElement("video");
              video.srcObject = stream;
              await video.play();
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              canvas.getContext("2d")?.drawImage(video, 0, 0);
              track.stop();
              canvas.toBlob((blob) => {
                if (blob) attachments.add([new File([blob], "screenshot.png", { type: "image/png" })]);
              });
            } catch {
              toast("Screenshot cancelled");
            }
          }}
        >
          <MonitorIcon /> Take screenshot
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setInput(`${value}${value && !value.endsWith(" ") ? " " : ""}@`)}>
          <AtSignIcon /> Mention a file
          <DropdownMenuShortcut>@</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setInput("/")}>
          <SlashIcon /> Run a command
          <DropdownMenuShortcut>/</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Icons and labels line up with the trigger's: card inset (4) + row inset (8) = trigger inset (8) − alignOffset (−4).
 * The footer's 5px inset puts the card's 1px ring on the composer's left border.
 */
const projectRow =
  "h-[26px] gap-1.5 rounded-[8px] py-0 pl-2 text-[13px] font-normal leading-none [&>svg]:size-[15px]! [&>svg]:text-muted-foreground [&_[data-slot$=indicator]]:right-2 [&_[data-slot$=indicator]_svg]:size-3.5!";

function ProjectSelector() {
  const { threads, activeId, projects, updateThread, openProjectSettings, openNewProject } = useStore();
  const thread = threads.find((t) => t.id === activeId);
  const project = projects.find((p) => p.id === thread?.projectId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            className="flex h-6 min-w-0 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-popup-open:bg-muted/70 data-popup-open:text-foreground"
            type="button"
          />
        }
      >
        <FolderIcon className="size-[15px] shrink-0" />
        <span className="truncate">{project?.name ?? "No project"}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" alignOffset={-4} className="w-[13.75rem] p-1" side="top" sideOffset={POPUP_GAP}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1.5 pb-0.5 text-[11px] font-normal">Project</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(v) => thread && updateThread(thread.id, { projectId: v === "none" ? undefined : (v as string) })}
            value={project?.id ?? "none"}
          >
            {projects.map((p) => (
              <DropdownMenuRadioItem className={projectRow} key={p.id} value={p.id}>
                <FolderIcon />
                <span className="truncate">{p.name}</span>
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuRadioItem className={projectRow} value="none">
              <FolderXIcon />
              No project
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuItem className={projectRow} onClick={() => openNewProject(thread?.id ?? null)}>
          <FolderPlusIcon />
          New project…
        </DropdownMenuItem>
        {project && (
          <DropdownMenuItem className={projectRow} onClick={() => openProjectSettings(project.id)}>
            <Settings2Icon />
            Project settings…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The @ query being typed at the end of the input. Paths may hold any character but spaces and @. */
const MENTION = /(?:^|\s)@([^\s@]*)$/;

function useTriggerMenu(value: string, runtime: boolean, isSide: boolean, projectId?: string) {
  const mention = MENTION.exec(value)?.[1] ?? null;
  const files = useMentionFiles(mention, isSide, projectId);
  return useMemo(() => {
    const slash = /^\/(\w*)$/.exec(value);
    if (slash) {
      const q = slash[1].toLowerCase();
      return { kind: "slash" as const, query: q, items: slashCommands(runtime).filter((c) => c.id.startsWith(q)) };
    }
    if (mention !== null) return { kind: "mention" as const, query: mention, ...files };
    return null;
  }, [value, runtime, mention, files]);
}

/** `compact` runs /compact in the session. */
export function Composer({ compact }: { compact?: () => void }) {
  const { settings, setSettings, setModelPickerOpen, newThread, setSettingsSection } = useStore();
  const { chat, busy, pendingApproval, enqueue, send, thread, openSideChat, isSide, active, model } = useSession();
  const { value, setInput } = usePromptInputController().textInput;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recalled = useRef<Recall>(NOT_BROWSING);
  const runtime = Boolean(model.runtime);
  const menu = useTriggerMenu(value, runtime, isSide, thread.projectId);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const notice = menu?.kind === "mention" ? menu.notice : undefined;
  const more = menu?.kind === "mention" && menu.more;
  // A mention with nothing to pick still opens, to say why; the keys only act on a list with items.
  const menuOpen = Boolean(menu && (menu.items.length > 0 || notice) && dismissedFor !== value);
  const menuActive = menuOpen && Boolean(menu?.items.length);
  const hasText = value.trim().length > 0;
  const waiting = busy || pendingApproval;
  const asked = !busy && Boolean(waitingQuestion(chat.messages));
  const getText = useCallback(() => value, [value]);
  const onVoiceError = useCallback((message: string) => toast.error(message), []);
  const voice = useVoiceRecording({ getText, setText: setInput, onError: onVoiceError });

  // Stopping transcribes, then sends when asked to; a cancelled or failed transcription leaves the text as it was.
  const finishVoice = async (submit: boolean) => {
    const result = await voice.stop();
    if (!result) return;
    if (!submit || !result.spoken) {
      textareaRef.current?.focus();
      return;
    }
    setTimeout(() => textareaRef.current?.form?.requestSubmit(), 60);
  };

  useEffect(() => {
    textareaRef.current?.focus();
  }, [thread.id]);

  const runCommand = useCallback(
    (id: string) => {
      setInput("");
      switch (id) {
        case "model":
          setModelPickerOpen(true);
          break;
        case "internet":
          setSettings({ webSearch: !settings.webSearch });
          toast(settings.webSearch ? "Internet access off" : "Internet access on");
          break;
        case "side":
          openSideChat();
          break;
        case "clear":
          chat.setMessages([]);
          toast("Conversation cleared");
          break;
        case "compact":
          compact?.();
          break;
        case "new":
          newThread();
          break;
      }
    },
    [chat, setInput, setSettings, setModelPickerOpen, settings.webSearch, newThread, openSideChat, compact]
  );

  const pickMenuItem = useCallback(
    (item: MenuItem) => {
      if (!menu) return;
      if (menu.kind === "slash") {
        runCommand(item.id);
      } else {
        setInput(value.replace(/@([^\s@]*)$/, `@${item.id} `));
      }
      setMenuIndex(0);
      textareaRef.current?.focus();
    },
    [menu, runCommand, setInput, value]
  );

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const text = message.text.trim();
      if (!text && message.files.length === 0) return;
      // Images are made ready for the model first, and the chat keeps what was sent (src/lib/prepare-image).
      const desktop = window.endurance;
      const convert = desktop?.platform === "darwin" ? (bytes: Uint8Array) => desktop.convertImage(bytes) : undefined;
      const prepared = await Promise.all(
        message.files.map(async (file) => {
          if (!claimedImageFormat(file.mediaType, file.filename) && !file.mediaType.startsWith("image/")) return file;
          try {
            return await prepareImage(file, convert);
          } catch (error) {
            toast.error(error instanceof ImageError ? error.message : `Could not attach ${file.filename ?? "the image"}.`);
            throw error;
          }
        })
      );
      // Documents are kept once in the app's data folder; the message names them, so history stays small.
      const files = await Promise.all(
        prepared.map(async (file) => {
          if (!documentFormat(file.mediaType, file.filename) || !file.url.startsWith("blob:") || !window.endurance) return file;
          try {
            const data = await (await fetch(file.url)).arrayBuffer();
            const saved = await window.endurance.saveAttachment(file.filename ?? "Document", file.mediaType, data);
            return { ...file, url: attachmentUrl(saved.id) };
          } catch (error) {
            toast.error(error instanceof Error ? ipcMessage(error) : `Could not attach ${file.filename ?? "the document"}.`);
            throw error;
          }
        })
      );
      // A question from the agent is waiting: what is typed here is the answer, and the reply goes on.
      const question = busy ? undefined : waitingQuestion(chat.messages);
      // Once a message goes, the box lets go of the keyboard; typing again starts with a click.
      const release = () => textareaRef.current?.blur();
      if (question && text && files.length === 0) {
        chat.addToolApprovalResponse({ id: question, approved: true, reason: text });
        return release();
      }
      if (waiting) {
        enqueue({ text, files });
        return release();
      }
      send({ text, files });
      release();
    },
    [waiting, busy, chat, enqueue, send]
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (voice.active) {
      if (e.key === "Escape") {
        e.preventDefault();
        voice.cancel();
      } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        finishVoice(true);
      }
      return;
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      setDismissedFor(value);
      return;
    }
    if (menuActive && menu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menu.items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menu.items.length) % menu.items.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickMenuItem(menu.items[Math.min(menuIndex, menu.items.length - 1)]);
        return;
      }
    }
    // ↑/↓ bring back what was sent earlier in this chat; never while a Korean or other IME is composing.
    const arrow = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : undefined;
    if (arrow && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      const box = e.currentTarget;
      const next = recall(sentPrompts(chat.messages), recalled.current, arrow, value, { start: box.selectionStart, end: box.selectionEnd });
      if (next) {
        e.preventDefault();
        recalled.current = next.state;
        setInput(next.text);
        // The caret goes where the next press continues: the start going back, the end coming forward.
        requestAnimationFrame(() => {
          const at = arrow === "up" ? 0 : next.text.length;
          textareaRef.current?.setSelectionRange(at, at);
        });
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && waiting && hasText) {
      e.preventDefault();
      enqueue({ text: value.trim(), files: [] }, true);
      setInput("");
      textareaRef.current?.blur();
      if (busy) chat.stop();
      toast("Steering: sending now");
      return;
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      chat.stop();
    }
  };

  const submitStatus = busy && !hasText ? chat.status : undefined;

  return (
    <div className="@container/composer relative mx-auto w-full max-w-(--chat-width) px-3 pb-1.5">
      {menuOpen && menu && (
        <div className="absolute right-3 bottom-full left-3 z-30 mb-2 overflow-hidden rounded-2xl border bg-popover p-1.5 shadow-lg">
          {menu.items.map((item, i) => (
            <button
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm",
                i === Math.min(menuIndex, menu.items.length - 1) ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
              )}
              key={item.id}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMenuItem(item);
              }}
              onMouseEnter={() => setMenuIndex(i)}
              type="button"
            >
              <item.icon className="size-4 shrink-0 text-muted-foreground" />
              {menu.kind === "slash" ? (
                <>
                  <span className="font-medium text-sky-600 dark:text-sky-400">{item.label}</span>
                  <span className="truncate text-muted-foreground">{item.hint}</span>
                </>
              ) : (
                <span className="truncate font-mono text-[13px]">{item.label}</span>
              )}
            </button>
          ))}
          {notice && <div className="px-3 py-2 text-muted-foreground text-sm">{notice}</div>}
          {more && <div className="px-3 pt-1 pb-1.5 text-muted-foreground text-xs">Type more of the path to narrow the list.</div>}
        </div>
      )}

      <ServerNotice />
      <ComposerQueue />

      <PromptInput
        className="relative z-10 rounded-[16px] bg-background shadow-sm [&_[data-slot=input-group]]:rounded-[16px] [&_[data-slot=input-group]]:bg-background"
        globalDrop
        // Only images that can be made ready (HEIC and TIFF on macOS only) and the documents the chat worker reads can be
        // sent; anything else is refused here, by name.
        acceptFile={(file) => attachableImage(file.type, file.name, window.endurance?.platform) || Boolean(documentFormat(file.type, file.name))}
        keepBlob={(file) => Boolean(documentFormat(file.mediaType, file.filename))}
        maxFileSize={200 * 1024 * 1024}
        multiple
        onError={(err) => toast.error(err.message, err.code === "accept" ? { description: "Attach images, or PDF, Word, Excel, CSV or text files." } : undefined)}
        onSubmit={handleSubmit}
      >
        <AttachmentChips />
        <PromptInputTextarea
          className="min-h-12 px-3.5 pt-3 text-[15px] leading-[1.6] md:text-[15px]"
          onKeyDown={handleKeyDown}
          placeholder={
            voice.active
              ? voice.transcribing ? "Transcribing…" : "Listening…"
              : asked
                ? "Answer the agent's question…"
                : waiting
                  ? "Queue a follow-up…  (⌘↵ to steer now)"
                  : "Ask anything…  (/ for commands, @ for files)"
          }
          ref={textareaRef}
        />
        <PromptInputFooter className="px-2 pb-2 pt-0.5">
          {voice.active ? (
            <RecordingBar
              levels={voice.levels}
              onCancel={voice.cancel}
              onSend={() => finishVoice(true)}
              onStop={() => finishVoice(false)}
              transcribing={voice.transcribing}
            />
          ) : (
            <>
              <PromptInputTools className="shrink-0">
                <AddMenu />
                <PermissionsMenu />
              </PromptInputTools>
              <div className="flex min-w-0 items-center gap-1">
                <ModelEffortMenu />
                {/* ⌘/ opens one picker, for the main chat on screen; side chats pick from their model menu. */}
                {active && !isSide && <ModelPicker />}
                {/* Without a speech-to-text model nothing records; the button opens Settings → Voice to choose one. */}
                <PromptInputButton
                  aria-label={voice.available ? "Voice input" : "Voice input: choose a speech-to-text model in Settings"}
                  className={cn("size-7 rounded-[8px] text-muted-foreground", !voice.available && "opacity-50")}
                  onClick={voice.available ? voice.start : () => setSettingsSection("voice")}
                  size="icon-sm"
                  tooltip={voice.available ? "Voice input" : "Voice input · Choose a speech-to-text model in Settings → Voice"}
                >
                  <MicIcon className="size-4" />
                </PromptInputButton>
                <PromptInputSubmit
                  {...(waiting && hasText ? { "aria-label": "Queue message" } : {})}
                  className="size-7 rounded-full"
                  onStop={chat.stop}
                  size="icon-sm"
                  status={submitStatus}
                >
                  {waiting && hasText ? <ListPlusIcon className="size-4" /> : submitStatus ? undefined : <ArrowUpIcon className="size-4" />}
                </PromptInputSubmit>
              </div>
            </>
          )}
        </PromptInputFooter>
      </PromptInput>
      <div className="mt-1 flex h-7 items-center justify-between px-[5px]">
        {isSide ? (
          <span className="px-2 text-muted-foreground text-xs">Side chat · not saved</span>
        ) : (
          <ProjectSelector />
        )}
        <ContextMeter />
      </div>
    </div>
  );
}
