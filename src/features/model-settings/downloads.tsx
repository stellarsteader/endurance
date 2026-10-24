/**
 * Renderer view of main-process model downloads. Every surface (Models page, settings nav, sidebar)
 * reads the same store, so leaving a page never hides or stops a download.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ArrowDownToLineIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { ipcMessage } from "../../lib/desktop";
import { useStore } from "../../lib/store";
import { cn } from "../../lib/utils";
import { downloadProgress, statusLine, type DownloadEntry } from "./download-progress";
import type { DownloadDisplay, HFDownloadRequest, ModelDownload, OllamaPullRequest } from "./types";

export { downloadProgress } from "./download-progress";

export type DownloadRequest =
  | { kind: "huggingface"; input: HFDownloadRequest; display: DownloadDisplay }
  | { kind: "ollama"; input: OllamaPullRequest; display: DownloadDisplay };
export interface InstallFocus {
  connectionId: string;
  model: string;
  name: string;
}

let entries: DownloadEntry[] = [];
let active: DownloadEntry[] = [];
let focus: InstallFocus | null = null;
const listeners = new Set<() => void>();
const samples = new Map<string, { at: number; completed: number }>();
// Kept so a failed download can be retried; lost on reload, which only removes the Retry action.
const requests = new Map<string, DownloadRequest>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function applyDownloads(list: ModelDownload[], now = Date.now()) {
  const previous = new Map(entries.map((entry) => [entry.id, entry]));
  entries = list.map((download) => {
    let rate = previous.get(download.id)?.rate;
    const completed = download.progress.completed;
    const sample = samples.get(download.id);
    if (completed !== undefined) {
      if (!sample) samples.set(download.id, { at: now, completed });
      else if (now - sample.at >= 500) {
        const value = ((completed - sample.completed) / (now - sample.at)) * 1000;
        if (value >= 0) rate = rate === undefined ? value : rate * 0.6 + value * 0.4;
        samples.set(download.id, { at: now, completed });
      }
    }
    return { ...download, rate };
  });
  for (const id of samples.keys()) if (!list.some((download) => download.id === id)) samples.delete(id);
  active = entries.filter((entry) => entry.state === "active");
  emit();
}

export const useDownloads = () => useSyncExternalStore(subscribe, () => active, () => active);
export const useInstallFocus = () => useSyncExternalStore(subscribe, () => focus, () => focus);
export function clearInstallFocus() {
  if (!focus) return;
  focus = null;
  emit();
}
function setInstallFocus(value: InstallFocus) {
  focus = value;
  emit();
}

export async function startDownload(request: DownloadRequest) {
  const api = window.enduranceModels;
  if (!api) return;
  const id = crypto.randomUUID();
  requests.set(id, request);
  try {
    if (request.kind === "huggingface") await api.downloadHuggingFace(id, request.input, request.display);
    else await api.pullOllama(id, request.input, request.display);
  } catch (cause) {
    requests.delete(id);
    toast.error(`Couldn't start ${request.display.label}`, { description: cause instanceof Error ? ipcMessage(cause) : undefined });
  }
}

export const cancelDownload = (id: string) => window.enduranceModels?.cancel(id);

export function ProgressBar({ list, label, className }: { list: DownloadEntry[]; label: string; className?: string }) {
  const { percent, finishing } = downloadProgress(list);
  const known = percent !== undefined && !finishing;
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={known ? percent : undefined}
      className={cn("h-1 min-w-0 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
    >
      <div
        className={cn("h-full rounded-full bg-foreground transition-[width] duration-300 ease-out", !known && "w-1/4 animate-pulse")}
        style={known ? { width: `${Math.max(percent, 2)}%` } : undefined}
      />
    </div>
  );
}

/** A small ring for tight spaces such as a navigation row. */
export function ProgressRing({ list, className }: { list: DownloadEntry[]; className?: string }) {
  const { percent, finishing } = downloadProgress(list);
  const known = percent !== undefined && !finishing;
  const circumference = 2 * Math.PI * 5.25;
  return (
    <svg aria-hidden className={cn("size-3.5 shrink-0 -rotate-90", !known && "animate-spin", className)} viewBox="0 0 14 14">
      <circle cx="7" cy="7" fill="none" opacity="0.2" r="5.25" stroke="currentColor" strokeWidth="1.75" />
      <circle
        className="transition-[stroke-dashoffset] duration-300 ease-out"
        cx="7"
        cy="7"
        fill="none"
        r="5.25"
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - (known ? percent : 25) / 100)}
        strokeLinecap="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

