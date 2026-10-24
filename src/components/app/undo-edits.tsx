"use client";

import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint";
import { usePromptInputController } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { agentEdits } from "@/lib/derive";
import { ipcMessage } from "@/lib/desktop";
import { undoable, undoCounts, undoPlan, type FileUndo, type UndoResult, type UndoSkip } from "@/lib/file-undo";
import type { EditFileOutput } from "@/lib/types";
import { RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "./session-context";

/** How long a stopped reply may take to end before a rewind gives up, touching nothing. */
const STOP_WAIT_MS = 10_000;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const SKIPPED: Record<UndoSkip, string> = {
  changed: "Changed since the agent's edit",
  "no-copy": "No copy was kept from before the edit",
  "copy-missing": "The kept copy is gone",
  blocked: "The folder doesn't allow writing it now",
  failed: "Couldn't be put back",
};

/** What was undone, with the skipped files and why on demand. */
function report(results: UndoResult[]) {
  const { undone, skipped } = undoCounts(results);
  const title = undone ? `Undid the agent's edits to ${plural(undone, "file")}` : "No files were changed";
  const left = results.filter((result) => result.outcome === "skipped");
  const list = (
    <ul className="mt-1 space-y-1">
      {left.map((result) => (
        <li key={result.path}>
          <span className="font-mono text-[11px]">{result.path}</span>
          <span className="block text-muted-foreground">{result.detail ?? SKIPPED[result.reason ?? "failed"]}</span>
        </li>
      ))}
    </ul>
  );
  const id = toast(title, {
    description: skipped ? `${plural(skipped, "file")} left as they are.` : undefined,
    action: skipped
      ? {
          label: "Show",
          onClick: (event) => {
            // Keeps the toast open, now listing the files.
            event.preventDefault();
            toast(title, { id, description: list, action: undefined, closeButton: true, duration: 30_000 });
          },
        }
      : undefined,
  });
}

/**
 * Stops the chat's reply and waits until it has ended, so no write of the agent's races the undo; the worker also
 * waits for writes under way and refuses later ones from the stopped run (src/harness/file-copies).
 */
function useUndo() {
  const { chat, busy, thread } = useSession();
  const latest = useRef({ busy, messages: chat.messages });
  useEffect(() => {
    latest.current = { busy, messages: chat.messages };
  });
  const stop = useCallback(async () => {
    if (!latest.current.busy) return true;
    await chat.stop();
    for (let waited = 0; latest.current.busy; waited += 50) {
      if (waited >= STOP_WAIT_MS) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }, [chat]);
  const undo = useCallback(
    async (files: FileUndo[]) => {
      const desktop = window.endurance;
      if (!desktop) return false;
      try {
        report(await desktop.undoEdits(thread.id, thread.projectId, files));
        return true;
      } catch (error) {
        toast.error("Couldn't undo the agent's edits", { description: error instanceof Error ? ipcMessage(error) : undefined });
        return false;
      }
    },
    [thread.id, thread.projectId]
  );
  return { stop, undo, latest };
}

/** Undoing needs the desktop app; without it there is nothing that could put files back. */
const canUndo = () => typeof window !== "undefined" && Boolean(window.endurance);

function FileList({ files }: { files: FileUndo[] }) {
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-[6px] border bg-muted/30 px-2.5 py-2 font-mono text-[11px] leading-[1.5]">
      {files.map((file) => (
        <li className="truncate" key={file.path} title={file.path}>
          {file.path}
          {!undoable(file) && <span className="font-sans text-muted-foreground"> · no copy kept, stays as is</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Rewinds the conversation to before a message. When the agent changed files after it, asks first whether to undo
 * those changes too; without any, it rewinds at once.
 */
export function RewindCheckpoint({ index, text }: { index: number; text: string }) {
  const { chat } = useSession();
  const { setInput } = usePromptInputController().textInput;
  const { stop, undo, latest } = useUndo();
  // The files changed after this message, read when the checkpoint is clicked; the dialog is open while set.
  const [files, setFiles] = useState<FileUndo[]>();
  const [working, setWorking] = useState<"conversation" | "files">();
  const ready = files?.filter(undoable).length ?? 0;

  const rewind = async (alsoFiles: boolean) => {
    setWorking(alsoFiles ? "files" : "conversation");
    try {
      if (!(await stop())) {
        toast.error("The reply didn't stop, so nothing was rewound.");
        return;
      }
      // Read again after stopping: the reply may have changed more files before it ended.
      const messages = latest.current.messages;
      if (alsoFiles && !(await undo(undoPlan(agentEdits(messages.slice(index)))))) return;
      chat.setMessages(messages.slice(0, index));
      setInput(text);
      setFiles(undefined);
    } finally {
      setWorking(undefined);
    }
  };

  return (
    <>
      <Checkpoint className="opacity-60 transition-opacity hover:opacity-100">
        <CheckpointIcon className="size-3.5" />
        <CheckpointTrigger
          className="h-6 px-1.5 text-xs"
          onClick={() => {
            const changed = canUndo() ? undoPlan(agentEdits(chat.messages.slice(index))) : [];
            if (changed.length) setFiles(changed);
            else void rewind(false);
          }}
          tooltip="Rewind the conversation to before this message"
        >
          Restore checkpoint
        </CheckpointTrigger>
      </Checkpoint>
      {files && (
        <Dialog onOpenChange={(next) => !next && !working && setFiles(undefined)} open>
          <DialogContent className="gap-4 rounded-[12px] sm:max-w-[30rem]">
            <DialogHeader>
              <DialogTitle className="text-[15px] leading-[1.6]">Rewind to this message?</DialogTitle>
              <DialogDescription className="text-[12px] leading-[1.45]">
                After this message the agent changed {plural(files.length, "file")}. Each file goes back only if it still holds what the agent
                wrote; any other is left as it is.
              </DialogDescription>
            </DialogHeader>
            <FileList files={files} />
            <p className="text-[12px] leading-[1.45] text-muted-foreground">Commands the agent ran are not undone.</p>
            <DialogFooter>
              <Button className="h-7 rounded-[6px] text-[12px]" disabled={Boolean(working)} onClick={() => void rewind(false)} variant="ghost">
                Conversation only
              </Button>
              {ready > 0 && (
                <Button className="h-7 rounded-[6px] text-[12px]" disabled={Boolean(working)} onClick={() => void rewind(true)}>
                  {working === "files" ? "Undoing…" : `Also undo the agent's edits to ${plural(ready, "file")}`}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** Undone in this session, by chat, file and the agent's last write, so the action is not offered again for it. */
const undoneHere = new Set<string>();

/** The Changes tab's undo for one file: back to how it was before the agent's first change to it in this chat. */
export function UndoFileEdits({ path, changes }: { path: string; changes: EditFileOutput[] }) {
  const { thread, busy, pendingApproval } = useSession();
  const { undo } = useUndo();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [, setUndone] = useState(0);
  const file = useMemo(() => undoPlan(changes)[0], [changes]);
  const key = `${thread.id}\0${path}\0${changes.at(-1)?.after ?? ""}`;
  if (!canUndo() || !file || !undoable(file)) return null;
  const done = undoneHere.has(key);

  const run = async () => {
    setWorking(true);
    try {
      if (await undo([file])) {
        undoneHere.add(key);
        setUndone((count) => count + 1);
        setOpen(false);
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <Button
        className="ml-auto h-6 gap-1 px-1.5 font-sans text-xs text-muted-foreground"
        // While a reply runs or waits for approval the agent may still change the file.
        disabled={done || busy || pendingApproval}
        onClick={() => setOpen(true)}
        size="xs"
        variant="ghost"
      >
        <RotateCcwIcon className="size-3" />
        {done ? "Undone" : "Undo agent edits"}
      </Button>
      {open && (
        <Dialog onOpenChange={(next) => !next && !working && setOpen(false)} open>
          <DialogContent className="gap-4 rounded-[12px] sm:max-w-[28rem]">
            <DialogHeader>
              <DialogTitle className="text-[15px] leading-[1.6]">Undo the agent's edits to this file?</DialogTitle>
              <DialogDescription className="text-[12px] leading-[1.45]">
                <span className="font-mono text-[11px]">{path}</span> goes back to how it was before the agent first changed it in this chat,
                only if it still holds what the agent wrote. The conversation stays as it is.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button className="h-7 rounded-[6px] text-[12px]" disabled={working} onClick={() => setOpen(false)} variant="ghost">
                Cancel
              </Button>
              <Button className="h-7 rounded-[6px] text-[12px]" disabled={working} onClick={() => void run()}>
                {working ? "Undoing…" : "Undo edits"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
