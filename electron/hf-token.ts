/**
 * The person's Hugging Face token, for gated models: encrypted with Electron safeStorage, whose key is in the macOS
 * Keychain, as connection keys are. The renderer only learns whether one is set. It goes with a download request
 * to the person's own server (the vLLM manager), which uses it for that download and does not keep it.
 */
import { app, ipcMain, safeStorage, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const file = () => path.join(app.getPath("userData"), "hf-token.json");

export function hfToken(): string | undefined {
  try {
    if (!existsSync(file())) return undefined;
    const saved = JSON.parse(readFileSync(file(), "utf8")) as { token?: string };
    return saved.token ? safeStorage.decryptString(Buffer.from(saved.token, "base64")) : undefined;
  } catch {
    return undefined;
  }
}

export function registerHfTokenIPC(trusted: (event: IpcMainInvokeEvent | IpcMainEvent) => void) {
  ipcMain.handle("hf:token-status", (event) => {
    trusted(event);
    return { set: Boolean(hfToken()) };
  });
  ipcMain.handle("hf:token-save", (event, value: unknown) => {
    trusted(event);
    if (value === null) {
      rmSync(file(), { force: true });
      return { set: false };
    }
    if (typeof value !== "string" || !/^\S{8,200}$/.test(value.trim())) throw new Error("Paste a Hugging Face access token.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("The system keychain is unavailable, so the token was not saved.");
    writeFileSync(file(), JSON.stringify({ token: safeStorage.encryptString(value.trim()).toString("base64") }), { mode: 0o600 });
    return { set: true };
  });
}
