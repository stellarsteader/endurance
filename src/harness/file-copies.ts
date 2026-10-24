/**
 * Copies of files from before the agent changed them, so rewinding a chat can undo the agent's edits. The worker
 * never holds the history key: it keeps and reads copies through FileCopies, which asks the main process. A copy is encrypted and named like an attached document (src/history/attachment-folder), and an edit
 * names it as `attachment:<id>`, so a key rotation renames it in the messages and the sweep of unnamed files removes
 * it with the messages that named it.
 *
 * Undoing and the agent's own writes never interleave in one chat: an undo waits for writes under way, and a run
 * that started before it can no longer write (rewinding, agentWrite).
 */
import { createHash } from "node:crypto";
import { currentCall } from "./limit";

export interface FileCopies {
  /** Keeps the bytes; returns the `attachment:<id>` that names them. */
  save(bytes: Uint8Array): Promise<string>;
  /** The kept bytes, or nothing when they are no longer kept. */
  read(ref: string): Promise<Uint8Array | undefined>;
}

/** The largest file kept before an edit; a larger one is changed without a copy, and says so. */
export const MAX_COPY = 16 * 1024 * 1024;

let kept: FileCopies | undefined;
/** Where copies are kept in this process: the chat worker sets the main process's at start. */
export function setFileCopies(copies: FileCopies | undefined) {
  kept = copies;
}
export const fileCopies = () => kept;

/** SHA-256 of a file's bytes, to tell later whether it still holds what the agent wrote. */
export const contentHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Keeps a file's bytes before a change. Nothing when no copy can be kept: none is set here, it is too large, or the history is locked. */
export async function keepCopy(bytes: Uint8Array): Promise<string | undefined> {
  if (!kept || bytes.byteLength > MAX_COPY) return undefined;
  try {
    return await kept.save(bytes);
  } catch {
    return undefined;
  }
}

let sequence = 0;
/** A number that only grows: tells which runs started before an undo. */
export const nextSequence = () => ++sequence;
/** Per chat, when it was last rewound. */
const rewound = new Map<string, number>();
/** Per chat, the agent's writes under way. */
const writing = new Map<string, Set<Promise<unknown>>>();
const chatOf = () => currentCall()?.chat ?? "";

/**
 * Runs one of the agent's changes to a file. `started` is when its run's Workspace was made: a run from before the
 * chat was rewound is refused, so a stopped run cannot write over files just put back.
 */
export async function agentWrite<T>(started: number, work: () => Promise<T>): Promise<T> {
  const chat = chatOf();
  if ((rewound.get(chat) ?? 0) > started) throw new Error("This conversation was rewound, so the change was not made.");
  let pending = writing.get(chat);
  if (!pending) writing.set(chat, (pending = new Set()));
  const write = work();
  pending.add(write);
  try {
    return await write;
  } finally {
    pending.delete(write);
  }
}

/** Runs an undo for a chat after the agent's writes under way have finished; its runs from before can no longer write. */
export async function rewinding<T>(chat: string, work: () => Promise<T>): Promise<T> {
  rewound.set(chat, nextSequence());
  await Promise.allSettled([...(writing.get(chat) ?? [])]);
  return work();
}
