/**
 * Documents attached to chats (PDF, Word, spreadsheets, text), kept once in the app's data folder, encrypted
 * (./vault) under a keyed hash of their content, with the text taken out of each kept beside it (`<name>.<version>`).
 * A message carries only `attachment:<name>`. Used by the history thread (electron/history-thread), which is the
 * only place the key is used; everything here is synchronous because that thread does one thing at a time.
 *
 * Copies of files from before the agent changed them (src/harness/file-copies) are kept here the same way and named
 * the same way in edit results, so a key rotation renames them and removeUnreferenced removes the ones no message
 * names any more, with the chats and messages that named them.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSealedFile, type Vault } from "./vault";

const NAME = /^[a-f0-9]{64}$/;
const VERSION = /^v\d{1,4}$/;

/** Where a sealed file belongs: a document, or the text kept from it. A file only opens under its own name. */
const fileContext = (id: string) => `attachment/${id}`;
const textContext = (id: string, version: string) => `attachment/${id}.${version}`;

/** Written aside and renamed, so a file that exists is always whole. */
function put(file: string, bytes: Uint8Array) {
  writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function head(file: string) {
  const bytes = Buffer.alloc(4);
  const handle = openSync(file, "r");
  try {
    return bytes.subarray(0, readSync(handle, bytes, 0, bytes.length, 0));
  } finally {
    closeSync(handle);
  }
}

function checked(id: string, version?: string) {
  if (!NAME.test(id) || (version !== undefined && !VERSION.test(version))) throw new Error("Invalid attachment");
}

export class AttachmentFolder {
  constructor(
    private readonly folder: string,
    public vault: Vault
  ) {}

  /** Keeps a document; the same file attached again is already there. */
  save(bytes: Uint8Array) {
    const id = this.vault.name(bytes);
    mkdirSync(this.folder, { recursive: true });
    const file = join(this.folder, id);
    if (!existsSync(file)) put(file, this.vault.sealFile(bytes, fileContext(id)));
    return { id, size: bytes.byteLength };
  }

  /** A document's bytes, or nothing when it is no longer kept. */
  read(id: string) {
    checked(id);
    const file = join(this.folder, id);
    return existsSync(file) ? this.vault.openFile(readFileSync(file), fileContext(id)) : undefined;
  }

  readText(id: string, version: string) {
    checked(id, version);
    const file = join(this.folder, `${id}.${version}`);
    return existsSync(file) ? this.vault.openFile(readFileSync(file), textContext(id, version)).toString("utf8") : undefined;
  }

  writeText(id: string, version: string, text: string) {
    checked(id, version);
    mkdirSync(this.folder, { recursive: true });
    put(join(this.folder, `${id}.${version}`), this.vault.sealFile(Buffer.from(text), textContext(id, version)));
  }

  private documents() {
    return existsSync(this.folder) ? readdirSync(this.folder) : [];
  }

  /**
   * Encrypts the documents an older version kept as plaintext (named by their SHA-256, with `<hash>.<version>.md`
   * beside them for their text), under their new names. The plaintext stays until the history that names them is
   * encrypted too (removePlain), so a crash in between loses nothing. Returns old name → new name.
   */
  sealPlain(onProgress: (done: number, total: number) => void) {
    const renamed = new Map<string, string>();
    const names = this.documents();
    const plain = names.filter((name) => NAME.test(name));
    plain.forEach((name, index) => {
      onProgress(index, plain.length);
      const bytes = readFileSync(join(this.folder, name));
      if (isSealedFile(bytes)) return;
      const id = this.vault.name(bytes);
      if (!existsSync(join(this.folder, id))) put(join(this.folder, id), this.vault.sealFile(bytes, fileContext(id)));
      renamed.set(name, id);
    });
    for (const name of names) {
      const kept = /^([a-f0-9]{64})\.(v\d{1,4})\.md$/.exec(name);
      const id = kept && renamed.get(kept[1]);
      if (id) put(join(this.folder, `${id}.${kept[2]}`), this.vault.sealFile(readFileSync(join(this.folder, name)), textContext(id, kept[2])));
    }
    return renamed;
  }

  /**
   * Encrypts every kept document and kept text again with a new key, under its new name, for a key rotation. The
   * old files stay until the history names the new ones (removeUnreferenced). Returns old name → new name.
   */
  reseal(to: Vault, onProgress: (done: number, total: number) => void) {
    const renamed = new Map<string, string>();
    const names = this.documents();
    const documents = names.filter((name) => NAME.test(name));
    documents.forEach((name, index) => {
      onProgress(index, documents.length);
      let bytes: Buffer;
      try {
        bytes = this.vault.openFile(readFileSync(join(this.folder, name)), fileContext(name));
      } catch {
        return; // Not this key's: left from a rotation that was stopped, and removed with the unnamed files.
      }
      const id = to.name(bytes);
      if (!existsSync(join(this.folder, id))) put(join(this.folder, id), to.sealFile(bytes, fileContext(id)));
      renamed.set(name, id);
    });
    for (const name of names) {
      const kept = /^([a-f0-9]{64})\.(v\d{1,4})$/.exec(name);
      const id = kept && renamed.get(kept[1]);
      if (!id) continue;
      try {
        const text = this.vault.openFile(readFileSync(join(this.folder, name)), textContext(kept[1], kept[2]));
        put(join(this.folder, `${id}.${kept[2]}`), to.sealFile(text, textContext(id, kept[2])));
      } catch {
        /* Kept text that does not open is read from the document again. */
      }
    }
    return renamed;
  }

  /** Deletes the documents and kept text no message names, as after a key rotation. */
  removeUnreferenced(named: Set<string>) {
    for (const name of this.documents()) if (name.endsWith(".tmp") || !named.has(name.slice(0, 64))) rmSync(join(this.folder, name), { recursive: true, force: true });
  }

  /** Deletes whatever in the folder is not encrypted: plaintext already encrypted, and unfinished writes. */
  removePlain() {
    for (const name of this.documents()) {
      const file = join(this.folder, name);
      if (name.endsWith(".tmp") || !statSync(file).isFile() || !isSealedFile(head(file))) rmSync(file, { recursive: true, force: true });
    }
  }
}
