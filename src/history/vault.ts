/**
 * Encryption for what Endurance keeps on disk: chats, projects, request records and attached documents. One
 * random data key encrypts everything with AES-256-GCM; the key itself is only ever on disk wrapped, in
 * vault.json, once per way of opening it (the system keychain, and a recovery key when one was made). It can be
 * replaced by a new key (rotation), which encrypts everything again.
 *
 * - Values (a chat's title, a message, a project's name): version byte | nonce | ciphertext | tag. Each is bound
 *   to where it is stored (its table, column and row), so a value moved to another row does not open.
 * - Files: a header, then 64 KiB pieces sealed one by one under a nonce that counts them and marks the last,
 *   so a file cut short, reordered or swapped with another does not open.
 * - File names: a keyed hash of the content, so the same file is kept once without revealing which file it is.
 *
 * Nothing here touches Electron or the disk; electron/vault-key.ts supplies the keychain and the file.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VALUE_VERSION = 1;
const FILE_MAGIC = Buffer.from("ENDV");
const FILE_VERSION = 1;
const PREFIX_BYTES = 7;
const HEADER_BYTES = FILE_MAGIC.length + 1 + PREFIX_BYTES;
const PIECE = 64 * 1024;

const derive = (key: Buffer, use: string) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `endurance ${use} v1`, KEY_BYTES));

function seal(key: Buffer, plain: Uint8Array, context: string) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.of(VALUE_VERSION), nonce, body, cipher.getAuthTag()]);
}

function unseal(key: Buffer, sealed: Uint8Array, context: string) {
  const data = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (data.length < 1 + NONCE_BYTES + TAG_BYTES || data[0] !== VALUE_VERSION) throw new Error("This value is not encrypted by Endurance.");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 1 + NONCE_BYTES));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(1 + NONCE_BYTES, data.length - TAG_BYTES)), decipher.final()]);
}

const pieceNonce = (prefix: Buffer, index: number, last: boolean) => {
  const nonce = Buffer.alloc(NONCE_BYTES);
  prefix.copy(nonce);
  nonce.writeUInt32BE(index, PREFIX_BYTES);
  nonce[NONCE_BYTES - 1] = last ? 1 : 0;
  return nonce;
};

/** Whether a file starts like one sealed by Vault.sealFile; anything else in the attachments folder is plaintext. */
export const isSealedFile = (head: Uint8Array) => Buffer.from(head.subarray(0, FILE_MAGIC.length)).equals(FILE_MAGIC);

/** Each vault's data key, kept out of the class so only this module hands it out (keyOf, a new recovery key). */
const roots = new WeakMap<Vault, Buffer>();
/** The data key itself, for the history thread that uses it (electron/history-ipc). */
export const keyOf = (vault: Vault) => Uint8Array.from(roots.get(vault)!);

export class Vault {
  private readonly values: Buffer;
  private readonly files: Buffer;
  private readonly names: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_BYTES) throw new Error("The data key must be 32 bytes.");
    const root = Buffer.from(key);
    roots.set(this, root);
    this.values = derive(root, "values");
    this.files = derive(root, "files");
    this.names = derive(root, "names");
  }

  seal(text: string, context: string) {
    return seal(this.values, Buffer.from(text, "utf8"), context);
  }

  open(sealed: Uint8Array, context: string) {
    return unseal(this.values, sealed, context).toString("utf8");
  }

  sealFile(bytes: Uint8Array, context: string) {
    const prefix = randomBytes(PREFIX_BYTES);
    const header = Buffer.concat([FILE_MAGIC, Buffer.of(FILE_VERSION), prefix]);
    const aad = Buffer.concat([header, Buffer.from(context)]);
    const out: Buffer[] = [header];
    const count = Math.max(1, Math.ceil(bytes.byteLength / PIECE));
    for (let index = 0; index < count; index++) {
      const cipher = createCipheriv("aes-256-gcm", this.files, pieceNonce(prefix, index, index === count - 1));
      cipher.setAAD(aad);
      out.push(cipher.update(bytes.subarray(index * PIECE, (index + 1) * PIECE)), cipher.final(), cipher.getAuthTag());
    }
    return Buffer.concat(out);
  }

  openFile(sealed: Uint8Array, context: string) {
    const data = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
    if (data.length < HEADER_BYTES + TAG_BYTES || !isSealedFile(data) || data[FILE_MAGIC.length] !== FILE_VERSION) throw new Error("This file is not encrypted by Endurance.");
    const header = data.subarray(0, HEADER_BYTES);
    const prefix = header.subarray(FILE_MAGIC.length + 1);
    const aad = Buffer.concat([header, Buffer.from(context)]);
    const out: Buffer[] = [];
    let offset = HEADER_BYTES;
    for (let index = 0; offset < data.length; index++) {
      const end = Math.min(offset + PIECE + TAG_BYTES, data.length);
      const decipher = createDecipheriv("aes-256-gcm", this.files, pieceNonce(prefix, index, end === data.length));
      decipher.setAAD(aad);
      decipher.setAuthTag(data.subarray(end - TAG_BYTES, end));
      out.push(decipher.update(data.subarray(offset, end - TAG_BYTES)), decipher.final());
      offset = end;
    }
    return Buffer.concat(out);
  }

  /** The name a file is kept under: the same content always gets the same name. */
  name(bytes: Uint8Array) {
    return createHmac("sha256", this.names).update(bytes).digest("hex");
  }
}

