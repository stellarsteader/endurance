/**
 * Prints the decrypted history of a development profile, now that sqlite3 shows only ciphertext. Development data
 * only: the packaged app's profile is refused, and nothing in the profile is written (the database is opened
 * read-only; vault.json and attachments are only read). The repo's Electron unwraps the key (dev-history-key.mjs).
 *
 *   npm run dev:history                                  sessions: id, updated, message count, title
 *   npm run dev:history -- --messages                    every session with its messages, as JSON
 *   npm run dev:history -- --session <id>                one session with its messages, as JSON
 *   npm run dev:history -- --projects | --requests       as JSON
 *   npm run dev:history -- --attachment <id>[.v1] --out <file>
 *   npm run dev:history -- --user-data-dir=<profile>     another test profile (or give the path alone)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { DEVELOPMENT, PACKAGED } from "../electron/identity";
import { at } from "../src/history/store";
import { Vault } from "../src/history/vault";

const ENCRYPTED = 4;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "user-data-dir": { type: "string" },
    messages: { type: "boolean" },
    session: { type: "string" },
    projects: { type: "boolean" },
    requests: { type: "boolean" },
    attachment: { type: "string" },
    out: { type: "string" },
  },
});

// Electron's appData on each system.
const appData =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
const profile = resolve(values["user-data-dir"] ?? positionals[0] ?? join(appData, DEVELOPMENT.name));
const canonical = (path: string) => {
  const real = existsSync(path) ? realpathSync.native(path) : resolve(path);
  return process.platform === "linux" ? real : real.toLowerCase();
};
if (canonical(profile) === canonical(join(appData, PACKAGED.name)))
  fail(`${profile} is the packaged Endurance profile. This tool is for development data only; it does not open real history.`);

const historyFile = join(profile, "history.sqlite");
if (!existsSync(historyFile)) fail(`No history in ${profile}.`);
const db = new DatabaseSync(historyFile, { readOnly: true });
const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
if (version < ENCRYPTED) fail(`The history in ${profile} is not encrypted yet (version ${version}); sqlite3 reads it as it is.`);
const keyId = (db.prepare("SELECT value FROM setting WHERE key = 'vault'").get() as { value: string } | undefined)?.value;

const keyFile = join(profile, "vault.json");
if (!existsSync(keyFile)) fail(`The history is encrypted but ${keyFile} is missing, so it cannot be opened.`);
let keys: { id?: string; os?: string; next?: { id: string; os: string } };
try {
  keys = JSON.parse(readFileSync(keyFile, "utf8")) ?? {};
} catch {
  fail(`${keyFile} is damaged.`);
}
// During an unfinished key rotation the history may already use the new key.
const wrapped = !keyId || keys.id === keyId ? keys.os : keys.next?.id === keyId ? keys.next.os : undefined;
if (!wrapped) fail(`${keyFile} has no keychain copy of the key this history was saved with (${keyId}).`);

// macOS keeps the key in the keychain, so a throwaway folder keeps Chromium out of the profile. Elsewhere the
// keychain key is found through the profile itself, as the app finds it.
const scratch = mkdtempSync(join(tmpdir(), "endurance-dev-history-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
let vault: Vault;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)("electron") as string;
  const helper = join(import.meta.dirname, "dev-history-key.mjs");
  const out = execFileSync(electron, [helper, process.platform === "darwin" ? scratch : profile, wrapped], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  vault = new Vault(Buffer.from(out.trim().split("\n").pop() ?? "", "base64"));
} catch (error) {
  const { status, stderr } = error as { status?: number; stderr?: string };
  fail(
    status === 3
      ? "No usable system keychain, so the history stays locked."
      : status === 4
        ? "The keychain did not open the key (refused, locked or replaced), so the history stays locked."
        : `Electron could not unwrap the key: ${String(stderr || (error as Error).message).trim()}`
  );
}

const open = (value: unknown, context: string) => {
  if (value === null || value === undefined) return undefined;
  try {
    return vault.open(value as Uint8Array, context);
  } catch (error) {
    return `<does not open: ${(error as Error).message}>`;
  }
};
const json = (text: string | undefined) => {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const time = (value: unknown) => new Date(Number(value)).toISOString();

type Row = Record<string, unknown>;
const messagesOf = (session: string) =>
  (db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY position").all(session) as Row[]).map((row) => json(open(row.data, at.message(session, String(row.id)))));
const sessionOf = (row: Row) => ({
  id: row.id,
  title: open(row.title, at.title(String(row.id))),
  projectId: row.project_id ?? undefined,
  updated: time(row.time_updated),
  choice: json((row.choice as string | null) ?? undefined),
  messages: messagesOf(String(row.id)),
});

if (values.attachment) {
  const name = values.attachment;
  if (!/^[a-f0-9]{64}(\.[A-Za-z0-9]+)?$/.test(name)) fail("An attachment is named by its 64-character id, with .v1 for its kept text.");
  if (!values.out) fail("Give a file to write the attachment to with --out <file>.");
  const out = resolve(values.out);
  const inside = relative(canonical(profile), canonical(join(out, "..")));
  if (!inside.startsWith("..") && !isAbsolute(inside)) fail("--out must be outside the profile, which this tool never writes.");
  const file = join(profile, "attachments", name);
  if (!existsSync(file)) fail(`No attachment ${name} in ${profile}.`);
  let bytes: Buffer;
  try {
    bytes = vault.openFile(readFileSync(file), `attachment/${name}`);
  } catch (error) {
    fail(`${name} does not open: ${(error as Error).message}`);
  }
  writeFileSync(out, bytes, { flag: "wx" });
  console.log(`Wrote ${bytes.length} bytes to ${out}`);
} else if (values.session) {
  const row = db.prepare("SELECT * FROM session WHERE id = ?").get(values.session) as Row | undefined;
  if (!row) fail(`No session ${values.session}.`);
  print(sessionOf(row));
} else if (values.messages) {
  print((db.prepare("SELECT * FROM session ORDER BY time_updated DESC").all() as Row[]).map(sessionOf));
} else if (values.projects) {
  print(
    (db.prepare("SELECT * FROM project ORDER BY time_created").all() as Row[]).map((row) => {
      const id = String(row.id);
      return {
        id,
        name: open(row.name, at.name(id)),
        created: time(row.time_created),
        updated: time(row.time_updated),
        pinned: Boolean(row.pinned),
        collapsed: Boolean(row.collapsed),
        instructions: open(row.instructions, at.instructions(id)),
        access: json(open(row.access, at.access(id))),
      };
    })
  );
} else if (values.requests) {
  print((db.prepare("SELECT * FROM request ORDER BY time DESC").all() as Row[]).map((row) => ({ ...row, time: time(row.time), content: json(open(row.content, at.content(String(row.id)))) })));
} else {
  const rows = db
    .prepare("SELECT id, title, time_updated, (SELECT COUNT(*) FROM message WHERE session_id = session.id) AS count FROM session ORDER BY time_updated DESC")
    .all() as Row[];
  for (const row of rows) console.log(`${row.id}  ${time(row.time_updated)}  ${row.count} messages  ${open(row.title, at.title(String(row.id)))}`);
  if (!rows.length) console.log("No sessions.");
}
db.close();
