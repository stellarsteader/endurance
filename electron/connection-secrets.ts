/**
 * Connection secrets on disk: values are encrypted with Electron safeStorage, whose key lives in the macOS
 * Keychain, and never reach the renderer, which only learns that they exist. The rules (per connection ID,
 * bound to the saved address) are in src/lib/connection-vault.ts.
 */
import { app, safeStorage } from "electron";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConnectionVault } from "../src/lib/connection-vault";

export { validHeaders, validQuery } from "../src/lib/connection-vault";
export type { SecretChange } from "../src/lib/desktop";

const file = () => path.join(app.getPath("userData"), "connection-secrets.json");

export const vault = new ConnectionVault({
  read: () => (existsSync(file()) ? readFileSync(file(), "utf8") : undefined),
  write: (text) => {
    writeFileSync(file(), text, { mode: 0o600 });
    try {
      chmodSync(file(), 0o600);
    } catch {
      /* The profile folder is already private to the user. */
    }
  },
  encrypt: (value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("The system keychain is unavailable, so the key was not saved.");
    return safeStorage.encryptString(value).toString("base64");
  },
  decrypt: (value) => {
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      return undefined;
    }
  },
});
