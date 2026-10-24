/**
 * Estimated memory for a local model at a context window, before it is loaded:
 *   memory(window) ≈ weights + kvPerToken × window + overhead
 * What the runtime reported for the same model loaded on this machine replaces the guess where there is any: it is
 * the runtime's own figure, not one read from the system, but it already counts the cache type and compute buffers.
 * Pure, so the renderer can use it.
 */

/** Runtime buffers beyond weights and KV cache when nothing has been reported yet. */
export const ESTIMATE_OVERHEAD = 150_000_000;

/** What the runtime reports that an estimate is built from. */
export interface MemoryFacts {
  /** Model file size in bytes, including any vision projector. */
  weights?: number;
  /** KV cache bytes per token of context. */
  kvPerToken?: number;
  /** The per-token figure assumes every layer keeps the full window (sliding-window layers keep less). */
  kvUpperBound?: boolean;
}

/** The model as it was loaded here: its window and the memory the runtime reported for it. */
export interface ReportedMemory {
  context: number;
  bytes: number;
}

export interface MemoryEstimate {
  bytes: number;
  /** "upper": at most this; "lower": at least this; undefined: about this. */
  bound?: "upper" | "lower";
  /** Built from what the runtime reported for this model loaded here rather than from the formula alone. */
  reported: boolean;
}

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** One report per window, the latest kept. */
function points(reports: readonly ReportedMemory[]) {
  const byContext = new Map<number, number>();
  for (const item of reports) if (valid(item.context) && valid(item.bytes)) byContext.set(item.context, item.bytes);
  return [...byContext].map(([context, bytes]) => ({ context, bytes }));
}

export function estimateMemory(facts: MemoryFacts, context: number, reports: readonly ReportedMemory[] = []): MemoryEstimate | undefined {
  if (!valid(context)) return undefined;
  const known = points(reports);
  const exact = known.find((item) => item.context === context);
  if (exact) return { bytes: exact.bytes, reported: true };
  if (known.length >= 2) {
    // Least-squares line through the reports: memory grows linearly with the window.
    const meanX = known.reduce((sum, item) => sum + item.context, 0) / known.length;
    const meanY = known.reduce((sum, item) => sum + item.bytes, 0) / known.length;
    const spread = known.reduce((sum, item) => sum + (item.context - meanX) ** 2, 0);
    const slope = known.reduce((sum, item) => sum + (item.context - meanX) * (item.bytes - meanY), 0) / spread;
    if (valid(slope)) return { bytes: Math.round(meanY + slope * (context - meanX)), reported: true };
  }
  const slope = valid(facts.kvPerToken) ? facts.kvPerToken : undefined;
  if (known.length && slope) {
    // One point reported here, the formula's slope from it.
    const nearest = known.reduce((best, item) => (Math.abs(item.context - context) < Math.abs(best.context - context) ? item : best));
    const bytes = Math.round(nearest.bytes + slope * (context - nearest.context));
    return { bytes, reported: true, bound: facts.kvUpperBound ? (context > nearest.context ? "upper" : "lower") : undefined };
  }
  if (!slope || !valid(facts.weights)) return undefined;
  return { bytes: Math.round(facts.weights + slope * context + ESTIMATE_OVERHEAD), reported: false, bound: facts.kvUpperBound ? "upper" : undefined };
}

/** Keeps the last few reports, one per window, newest last. */
export function addReport(reports: readonly ReportedMemory[], next: ReportedMemory, keep = 4): ReportedMemory[] {
  return [...reports.filter((item) => item.context !== next.context), next].slice(-keep);
}
