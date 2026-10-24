/**
 * Model downloads owned by the main process, so they outlive the settings page and renderer reloads.
 * Each window sees only the downloads it started. Electron-free so it can be tested directly.
 */
import type { RuntimeId } from "../../lib/models";
import { hasControl } from "./huggingface";
import type { DownloadDisplay, HFProgress, ModelDownload } from "./types";

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() && value.length <= max && !hasControl(value) ? value : undefined;

/** Display fields come from the renderer: bounded strings and a byte count, nothing else. */
export function validDisplay(value: unknown): DownloadDisplay {
  const input = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const key = text(input.key, 300);
  const label = text(input.label, 300);
  const name = text(input.name, 120);
  const expected = typeof input.expected === "number" && Number.isSafeInteger(input.expected) && input.expected >= 0 ? input.expected : 0;
  if (!key || !label || !name) throw new Error("Invalid download details.");
  return { key, label, name, expected };
}

export class DownloadRegistry<Owner> {
  private items = new Map<string, { owner: Owner; download: ModelDownload }>();
  private timers = new Map<Owner, ReturnType<typeof setTimeout>>();

  constructor(
    private send: (owner: Owner, downloads: ModelDownload[]) => void,
    // Progress lines arrive per layer chunk; a window needs only a few updates a second.
    private interval = 120,
    private now = Date.now,
  ) {}

  list(owner: Owner): ModelDownload[] {
    return [...this.items.values()].filter((item) => item.owner === owner).map((item) => ({ ...item.download, progress: { ...item.download.progress } }));
  }

  /** Registers the download, then runs it in the background. The returned promise settles when it ends. */
  start(
    owner: Owner,
    id: string,
    target: { runtime: RuntimeId; connectionId: string; connectionLabel: string },
    display: DownloadDisplay,
    run: (progress: (value: HFProgress) => void) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.items.has(id)) throw new Error("Invalid request ID");
    if ([...this.items.values()].some((item) => item.owner === owner && item.download.state === "active" && item.download.key === display.key))
      throw new Error(`${display.label} is already downloading.`);
    const download: ModelDownload = { ...display, ...target, id, state: "active", progress: { status: "preparing" }, startedAt: this.now() };
    this.items.set(id, { owner, download });
    this.publish(owner, true);
    return run((value) => {
      if (download.state !== "active") return;
      download.progress = { ...value };
      if (value.model) download.model = value.model;
      this.publish(owner, false);
    }).then(
      () => {
        download.state = "completed";
        download.progress = { ...download.progress, status: "completed", done: true };
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "Download failed";
        // A cancel is silent unless the runtime may keep downloading without us.
        download.state = signal.aborted ? "cancelled" : "failed";
        if (!signal.aborted || /may continue/.test(message)) download.error = message;
      },
    ).finally(() => this.publish(owner, true));
  }

  /** Removes a finished download once the window has shown its outcome. Active downloads stay. */
  dismiss(owner: Owner, id: string) {
    const item = this.items.get(id);
    if (!item || item.owner !== owner || item.download.state === "active") return;
    this.items.delete(id);
    this.publish(owner, true);
  }

  /** The window is gone: its downloads were cancelled with it. */
  forget(owner: Owner) {
    for (const [id, item] of this.items) if (item.owner === owner) this.items.delete(id);
    clearTimeout(this.timers.get(owner));
    this.timers.delete(owner);
  }

  active(): ModelDownload[] {
    return [...this.items.values()].filter((item) => item.download.state === "active").map((item) => item.download);
  }

  private publish(owner: Owner, immediate: boolean) {
    const pending = this.timers.get(owner);
    if (immediate) {
      clearTimeout(pending);
      this.timers.delete(owner);
      this.send(owner, this.list(owner));
      return;
    }
    if (pending) return;
    this.timers.set(
      owner,
      setTimeout(() => {
        this.timers.delete(owner);
        this.send(owner, this.list(owner));
      }, this.interval),
    );
  }
}