// ---------------------------------------------------------------------------- recovery keys

/** Crockford base32: no I, L, O or U, so a written-down key is not misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_CHARS = Math.ceil((KEY_BYTES * 8) / 5);

/** A new recovery key, as bytes and as the text shown once to the person (groups of four). */
export function newRecoveryKey() {
  const bytes = randomBytes(KEY_BYTES);
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) text += ALPHABET[(value << (5 - bits)) & 31];
  return { bytes, text: text.match(/.{1,4}/g)!.join("-") };
}

/** A recovery key as typed: case, spaces and dashes ignored, and O, I and L read as 0, 1 and 1. */
export function parseRecoveryKey(input: string) {
  const text = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (text.length !== RECOVERY_CHARS) return undefined;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length === KEY_BYTES ? Buffer.from(bytes) : undefined;
}

// ---------------------------------------------------------------------------- the key file

/** vault.json: the data key, wrapped once per way of opening it. */
interface KeyFile {
  version: 1;
  /** Names this data key; the history database records it, so a different key file is noticed. */
  id: string;
  /** Wrapped by the system keychain (Electron safeStorage), base64. */
  os?: string;
  /** Wrapped by the recovery key, base64. */
  recovery?: string;
  /** A new key while the history is being encrypted again with it (key rotation); wrapped by the keychain. */
  next?: { id: string; os: string };
}

/** The system keychain, as Electron safeStorage offers it. Strings in and out are base64. */
export interface Keystore {
  /** False when there is no keychain, or only Linux's fixed-password fallback. */
  available(): boolean;
  encrypt(base64: string): string;
  decrypt(base64: string): string;
}

export interface KeyFileAccess {
  read(): string | undefined;
  /** Replaces the file whole (written aside, then renamed), so a crash never leaves half a key file. */
  write(text: string): void;
  keystore: Keystore;
}

export type LockReason =
  /** No usable keychain: nothing is saved until there is one, or a recovery key opens the history. */
  | "keystore"
  /** The keychain did not open the key (refused, locked, or replaced). The key file is left as it is. */
  | "unreadable"
  /** The history is encrypted but its key file is gone, damaged or another history's. Only starting over helps. */
  | "missing";

export type KeyState =
  | { status: "open"; vault: Vault; id: string; hasRecovery: boolean; next?: { vault: Vault; id: string } }
  | { status: "locked"; reason: LockReason; hasRecovery: boolean };

const recoveryKey = (bytes: Buffer) => derive(bytes, "recovery");
const wrapContext = (id: string) => `vault/${id}`;

