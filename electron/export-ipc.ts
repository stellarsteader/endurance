/**
 * Exporting a chat: the window builds the file (src/lib/chat-export) and hands over its text
 * once; this process asks where to save it and writes it. The window never learns or names a path. The file is a
 * plaintext copy outside the vault.
 */
import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXPORT_EXTENSION, EXPORT_FORMATS, MAX_EXPORT, exportFilename, type ChatExportFormat } from "../src/lib/chat-export";

const FILTERS: Record<ChatExportFormat, Electron.FileFilter> = {
  markdown: { name: "Markdown", extensions: ["md"] },
  json: { name: "JSON", extensions: ["json"] },
};

export function registerExportIPC(trusted: (event: IpcMainInvokeEvent | IpcMainEvent) => void) {
  ipcMain.handle("chat:export", async (event, filename: unknown, format: unknown, text: unknown) => {
    trusted(event);
    if (typeof format !== "string" || !EXPORT_FORMATS.includes(format as ChatExportFormat)) throw new Error("Invalid export");
    if (typeof filename !== "string" || filename.length > 255 || typeof text !== "string") throw new Error("Invalid export");
    if (Buffer.byteLength(text, "utf8") > MAX_EXPORT) throw new Error(`This chat is larger than ${MAX_EXPORT / 1024 / 1024} MB as a file.`);
    const kind = format as ChatExportFormat;
    // The name is cleaned again here, without its extension, and given the one its format takes.
    const name = exportFilename(filename.replace(new RegExp(`\\.${EXPORT_EXTENSION[kind]}$`, "i"), ""), kind);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: join(app.getPath("downloads"), name), filters: [FILTERS[kind]] };
    const chosen = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return "canceled";
    await writeFile(chosen.filePath, text, "utf8");
    return "saved";
  });
}
