/**
 * Undoing the agent's edits to files (src/lib/file-undo). The chat worker keeps a copy of each file before the agent
 * changes it; the copies are encrypted by the history thread like attached documents, so the worker asks this
 * process to keep and read them (answerCopy) and never holds the key. An undo is asked for by the renderer with the
 * chat's edit references; the project's folder access comes from here, never from the renderer, and the worker puts
 * the files back through the same checks as the agent's writes.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type UtilityProcess } from "electron";
import { history } from "./history-ipc";
import { projectPolicy } from "./workspace-ipc";
import { cleanUndo, type UndoResult } from "../src/lib/file-undo";
import { attachmentId, attachmentUrl } from "../src/lib/attachments";
import { MAX_COPY } from "../src/harness/file-copies";
import type { CopyAnswer, CopyAsk, UndoEvent, UndoJob } from "../src/harness/restore";

const undoing = new Map<string, { resolve: (results: UndoResult[]) => void; reject: (error: Error) => void }>();

/** Keeps or reads a copy for the chat worker. */
async function answerCopy(ask: CopyAsk): Promise<CopyAnswer> {
  const reply = { type: "file-copy" as const, request: ask.request };
  try {
    if (ask.op === "save") {
      if (!(ask.bytes instanceof Uint8Array) || ask.bytes.byteLength > MAX_COPY) throw new Error("Invalid copy");
      const { id } = await history("saveAttachment", ask.bytes);
      return { ...reply, ok: true, ref: attachmentUrl(id) };
    }
    const id = typeof ask.ref === "string" ? attachmentId(ask.ref) : undefined;
    if (!id) throw new Error("Invalid copy");
    return { ...reply, ok: true, bytes: await history("readAttachment", id) };
  } catch (error) {
    return { ...reply, ok: false, error: error instanceof Error ? error.message : "The copy could not be kept." };
  }
}

/** Messages from the chat worker about copies and undo jobs; false for every other message. */
export function routeFileUndo(event: { type: string }, child: UtilityProcess) {
  if (event.type === "file-copy") {
    void answerCopy(event as CopyAsk).then((answer) => child.postMessage(answer));
    return true;
  }
  if (event.type === "undone" || event.type === "undo-failed") {
    const done = event as UndoEvent;
    const waiting = undoing.get(done.id);
    undoing.delete(done.id);
    if (done.type === "undone") waiting?.resolve(done.results);
    else waiting?.reject(new Error(done.message));
    return true;
  }
  return false;
}

export function registerFileUndoIPC(trusted: (event: IpcMainInvokeEvent | IpcMainEvent) => void, engine: () => UtilityProcess) {
  ipcMain.handle("chat:undo-edits", async (event, chatId: unknown, projectId: unknown, files: unknown) => {
    trusted(event);
    if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) throw new Error("Invalid chat");
    const clean = cleanUndo(files);
    // A chat outside a project has no folders: each file is skipped as not writable.
    const workspace = (await projectPolicy(projectId)) ?? { folders: [], rules: [] };
    const child = engine();
    const id = crypto.randomUUID();
    return new Promise<UndoResult[]>((resolve, reject) => {
      const stopped = () => {
        undoing.delete(id);
        reject(new Error("The local chat process stopped part way. Some files may already be back; check them before trying again."));
      };
      child.once("exit", stopped);
      undoing.set(id, {
        resolve: (results) => {
          child.off("exit", stopped);
          resolve(results);
        },
        reject: (error) => {
          child.off("exit", stopped);
          reject(error);
        },
      });
      child.postMessage({ id, type: "undo-edits", body: JSON.stringify({ chatId, workspace, files: clean }) } satisfies UndoJob);
    });
  });
}
