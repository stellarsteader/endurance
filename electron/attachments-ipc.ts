/**
 * Documents attached to chats, kept encrypted by the history thread (src/history/attachment-folder). The renderer
 * hands the bytes over once and never learns a path; the chat worker asks this process for a document's bytes or
 * its kept text (answerAttachment) and never holds the key. The window can ask for a sent document by name to show
 * it, or to have a copy saved where the person chooses.
 */
import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { imageFormat, MAC_IMAGE_FORMATS, MAX_IMAGE } from "../src/lib/attachments";
import type { AttachmentAnswer, AttachmentAsk } from "../src/harness/attachments";
import type { AttachmentRead, AttachmentText } from "../src/lib/desktop";
import { history } from "./history-ipc";
import { attachmentsFolder } from "./vault-key";

/** The largest file a chat takes. */
export const MAX_ATTACHMENT = 200 * 1024 * 1024;
/** The most a window is given to show; a larger document can still be saved as a copy. */
const MAX_PREVIEW = 50 * 1024 * 1024;
/** The version of kept text the chat worker writes (src/harness/attachments VERSION). */
const KEPT_TEXT = "v1";

export function registerAttachmentsIPC(trusted: (event: IpcMainInvokeEvent | IpcMainEvent) => void) {
  ipcMain.handle("attachments:save", (event, name: unknown, mediaType: unknown, data: unknown) => {
    trusted(event);
    if (typeof name !== "string" || !name || name.length > 255 || typeof mediaType !== "string" || mediaType.length > 200) throw new Error("Invalid attachment");
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) throw new Error("Invalid attachment");
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (bytes.byteLength > MAX_ATTACHMENT) throw new Error(`${name} is larger than 200 MB.`);
    return history("saveAttachment", bytes);
  });
  // HEIC and TIFF, which the window cannot decode, become PNG through macOS's own image support.
  // sips reads files only, so the image is written to a private temporary folder for the moment it takes and removed.
  ipcMain.handle("attachments:convert-image", async (event, data: unknown) => {
    trusted(event);
    if (process.platform !== "darwin") throw new Error("Converting this image needs macOS.");
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) throw new Error("Invalid image");
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (bytes.byteLength > MAX_IMAGE) throw new Error("The image is too large.");
    const format = imageFormat(bytes);
    if (!format || !MAC_IMAGE_FORMATS.has(format)) throw new Error("Only HEIC and TIFF images are converted here.");
    const folder = await mkdtemp(join(tmpdir(), "endurance-image-"));
    try {
      const input = join(folder, "image");
      const output = join(folder, "image.png");
      await writeFile(input, bytes, { mode: 0o600 });
      await run("/usr/bin/sips", ["-s", "format", "png", input, "--out", output], { timeout: 30_000 });
      return new Uint8Array(await readFile(output));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  // Opening a sent document: the window gets its bytes or its kept text by name, and nothing else.
  ipcMain.handle("attachments:read", async (event, id: unknown): Promise<AttachmentRead> => {
    trusted(event);
    const name = attachmentName(id);
    // The sealed file is a little larger than the document, so a document far over the limit is not opened at all.
    const sealed = sealedSize(name);
    if (sealed === undefined) return { state: "missing" };
    if (sealed > MAX_PREVIEW + MAX_PREVIEW / 256) return { state: "too-large", size: sealed };
    const bytes = await history("readAttachment", name);
    if (!bytes) return { state: "missing" };
    if (bytes.byteLength > MAX_PREVIEW) return { state: "too-large", size: bytes.byteLength };
    return { state: "ok", bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  });
  ipcMain.handle("attachments:read-text", async (event, id: unknown): Promise<AttachmentText> => {
    trusted(event);
    const name = attachmentName(id);
    if (sealedSize(name) === undefined) return { state: "missing" };
    const text = await history("readAttachmentText", name, KEPT_TEXT);
    return text === undefined ? { state: "unread" } : { state: "ok", text };
  });
  // A copy goes only where the person chose in the save dialog; the bytes are read here, not sent by the window.
  ipcMain.handle("attachments:save-copy", async (event, id: unknown, filename: unknown) => {
    trusted(event);
    const name = attachmentName(id);
    if (typeof filename !== "string" || filename.length > 255) throw new Error("Invalid attachment");
    if (sealedSize(name) === undefined) return "missing";
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: join(app.getPath("downloads"), basename(filename.replace(/[\\/:*?"<>|\0]/g, "_")) || "Attachment") };
    const chosen = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return "canceled";
    const bytes = await history("readAttachment", name);
    if (!bytes) return "missing";
    await writeFile(chosen.filePath, bytes);
    return "saved";
  });
}

const run = promisify(execFile);

/** Only the name of a kept document, never a path. */
function attachmentName(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid attachment");
  return id;
}

/** The kept file's size, or nothing when it is no longer kept (deleted with its chat, or renamed by a new key). */
function sealedSize(id: string) {
  try {
    return statSync(join(attachmentsFolder(), id)).size;
  } catch {
    return undefined;
  }
}

/** The chat worker's questions about a document: its bytes, the text kept from it, or text to keep. */
export async function answerAttachment(ask: AttachmentAsk): Promise<AttachmentAnswer> {
  const reply = { type: "attachment" as const, request: ask.request };
  try {
    if (ask.op === "read") return { ...reply, ok: true, bytes: await history("readAttachment", ask.id) };
    if (ask.op === "read-text") return { ...reply, ok: true, text: await history("readAttachmentText", ask.id, ask.version) };
    if (typeof ask.text !== "string") throw new Error("Invalid attachment");
    await history("writeAttachmentText", ask.id, ask.version, ask.text);
    return { ...reply, ok: true };
  } catch (error) {
    return { ...reply, ok: false, error: error instanceof Error ? error.message : "The document could not be read." };
  }
}
