/**
 * The data key that encrypts history and attachments (src/history/vault), wrapped by the system keychain in
 * vault.json. Only this process holds it; the chat worker asks for documents and gets their contents.
 *
 * A key that does not open is never replaced. History stays closed and the window shows the recovery screen:
 * try again, enter the recovery key, or start over (which deletes the history the person can no longer open).
 */
import { app, safeStorage } from "electron";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HistoryStore } from "../src/history/store";
import { makeRecoveryKey, openKeys, recoverKeys, settleRotation, startRotation, type KeyFileAccess, type KeyState } from "../src/history/vault";
import type { VaultStatus } from "../src/lib/history-api";

const profile = (name: string) => path.join(app.getPath("userData"), name);
export const historyFile = () => profile("history.sqlite");
export const attachmentsFolder = () => profile("attachments");
const keyFile = () => profile("vault.json");

const access: KeyFileAccess = {
  read: () => (existsSync(keyFile()) ? readFileSync(keyFile(), "utf8") : undefined),
  write: (text) => {
    const written = `${keyFile()}.tmp`;
    writeFileSync(written, text, { mode: 0o600 });
    renameSync(written, keyFile());
  },
  keystore: {
    // Linux without a keyring falls back to a password built into Chromium, which protects nothing.
    available: () => safeStorage.isEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  },
};

let state: KeyState | undefined;
const current = () => (state ??= openKeys(access, HistoryStore.isEncrypted(historyFile())));

export class VaultLocked extends Error {
  constructor() {
    super("Your history is locked.");
  }
}

/** The open data key; throws while history is locked. */
export function openVault() {
  const keys = current();
  if (keys.status !== "open") throw new VaultLocked();
  return keys;
}

/** The history belongs to another key: only starting over can help. */
export function lockMissing() {
  state = { status: "locked", reason: "missing", hasRecovery: false };
}

export function vaultStatus(): VaultStatus {
  const keys = current();
  return keys.status === "open" ? { status: "open", hasRecovery: keys.hasRecovery } : { status: "locked", reason: keys.reason, hasRecovery: keys.hasRecovery };
}

/** Asks the keychain again, as after a refused prompt or once a Linux keyring is unlocked. */
export function retryVault() {
  if (state?.status === "locked" && state.reason !== "missing") state = undefined;
}

export function recoverVault(input: string) {
  const keys = recoverKeys(access, input);
  if (!keys) return false;
  state = keys;
  return true;
}

/** A new recovery key, shown once; the one made before stops working. */
export function newRecoveryKey() {
  const keys = openVault();
  const text = makeRecoveryKey(access, keys);
  state = { ...keys, hasRecovery: true };
  return text;
}

/** A new data key, kept beside the current one until the history is encrypted with it (finishKeyRotation). */
export function beginKeyRotation() {
  const keys = openVault();
  const next = startRotation(access, keys);
  state = { ...keys, next };
  return next;
}

/** Makes the new key the only one once the history uses it, or drops it when the history does not. */
export function finishKeyRotation(finished: boolean) {
  const keys = settleRotation(access, openVault(), finished);
  state = keys;
  return keys;
}

/** Deletes the history that can no longer be opened, with its attachments and key file, and starts a new one. */
export function startOver() {
  if (current().status === "open") throw new Error("History is open; there is nothing to start over.");
  for (const name of [historyFile(), `${historyFile()}-wal`, `${historyFile()}-shm`, keyFile(), attachmentsFolder()]) rmSync(name, { recursive: true, force: true });
  state = undefined;
}
