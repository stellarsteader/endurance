/** Progress, rate and time-left wording for model downloads. Pure, so every surface says the same thing. */
import type { ModelDownload } from "./types";

export interface DownloadEntry extends ModelDownload {
  /** Smoothed bytes per second, measured in the renderer. */
  rate?: number;
}

/** Totals for one download or several together. Estimates appear only once they mean something. */
export function downloadProgress(list: DownloadEntry[]) {
  let total = 0;
  let completed = 0;
  let rate = 0;
  let measured = false;
  let finishing = list.length > 0;
  for (const entry of list) {
    // Runtimes reveal layer totals as they go, so the expected size keeps the bar from jumping back.
    const size = Math.max(entry.progress.total ?? 0, entry.expected);
    total += size;
    completed += Math.min(entry.progress.completed ?? 0, size || Infinity);
    if (entry.rate !== undefined) {
      rate += entry.rate;
      measured = true;
    }
    // After the last byte Ollama verifies digests and writes the manifest, reporting no sizes.
    const { status, completed: done = 0, total: reported = 0 } = entry.progress;
    if (!(status === "preparing" && done > 0 && done >= reported)) finishing = false;
  }
  const percent = total ? Math.min(finishing ? 100 : 99, Math.floor((completed / total) * 100)) : undefined;
  const remaining = !finishing && measured && rate > 0 && total && completed / total >= 0.01 ? Math.max(0, total - completed) / rate : undefined;
  return { total, completed, percent, rate: measured ? rate : undefined, remaining, finishing };
}

export const formatBytes = (value: number) =>
  value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${Math.round(value / 1024 ** 2)} MB` : `${Math.round(value / 1024)} KB`;

export function formatRemaining(seconds: number) {
  if (seconds < 60) return "Less than a minute left";
  if (seconds < 3600) return `About ${Math.round(seconds / 60)} min left`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `About ${hours} hr${minutes ? ` ${minutes} min` : ""} left`;
}

export function statusLine(list: DownloadEntry[], detailed = true) {
  const progress = downloadProgress(list);
  if (progress.finishing) return "Finishing…";
  if (!progress.completed || progress.percent === undefined) return "Preparing download…";
  return [
    detailed ? `${formatBytes(progress.completed)} of ${formatBytes(progress.total)}` : undefined,
    `${progress.percent}%`,
    detailed && progress.rate ? `${(progress.rate / 1024 ** 2).toFixed(1)} MB/s` : undefined,
    progress.remaining !== undefined ? formatRemaining(progress.remaining) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