function parse(text: string): KeyFile | undefined {
  try {
    const file = JSON.parse(text) as KeyFile;
    return file?.version === 1 && typeof file.id === "string" && /^[a-f0-9]{32}$/.test(file.id) ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens the data key. A new key is made only when there is no key file and no encrypted history: a key file
 * that does not open is never replaced, since its recovery copy is in the same file and a passing failure (a
 * refused keychain prompt, a locked Linux keyring) would otherwise lose the history for good.
 */
export function openKeys(access: KeyFileAccess, historyEncrypted: boolean): KeyState {
  const text = access.read();
  if (text === undefined) {
    if (historyEncrypted) return { status: "locked", reason: "missing", hasRecovery: false };
    if (!access.keystore.available()) return { status: "locked", reason: "keystore", hasRecovery: false };
    const key = randomBytes(KEY_BYTES);
    const file: KeyFile = { version: 1, id: randomBytes(16).toString("hex"), os: access.keystore.encrypt(key.toString("base64")) };
    access.write(JSON.stringify(file));
    return { status: "open", vault: new Vault(key), id: file.id, hasRecovery: false };
  }
  const file = parse(text);
  if (!file) return { status: "locked", reason: "missing", hasRecovery: false };
  const hasRecovery = Boolean(file.recovery);
  if (!access.keystore.available()) return { status: "locked", reason: "keystore", hasRecovery };
  let vault: Vault;
  try {
    vault = new Vault(Buffer.from(access.keystore.decrypt(file.os ?? ""), "base64"));
  } catch {
    return { status: "locked", reason: "unreadable", hasRecovery };
  }
  // A rotation the app was stopped in; the history says which key it was finished with (settleRotation).
  let next: { vault: Vault; id: string } | undefined;
  try {
    if (file.next) next = { vault: new Vault(Buffer.from(access.keystore.decrypt(file.next.os), "base64")), id: file.next.id };
  } catch {
    next = undefined;
  }
  return { status: "open", vault, id: file.id, hasRecovery, ...(next ? { next } : {}) };
}

/** Opens the key with a recovery key and, when the keychain works, wraps it there again for next time. */
export function recoverKeys(access: KeyFileAccess, input: string): KeyState | undefined {
  const file = parse(access.read() ?? "");
  const bytes = parseRecoveryKey(input);
  if (!file?.recovery || !bytes) return undefined;
  let key: Buffer;
  try {
    key = unseal(recoveryKey(bytes), Buffer.from(file.recovery, "base64"), wrapContext(file.id));
  } catch {
    return undefined;
  }
  if (access.keystore.available()) access.write(JSON.stringify({ ...file, os: access.keystore.encrypt(key.toString("base64")) }));
  return { status: "open", vault: new Vault(key), id: file.id, hasRecovery: true };
}

/** A new recovery key for an open history; the one made before stops working. */
export function makeRecoveryKey(access: KeyFileAccess, keys: Extract<KeyState, { status: "open" }>) {
  const file = parse(access.read() ?? "");
  if (!file || file.id !== keys.id) throw new Error("The key file changed. Restart Endurance and try again.");
  const recovery = newRecoveryKey();
  access.write(JSON.stringify({ ...file, recovery: seal(recoveryKey(recovery.bytes), roots.get(keys.vault)!, wrapContext(file.id)).toString("base64") }));
  return recovery.text;
}

/**
 * Key rotation, step one: a new data key is made and kept beside the current one, so a rotation the app is
 * stopped in can be finished or abandoned on the next start. The history is then encrypted again with it.
 */
export function startRotation(access: KeyFileAccess, keys: Extract<KeyState, { status: "open" }>) {
  const file = parse(access.read() ?? "");
  if (!file || file.id !== keys.id) throw new Error("The key file changed. Restart Endurance and try again.");
  if (!access.keystore.available()) throw new Error("The system keychain is unavailable, so the key can't be changed.");
  const key = randomBytes(KEY_BYTES);
  const next = { vault: new Vault(key), id: randomBytes(16).toString("hex") };
  access.write(JSON.stringify({ ...file, next: { id: next.id, os: access.keystore.encrypt(key.toString("base64")) } }));
  return next;
}

/**
 * Key rotation, last step: once the history is encrypted with the new key, it replaces the old one, and the
 * recovery key, which opened only the old one, is dropped. When the history was not finished, the new key is.
 */
export function settleRotation(access: KeyFileAccess, keys: Extract<KeyState, { status: "open" }>, finished: boolean): Extract<KeyState, { status: "open" }> {
  const file = parse(access.read() ?? "");
  if (!file?.next) return keys;
  if (finished && keys.next) {
    access.write(JSON.stringify({ version: 1, id: file.next.id, os: file.next.os } satisfies KeyFile));
    return { status: "open", vault: keys.next.vault, id: keys.next.id, hasRecovery: false };
  }
  const { next: _next, ...kept } = file;
  void _next;
  access.write(JSON.stringify(kept));
  return { status: "open", vault: keys.vault, id: keys.id, hasRecovery: keys.hasRecovery };
}