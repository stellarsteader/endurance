/**
 * Undoing the agent's edits to files. Each edit_file result names a copy of the file from before
 * the change and the hash of what the agent wrote (EditFileOutput). To undo a file from some point in a chat, the
 * earliest copy from that point is put back, only while the file still holds what the agent last wrote; a file the
 * agent created is deleted on the same condition, and a file it deleted is put back while it is still gone. Anything
 * else is skipped with a reason, never guessed. Commands
 * the agent ran are not undone. The chat worker does the work (src/harness/restore); this is shared with the renderer.
 */
import type { EditFileOutput } from "./types";

/** What a change left when it deleted the file, in place of the hash of what it wrote. */
export const ABSENT = "absent";

/** One change to a file, as undoing needs it. */
export interface UndoStep {
  before?: string | null;
  beforeHash?: string;
  after?: string;
}

/** A file's changes from the chosen point on, oldest first. */
export interface FileUndo {
  path: string;
  steps: UndoStep[];
}

/**
 * Why a file was left as it is: it changed since the agent's edit, no copy was kept (an older chat, or the copy
 * could not be saved), the copy is no longer kept, its folder no longer lets the agent write it, or putting it
 * back failed.
 */
export type UndoSkip = "changed" | "no-copy" | "copy-missing" | "blocked" | "failed";

export interface UndoResult {
  path: string;
  outcome: "restored" | "deleted" | "skipped";
  reason?: UndoSkip;
  /** For "blocked" and "failed": what the check or the file system said. */
  detail?: string;
}

/** The most files one undo takes, and changes per file. */
export const MAX_UNDO_FILES = 500;
const MAX_STEPS = 2000;
const COPY = /^attachment:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;

/** The undo for each file these changes touched, by the path the tools showed, oldest change first. */
export function undoPlan(edits: Iterable<EditFileOutput>): FileUndo[] {
  const files = new Map<string, UndoStep[]>();
  for (const edit of edits) {
    const steps = files.get(edit.path) ?? [];
    steps.push({
      ...(edit.before !== undefined ? { before: edit.before } : {}),
      ...(edit.beforeHash ? { beforeHash: edit.beforeHash } : {}),
      ...(edit.after ? { after: edit.after } : {}),
    });
    files.set(edit.path, steps);
  }
  return [...files].map(([path, steps]) => ({ path, steps }));
}

/** Whether undoing a file can be tried: a copy was kept (or the agent created it) and every change says what it wrote. */
export const undoable = (file: FileUndo) => file.steps.length > 0 && file.steps[0].before !== undefined && file.steps.every((step) => Boolean(step.after));

/** An undo request as sent across processes, checked field by field; throws on anything else. */
export function cleanUndo(value: unknown): FileUndo[] {
  const invalid = () => new Error("Invalid undo request");
  if (!Array.isArray(value) || value.length > MAX_UNDO_FILES) throw invalid();
  const seen = new Set<string>();
  return value.map((file: { path?: unknown; steps?: unknown }) => {
    const path = file?.path;
    if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || seen.has(path)) throw invalid();
    seen.add(path);
    if (!Array.isArray(file.steps) || !file.steps.length || file.steps.length > MAX_STEPS) throw invalid();
    const steps = file.steps.map((step: UndoStep) => {
      if (!step || typeof step !== "object") throw invalid();
      const { before, beforeHash, after } = step;
      if (before !== undefined && before !== null && !(typeof before === "string" && COPY.test(before))) throw invalid();
      if (beforeHash !== undefined && !(typeof beforeHash === "string" && HASH.test(beforeHash))) throw invalid();
      if (after !== undefined && !(typeof after === "string" && (HASH.test(after) || after === ABSENT))) throw invalid();
      return { ...(before !== undefined ? { before } : {}), ...(beforeHash ? { beforeHash } : {}), ...(after ? { after } : {}) };
    });
    return { path, steps };
  });
}

/** How many files were put back (restored or deleted) and how many were left. */
export function undoCounts(results: UndoResult[]) {
  const undone = results.filter((result) => result.outcome !== "skipped").length;
  return { undone, skipped: results.length - undone };
}