/** Bar, cancel and status for one download, used inside its search result or the list below. */
export function DownloadProgress({ entry }: { entry: DownloadEntry }) {
  return (
    <div aria-label={`Downloading ${entry.label}`} className="space-y-1.5" role="group">
      <div className="flex items-center gap-3">
        <ProgressBar className="flex-1" label={`${entry.label} download progress`} list={[entry]} />
        <Button className="-my-1 h-7 shrink-0 rounded-[6px] text-[12px]" onClick={() => cancelDownload(entry.id)} type="button" variant="ghost">
          {/* LM Studio has no cancel endpoint; it may keep downloading after we stop watching. */}
          {entry.runtime === "lmstudio" ? "Stop tracking" : "Cancel"}
        </Button>
      </div>
      <p className="text-[12px] leading-[1.35] text-muted-foreground tabular-nums" role="status">
        {statusLine([entry])}
      </p>
    </div>
  );
}

/**
 * Downloads the current results do not show, such as after leaving the page or a new search.
 * A download whose result is on screen shows its progress in that row instead.
 */
export function ActiveDownloads({ shown }: { shown: string[] }) {
  const list = useDownloads().filter((entry) => !shown.includes(entry.key));
  if (!list.length) return null;
  return (
    <>
      {list.map((entry) => (
        <div className="space-y-2.5 p-3" key={entry.id}>
          <div className="flex items-center gap-3">
            <ArrowDownToLineIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 truncate text-[13px] leading-[1.4]">{entry.label}</div>
            <span className="shrink-0 text-[12px] leading-[1.35] text-muted-foreground">To {entry.connectionLabel}</span>
          </div>
          <DownloadProgress entry={entry} />
        </div>
      ))}
    </>
  );
}

/** Shown in the sidebar while a download runs anywhere but on the Models page. */
export function SidebarDownloads({ onOpen }: { onOpen: () => void }) {
  const list = useDownloads();
  if (!list.length) return null;
  const title = list.length === 1 ? list[0].label : `${list.length} downloads`;
  const status = statusLine(list, false);
  return (
    <div className="shrink-0 px-2 pb-2">
      <button
        aria-label={`${title}, ${status}. Open Models settings`}
        className="w-full space-y-1.5 rounded-[8px] border bg-card px-2.5 py-2 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onOpen}
        type="button"
      >
        <div className="flex items-center gap-2">
          <ArrowDownToLineIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4]">{title}</span>
        </div>
        <ProgressBar label={`${title} download progress`} list={list} />
        <p className="truncate text-[12px] leading-[1.35] text-muted-foreground tabular-nums">{status}</p>
      </button>
    </div>
  );
}

/** Keeps the store in step with the main process and reports each outcome once, wherever the person is. */
export function DownloadsSync() {
  const { refreshModels, settingsSection, setSettingsSection } = useStore();
  const latest = useRef({ refreshModels, settingsSection, setSettingsSection });
  useEffect(() => {
    latest.current = { refreshModels, settingsSection, setSettingsSection };
  }, [refreshModels, settingsSection, setSettingsSection]);
  useEffect(() => {
    const api = window.enduranceModels;
    if (!api) return;
    const handled = new Set<string>();
    const receive = (list: ModelDownload[]) => {
      applyDownloads(list);
      for (const download of list) {
        if (download.state === "active" || handled.has(download.id)) continue;
        handled.add(download.id);
        report(download, latest.current);
        api.dismissDownload(download.id);
      }
    };
    const off = api.onDownloads(receive);
    // After a reload, pick up downloads that kept running in the main process.
    void api.downloads().then(receive).catch(() => undefined);
    return off;
  }, []);
  return null;
}

function report(
  download: ModelDownload,
  { refreshModels, settingsSection, setSettingsSection }: { refreshModels: () => void; settingsSection: string | null; setSettingsSection: (section: string | null) => void }
) {
  const request = requests.get(download.id);
  requests.delete(download.id);
  if (download.state === "completed") {
    refreshModels();
    const installed = { connectionId: download.connectionId, model: download.model ?? "", name: download.name };
    const description = `Installed in ${download.connectionLabel}.`;
    // On the Models page its settings open in place; elsewhere the toast offers to go there.
    if (settingsSection === "models") {
      setInstallFocus(installed);
      toast.success(`${download.label} is ready`, { description });
    } else
      toast.success(`${download.label} is ready`, {
        description,
        duration: 10_000,
        action: {
          label: "Set up",
          onClick: () => {
            setInstallFocus(installed);
            setSettingsSection("models");
          },
        },
      });
  } else if (download.state === "failed")
    toast.error(`Couldn't download ${download.label}`, {
      description: download.error,
      duration: 15_000,
      ...(request ? { action: { label: "Retry", onClick: () => void startDownload(request) } } : {}),
    });
  else if (download.error) toast(`Stopped tracking ${download.label}`, { description: download.error });
}
