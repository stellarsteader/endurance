/**
 * Undoing the agent's edits to files, in the chat worker (lib/file-undo has the rules). Files are put back through
 * the project's Workspace, so a folder now Read only or No access, or a secrets file, is skipped as it would be
 * refused to the agent. Copies are read through FileCopies, from the main process (./file-copies).
 */
import { AccessDenied, Workspace } from "./workspace-tools";
import { contentHash, fileCopies, rewinding, setFileCopies, type FileCopies } from "./file-copies";
import { ABSENT, cleanUndo, type FileUndo, type UndoResult, type UndoSkip } from "../lib/file-undo";
import { sanitizePolicy } from "../lib/workspace-policy";

/** Puts back each file as it was at the start of its steps, or skips it with the reason. One file at a time. */
export async function undoEdits(workspace: Workspace, files: FileUndo[], copies: FileCopies | undefined = fileCopies()): Promise<UndoResult[]> {
  const results: UndoResult[] = [];
  for (const file of files) results.push(await undoFile(workspace, file, copies));
  return results;
}

async function undoFile(workspace: Workspace, { path, steps }: FileUndo, copies: FileCopies | undefined): Promise<UndoResult> {
  const skip = (reason: UndoSkip, detail?: string): UndoResult => ({ path, outcome: "skipped", reason, ...(detail ? { detail } : {}) });
  const first = steps[0];
  const last = steps.at(-1);
  if (!first || !last?.after || steps.some((step) => !step.after)) return skip("no-copy");
  // Changed by someone else between two of the agent's changes: going back to the first would lose that change too.
  // A change to a missing file (one the agent deleted) starts from ABSENT.
  for (let index = 1; index < steps.length; index++) if ((steps[index].beforeHash ?? ABSENT) !== steps[index - 1].after) return skip("changed");
  const copy = first.before;
  if (copy === undefined) return skip("no-copy");
  try {
    const outcome = await workspace.putBack(path, last.after, async () => {
      if (copy === null) return null;
      const bytes = await copies?.read(copy);
      // A copy that is not the file the change started from is not put back.
      return bytes && first.beforeHash && contentHash(bytes) === first.beforeHash ? bytes : undefined;
    });
    if (outcome === "changed") return skip("changed");
    if (outcome === "missing") return skip("copy-missing");
    return { path, outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return skip(error instanceof AccessDenied ? "blocked" : "failed", message.slice(0, 300));
  }
}

/** The worker's questions to the main process about copies, and the answers (electron/file-undo-ipc). */
type CopyQuestion = { op: "save"; bytes: Uint8Array; ref?: undefined } | { op: "read"; ref: string; bytes?: undefined };
export type CopyAsk = { type: "file-copy"; request: number } & CopyQuestion;
export type CopyAnswer = { type: "file-copy"; request: number } & ({ ok: true; ref?: string; bytes?: Uint8Array } | { ok: false; error: string });
/** An undo the main process asks for: the chat, the project's folder access as the main process resolved it, and the files. */
export type UndoJob = { id: string; type: "undo-edits"; body: string };
export type UndoEvent = { id: string; type: "undone"; results: UndoResult[] } | { id: string; type: "undo-failed"; message: string };

/**
 * The chat worker's side: keeps copies through the main process, which holds the key, and runs undo jobs. `handle`
 * takes the main process's answers and jobs, and is false for any other message.
 */
export function fileUndoWorker(post: (message: CopyAsk | UndoEvent) => void) {
  const asked = new Map<number, (answer: CopyAnswer) => void>();
  let questions = 0;
  const ask = async (question: CopyQuestion) => {
    const request = ++questions;
    const answer = await new Promise<CopyAnswer>((resolve) => {
      asked.set(request, resolve);
      post({ ...question, type: "file-copy", request });
    });
    if (!answer.ok) throw new Error(answer.error);
    return answer;
  };
  setFileCopies({
    save: async (bytes) => {
      const { ref } = await ask({ op: "save", bytes });
      if (!ref) throw new Error("The copy was not kept.");
      return ref;
    },
    read: async (ref) => (await ask({ op: "read", ref })).bytes,
  });
  const run = async (job: UndoJob) => {
    try {
      const request = JSON.parse(job.body) as { chatId?: unknown; workspace?: unknown; files?: unknown };
      const files = cleanUndo(request.files);
      const workspace = new Workspace(sanitizePolicy(request.workspace));
      const results = await rewinding(typeof request.chatId === "string" ? request.chatId : "", () => undoEdits(workspace, files));
      post({ id: job.id, type: "undone", results });
    } catch (error) {
      post({ id: job.id, type: "undo-failed", message: error instanceof Error ? error.message : "The edits could not be undone." });
    }
  };
  return {
    handle(data: { type?: string }) {
      if (data.type === "file-copy") {
        const answer = data as CopyAnswer;
        asked.get(answer.request)?.(answer);
        asked.delete(answer.request);
        return true;
      }
      if (data.type === "undo-edits") {
        void run(data as UndoJob);
        return true;
      }
      return false;
    },
  };
}
