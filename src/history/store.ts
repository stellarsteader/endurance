/**
 * Chat and request history: sessions, messages and token totals (deleting a session deletes its records), and
 * request records (model, provider, origin, outcome, optional contents, at most 100 kept for 30 days). Portions
 * derived from opencode (MIT; notice: ../harness/vendor/LICENSE). Uses Node's built-in SQLite so no native module is shipped.
 *
 * What a person wrote is stored encrypted (./vault): chat titles, messages, project names, instructions,
 * folders and Always allow rules, and kept request contents. IDs, times, token counts and request outcomes stay readable for ordering.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { HistoryRequest, HistorySession, HistorySettings, RequestStatus, SessionInput } from "../lib/history-api";
import { MAX_INSTRUCTIONS, type StoredProject } from "../lib/workspace-api";
import { isApproval, isEffort, type AppUIMessage, type ChatChoice } from "../lib/types";
import { cleanRules } from "../lib/permissions";
import { sanitizePolicy } from "../lib/workspace-policy";
import type { Vault } from "./vault";

export const MAX_REQUESTS = 100;
export const REQUEST_DAYS = 30;
const MAX_CONTENT = 2_000_000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
/** From this version on, what a person wrote is encrypted. */
const ENCRYPTED = 4;
/** Projects keep their Always allow rules (lib/permissions). */
const PROJECT_RULES = 5;

/** Where each encrypted value is stored; a value only opens in the place it was sealed for. */
export const at = {
  title: (session: string) => `session.title/${session}`,
  message: (session: string, id: string) => `message.data/${session}/${id}`,
  name: (project: string) => `project.name/${project}`,
  instructions: (project: string) => `project.instructions/${project}`,
  access: (project: string) => `project.access/${project}`,
  rules: (project: string) => `project.rules/${project}`,
  content: (request: string) => `request.content/${request}`,
};

/** The history was encrypted with another data key than the one given. */
export class HistoryKeyMismatch extends Error {
  constructor() {
    super("This history was saved with a different key.");
  }
}

interface Usage {
  input?: number;
  output?: number;
  reasoning?: number;
  cached?: number;
}
interface StoredMessage {
  id: string;
  role: string;
  metadata?: { usage?: Usage; createdAt?: number };
  [key: string]: unknown;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/** A chat's own model, effort and approval mode as stored: only well-formed fields, or nothing. */
function cleanChoice(value: unknown): ChatChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { model, effort, approval, planFirst } = value as Record<string, unknown>;
  const choice: ChatChoice = {
    ...(typeof model === "string" && model && model.length <= 600 ? { model } : {}),
    ...(isEffort(effort) ? { effort } : {}),
    ...(isApproval(approval) ? { approval } : {}),
    ...(planFirst === true ? { planFirst } : {}),
  };
  return Object.keys(choice).length ? choice : undefined;
}
function withChoice(text: unknown): { choice?: ChatChoice } {
  try {
    const choice = typeof text === "string" ? cleanChoice(JSON.parse(text)) : undefined;
    return choice ? { choice } : {};
  } catch {
    return {};
  }
}

function cleanProject(input: StoredProject): StoredProject {
  if (!input || !validId(input.id)) throw new Error("Invalid project ID");
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
  if (!name) throw new Error("Name the project.");
  const access = input.access ? sanitizePolicy(input.access) : undefined;
  const alwaysAllowed = cleanRules(input.alwaysAllowed);
  return {
    id: input.id,
    name,
    createdAt: number(input.createdAt) || Date.now(),
    pinned: input.pinned === true,
    collapsed: input.collapsed === true,
    instructions: typeof input.instructions === "string" && input.instructions ? input.instructions.slice(0, MAX_INSTRUCTIONS) : undefined,
    access: access?.folders.length ? access : undefined,
    alwaysAllowed,
  };
}

const digest = (text: string) => createHash("sha256").update(text).digest("base64");
const ATTACHMENT = /attachment:([a-f0-9]{64})/g;
/** A message's attachment names replaced by their new names (after the attachments were encrypted again). */
const renameAttachments = (text: string, renamed?: Map<string, string>) =>
  renamed?.size ? text.replace(ATTACHMENT, (match, id: string) => (renamed.has(id) ? `attachment:${renamed.get(id)}` : match)) : text;

export interface HistoryKey {
  /** Names the data key; recorded in the database so a history is never written with another key. */
  id: string;
  /** Attachment names to rewrite in messages while a plaintext history is encrypted (old name → new name). */
  renamed?: Map<string, string>;
  /** Rows encrypted so far, while a plaintext history is encrypted. */
  onProgress?: Progress;
}
export type Progress = (done: number, total: number) => void;

export class HistoryStore {
  private db: DatabaseSync;
  /** Each stored message's hash and position, so a save writes only the messages that changed. */
  private written = new Map<string, Map<string, { hash: string; position: number }>>();
  /** Attachment names changed by the last key rotation; a save from before it still names the old ones. */
  private renamed?: Map<string, string>;

  /** Whether the file holds an encrypted history (so a missing key means it cannot be read, not a first run). */
  static isEncrypted(file: string) {
    if (!existsSync(file)) return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version >= ENCRYPTED;
    } finally {
      db.close();
    }
  }

  /** The id of the key the history is encrypted with, if it is. */
  static keyId(file: string) {
    if (!existsSync(file)) return undefined;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare("SELECT value FROM setting WHERE key = 'vault'").get() as { value: string } | undefined)?.value;
    } catch {
      return undefined;
    } finally {
      db.close();
    }
  }

  constructor(
    file: string,
    private vault: Vault,
    key: HistoryKey
  ) {
    this.db = new DatabaseSync(file);
    // Deleted and replaced values are overwritten in the file, not left in free pages.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    try {
      this.migrate(key);
      const saved = this.db.prepare("SELECT value FROM setting WHERE key = 'vault'").get() as { value: string } | undefined;
      if (saved?.value !== key.id) throw new HistoryKeyMismatch();
    } catch (error) {
      this.db.close();
      throw error;
    }
    // A reply still running when the app last closed did not finish.
    this.db
      .prepare("UPDATE request SET status = 'cancelled', reason = 'The app closed before the reply finished.' WHERE status = 'running'")
      .run();
  }

  private seal(text: string, context: string) {
    return this.vault.seal(text, context);
  }

  private open(value: unknown, context: string) {
    if (!(value instanceof Uint8Array)) throw new Error("A stored value is not encrypted.");
    return this.vault.open(value, context);
  }

  private migrate(key: HistoryKey) {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          title TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          tokens_input INTEGER NOT NULL DEFAULT 0,
          tokens_output INTEGER NOT NULL DEFAULT 0,
          tokens_reasoning INTEGER NOT NULL DEFAULT 0,
          tokens_cache_read INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS session_updated_idx ON session (time_updated);
        CREATE TABLE IF NOT EXISTS message (
          id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session (id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          role TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (session_id, id)
        );
        CREATE INDEX IF NOT EXISTS message_session_position_idx ON message (session_id, position);
        CREATE TABLE IF NOT EXISTS request (
          id TEXT PRIMARY KEY,
          time INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          runtime TEXT NOT NULL,
          model TEXT NOT NULL,
          origin TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          duration_ms INTEGER,
          tokens_input INTEGER NOT NULL DEFAULT 0,
          tokens_output INTEGER NOT NULL DEFAULT 0,
          tokens_reasoning INTEGER NOT NULL DEFAULT 0,
          content TEXT
        );
        CREATE INDEX IF NOT EXISTS request_time_idx ON request (time);
        CREATE INDEX IF NOT EXISTS request_session_idx ON request (session_id);
        CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    }
    if (version < 2) {
      // Projects moved here from renderer localStorage and workspace.json, so one write is the whole save.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          instructions TEXT,
          access TEXT
        );
        PRAGMA user_version = 2;
      `);
    }
    if (version < 3) {
      // Each chat remembers its own model and effort. A file whose version was set back may have the column.
      const columns = this.db.prepare("PRAGMA table_info(session)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "choice")) this.db.exec("ALTER TABLE session ADD COLUMN choice TEXT;");
      this.db.exec("PRAGMA user_version = 3;");
    }
    if (version < PROJECT_RULES) {
      // Before encrypting an older history, which rewrites every project's values, this column among them.
      const columns = this.db.prepare("PRAGMA table_info(project)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "rules")) this.db.exec("ALTER TABLE project ADD COLUMN rules TEXT;");
    }
    if (version < ENCRYPTED) {
      this.transaction(() => this.encryptAll(key));
      // The plaintext is gone from the tables; rebuild the file so none is left in free pages or the log.
      this.db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    }
    if (version < PROJECT_RULES) this.db.exec(`PRAGMA user_version = ${PROJECT_RULES};`);
  }

  /** Encrypts what an older version stored as text, in one transaction. Values already encrypted are left as they are. */
  private encryptAll(key: HistoryKey) {
    this.rewriteAll((value) => (typeof value === "string" ? value : undefined), this.vault, key.renamed, key.onProgress);
    this.db.prepare("INSERT INTO setting (key, value) VALUES ('vault', ?) ON CONFLICT (key) DO NOTHING").run(key.id);
    this.db.exec(`PRAGMA user_version = ${ENCRYPTED};`);
  }

  /**
   * Seals every stored value again with `to`: each value `read` gives text for, the others are left as they are.
   * Attachment names in messages become their new names.
   */
  private rewriteAll(read: (value: unknown, context: string) => string | undefined, to: Vault, renamed?: Map<string, string>, onProgress?: Progress) {
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const total = ["session", "message", "project", "request"].reduce((sum, table) => sum + count(table), 0);
    let done = 0;
    const write = (value: unknown, context: string, change = (text: string) => text) => {
      const text = value === null ? undefined : read(value, context);
      return text === undefined ? (value as Uint8Array | null) : to.seal(change(text), context);
    };
    const run = (select: string, update: string, values: (row: Record<string, string>) => (Uint8Array | string | null)[]) => {
      const statement = this.db.prepare(update);
      // Read whole before writing: a row rewritten while a cursor is still on its table could be read twice.
      for (const row of this.db.prepare(select).all() as Record<string, string>[]) {
        statement.run(...values(row));
        if (++done % 200 === 0) onProgress?.(done, total);
      }
    };
    run("SELECT id, title FROM session", "UPDATE session SET title = ? WHERE id = ?", (row) => [write(row.title, at.title(row.id)), row.id]);
    run("SELECT session_id, id, data FROM message", "UPDATE message SET data = ? WHERE session_id = ? AND id = ?", (row) => [
      write(row.data, at.message(row.session_id, row.id), (text) => renameAttachments(text, renamed)),
      row.session_id,
      row.id,
    ]);
    run("SELECT id, name, instructions, access, rules FROM project", "UPDATE project SET name = ?, instructions = ?, access = ?, rules = ? WHERE id = ?", (row) => [
      write(row.name, at.name(row.id)),
      write(row.instructions, at.instructions(row.id)),
      write(row.access, at.access(row.id)),
      write(row.rules, at.rules(row.id)),
      row.id,
    ]);
    run("SELECT id, content FROM request", "UPDATE request SET content = ? WHERE id = ?", (row) => [write(row.content, at.content(row.id)), row.id]);
  }

  /**
   * Encrypts the whole history again with a new key, in one transaction: if the app stops part way, the history
   * is still whole under the old key. Afterwards nothing in the file opens with the old key.
   */
  rotate(next: Vault, id: string, renamed: Map<string, string>, onProgress?: Progress) {
    this.transaction(() => {
      this.rewriteAll((value, context) => this.open(value, context), next, renamed, onProgress);
      this.db.prepare("UPDATE setting SET value = ? WHERE key = 'vault'").run(id);
    });
    this.vault = next;
    this.renamed = renamed;
    this.written.clear();
    try {
      this.db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* The rotation is done; old values in free pages are overwritten as the file is reused (secure_delete). */
    }
  }

  /** The attachment names the stored messages refer to. */
  attachmentIds() {
    const ids = new Set<string>();
    for (const row of this.db.prepare("SELECT session_id, id, data FROM message").all() as { session_id: string; id: string; data: unknown }[])
      for (const match of this.open(row.data, at.message(row.session_id, row.id)).matchAll(ATTACHMENT)) ids.add(match[1]);
    return ids;
  }

  close() {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The chats without their messages, which are read when a chat is opened (messages): a long history would
   * otherwise be decrypted whole at every start. Each says how many messages it has and the model that replied last.
   */
  listSessions(): HistorySession[] {
    const sessions = this.db.prepare("SELECT * FROM session ORDER BY time_updated DESC").all() as Record<string, unknown>[];
    const counts = new Map(
      (this.db.prepare("SELECT session_id, COUNT(*) AS n FROM message GROUP BY session_id").all() as { session_id: string; n: number }[]).map((row) => [row.session_id, row.n])
    );
    const lastReply = this.db.prepare("SELECT id, data FROM message WHERE session_id = ? AND role = 'assistant' ORDER BY position DESC LIMIT 1");
    return sessions.map((row) => {
      const id = String(row.id);
      const reply = lastReply.get(id) as { id: string; data: unknown } | undefined;
      const model = reply ? (JSON.parse(this.open(reply.data, at.message(id, reply.id))) as StoredMessage & { metadata?: { model?: unknown } }).metadata?.model : undefined;
      return { ...this.sessionOf(row), messageCount: counts.get(id) ?? 0, ...(typeof model === "string" ? { replyModel: model } : {}) };
    });
  }

  /** One chat's messages, in order. */
  messages(session: string): AppUIMessage[] {
    if (!validId(session)) throw new Error("Invalid chat ID");
    const written = new Map<string, { hash: string; position: number }>();
    const rows = this.db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY position").all(session) as { id: string; data: unknown }[];
    const messages = rows.map((item, position) => {
      const json = this.open(item.data, at.message(session, item.id));
      written.set(item.id, { hash: digest(json), position });
      return JSON.parse(json) as AppUIMessage;
    });
    this.written.set(session, written);
    return messages;
  }

  private sessionOf(row: Record<string, unknown>): HistorySession {
    return {
      ...withChoice(row.choice),
      id: String(row.id),
      title: this.open(row.title, at.title(String(row.id))),
      projectId: row.project_id ? String(row.project_id) : undefined,
      pinned: Boolean(row.pinned),
      createdAt: Number(row.time_created),
      updatedAt: Number(row.time_updated),
      tokens: {
        input: Number(row.tokens_input),
        output: Number(row.tokens_output),
        reasoning: Number(row.tokens_reasoning),
        cached: Number(row.tokens_cache_read),
      },
    };
  }

  /**
   * Replaces a session's messages with the given list; token totals follow the stored replies. Only messages that
   * changed are written again. Without messages (a chat whose messages were never read), only the chat itself is saved.
   */
  saveSession(input: SessionInput) {
    if (!validId(input.id)) throw new Error("Invalid chat ID");
    if (input.messages === undefined) return this.saveChat(input);
    if (!Array.isArray(input.messages)) throw new Error("Invalid messages");
    const messages = (input.messages as unknown as StoredMessage[]).filter((message) => validId(message?.id) && typeof message.role === "string");
    const choice = cleanChoice(input.choice);
    const totals = { input: 0, output: 0, reasoning: 0, cached: 0 };
    for (const message of messages) {
      const usage = message.role === "assistant" ? message.metadata?.usage : undefined;
      totals.input += number(usage?.input);
      totals.output += number(usage?.output);
      totals.reasoning += number(usage?.reasoning);
      totals.cached += number(usage?.cached);
    }
    const known = this.written.get(input.id);
    const written = new Map<string, { hash: string; position: number }>();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO session (id, project_id, title, pinned, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, choice)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, pinned = excluded.pinned,
             time_updated = excluded.time_updated, tokens_input = excluded.tokens_input, tokens_output = excluded.tokens_output,
             tokens_reasoning = excluded.tokens_reasoning, tokens_cache_read = excluded.tokens_cache_read, choice = excluded.choice`
        )
        .run(
          input.id,
          typeof input.projectId === "string" ? input.projectId.slice(0, 100) : null,
          this.seal(String(input.title ?? "Untitled").slice(0, 500), at.title(input.id)),
          input.pinned ? 1 : 0,
          number(input.createdAt) || Date.now(),
          number(input.updatedAt) || Date.now(),
          totals.input,
          totals.output,
          totals.reasoning,
          totals.cached,
          choice ? JSON.stringify(choice) : null
        );
      const upsert = this.db.prepare(
        `INSERT INTO message (id, session_id, position, role, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, id) DO UPDATE SET position = excluded.position, role = excluded.role, data = excluded.data`
      );
      const move = this.db.prepare("UPDATE message SET position = ? WHERE session_id = ? AND id = ?");
      messages.forEach((message, position) => {
        const json = renameAttachments(JSON.stringify(message), this.renamed);
        const hash = digest(json);
        const before = known?.get(message.id);
        if (before?.hash !== hash) upsert.run(message.id, input.id, position, message.role, this.seal(json, at.message(input.id, message.id)));
        else if (before.position !== position) move.run(position, input.id, message.id);
        written.set(message.id, { hash, position });
      });
      const existing = this.db.prepare("SELECT id FROM message WHERE session_id = ?").all(input.id) as { id: string }[];
      const remove = this.db.prepare("DELETE FROM message WHERE session_id = ? AND id = ?");
      for (const row of existing) if (!written.has(row.id)) remove.run(input.id, row.id);
    });
    this.written.set(input.id, written);
  }

  /** A chat's title, project, pin and model, leaving its messages and token totals as they are. */
  private saveChat(input: SessionInput) {
    const choice = cleanChoice(input.choice);
    this.db
      .prepare("UPDATE session SET project_id = ?, title = ?, pinned = ?, time_updated = ?, choice = ? WHERE id = ?")
      .run(
        typeof input.projectId === "string" ? input.projectId.slice(0, 100) : null,
        this.seal(String(input.title ?? "Untitled").slice(0, 500), at.title(input.id)),
        input.pinned ? 1 : 0,
        number(input.updatedAt) || Date.now(),
        choice ? JSON.stringify(choice) : null,
        input.id
      );
  }

  /** Deleting a chat also deletes its request records, as in the original project lifecycle. */
  deleteSession(id: string) {
    if (!validId(id)) throw new Error("Invalid chat ID");
    this.transaction(() => {
      this.db.prepare("DELETE FROM session WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM request WHERE session_id = ?").run(id);
    });
    this.written.delete(id);
  }

  /** True once projects were imported or saved here; from then on the renderer's copy is never imported. */
  projectsImported() {
    return Boolean(this.db.prepare("SELECT 1 FROM setting WHERE key = 'projectsImported'").get());
  }

  listProjects(): StoredProject[] {
    return (this.db.prepare("SELECT * FROM project ORDER BY time_created, id").all() as Record<string, unknown>[]).map((row) => {
      const id = String(row.id);
      return {
        id,
        name: this.open(row.name, at.name(id)),
        createdAt: Number(row.time_created),
        updatedAt: Number(row.time_updated),
        ...(row.pinned ? { pinned: true } : {}),
        ...(row.collapsed ? { collapsed: true } : {}),
        ...(row.instructions ? { instructions: this.open(row.instructions, at.instructions(id)) } : {}),
        ...(row.access ? { access: sanitizePolicy(JSON.parse(this.open(row.access, at.access(id)))) } : {}),
        ...(row.rules ? { alwaysAllowed: cleanRules(JSON.parse(this.open(row.rules, at.rules(id)))) } : {}),
      };
    });
  }

  project(id: string) {
    return validId(id) ? this.listProjects().find((item) => item.id === id) : undefined;
  }

  saveProject(input: StoredProject): StoredProject {
    const project = cleanProject(input);
    this.transaction(() => {
      this.upsertProject(project);
      this.markProjectsImported();
    });
    return this.project(project.id)!;
  }

  /** Imports projects once. Existing rows win, so a repeated import never overwrites a newer save. */
  importProjects(input: StoredProject[]) {
    if (this.projectsImported()) return this.listProjects();
    const projects = (Array.isArray(input) ? input : []).flatMap((item) => {
      try {
        return [cleanProject(item)];
      } catch {
        return [];
      }
    });
    this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM project WHERE id = ?");
      for (const project of projects) if (!exists.get(project.id)) this.upsertProject(project);
      this.markProjectsImported();
    });
    return this.listProjects();
  }

  /** Chats in a removed project stay, without a project. */
  deleteProject(id: string) {
    if (!validId(id)) throw new Error("Invalid project ID");
    this.transaction(() => {
      this.db.prepare("DELETE FROM project WHERE id = ?").run(id);
      this.db.prepare("UPDATE session SET project_id = NULL WHERE project_id = ?").run(id);
      this.markProjectsImported();
    });
  }

  private upsertProject(project: StoredProject) {
    this.db
      .prepare(
        `INSERT INTO project (id, name, time_created, time_updated, pinned, collapsed, instructions, access, rules) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, time_updated = excluded.time_updated, pinned = excluded.pinned,
           collapsed = excluded.collapsed, instructions = excluded.instructions, access = excluded.access, rules = excluded.rules`
      )
      .run(
        project.id,
        this.seal(project.name, at.name(project.id)),
        project.createdAt,
        Date.now(),
        project.pinned ? 1 : 0,
        project.collapsed ? 1 : 0,
        project.instructions ? this.seal(project.instructions, at.instructions(project.id)) : null,
        project.access ? this.seal(JSON.stringify(project.access), at.access(project.id)) : null,
        // A rule's program can be a path, so the rules are sealed like the folders.
        project.alwaysAllowed ? this.seal(JSON.stringify(project.alwaysAllowed), at.rules(project.id)) : null
      );
  }

  private markProjectsImported() {
    this.db.prepare("INSERT INTO setting (key, value) VALUES ('projectsImported', 'true') ON CONFLICT (key) DO NOTHING").run();
  }

  settings(): HistorySettings {
    const row = this.db.prepare("SELECT value FROM setting WHERE key = 'retainRequests'").get() as { value: string } | undefined;
    return { retainRequests: row?.value === "true" };
  }

  setSettings(value: Partial<HistorySettings>) {
    if (typeof value.retainRequests === "boolean")
      this.db
        .prepare("INSERT INTO setting (key, value) VALUES ('retainRequests', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(String(value.retainRequests));
    return this.settings();
  }

  startRequest(input: { id: string; sessionId: string; runtime: string; model: string; origin: string; content?: unknown; time?: number }) {
    if (!validId(input.id)) throw new Error("Invalid request ID");
    const content = this.settings().retainRequests && input.content !== undefined ? JSON.stringify(input.content) : undefined;
    this.db
      .prepare(
        `INSERT INTO request (id, time, session_id, runtime, model, origin, status, content) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(
        input.id,
        input.time ?? Date.now(),
        String(input.sessionId).slice(0, 100),
        String(input.runtime).slice(0, 40),
        String(input.model).slice(0, 300),
        String(input.origin).slice(0, 300),
        content && content.length <= MAX_CONTENT ? this.seal(content, at.content(input.id)) : null
      );
    this.prune();
  }

  finishRequest(id: string, outcome: { status: Exclude<RequestStatus, "running">; reason?: string; usage?: Usage; durationMs?: number }) {
    this.db
      .prepare(
        `UPDATE request SET status = ?, reason = ?, duration_ms = ?, tokens_input = ?, tokens_output = ?, tokens_reasoning = ? WHERE id = ?`
      )
      .run(
        outcome.status,
        outcome.reason ? outcome.reason.slice(0, 500) : null,
        outcome.durationMs === undefined ? null : number(outcome.durationMs),
        number(outcome.usage?.input),
        number(outcome.usage?.output),
        number(outcome.usage?.reasoning),
        id
      );
  }

  /** Records past the count or age limit are removed whenever records are written or read. */
  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM request WHERE time < ?").run(now - REQUEST_DAYS * 86_400_000);
    this.db
      .prepare("DELETE FROM request WHERE id NOT IN (SELECT id FROM request ORDER BY time DESC LIMIT ?)")
      .run(MAX_REQUESTS);
  }

  listRequests(): HistoryRequest[] {
    this.prune();
    const titles = this.db.prepare("SELECT title FROM session WHERE id = ?");
    const titleOf = (session: string) => {
      const row = titles.get(session) as { title?: unknown } | undefined;
      return row ? this.open(row.title, at.title(session)) : undefined;
    };
    return (this.db.prepare("SELECT * FROM request ORDER BY time DESC").all() as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      time: Number(row.time),
      sessionId: String(row.session_id),
      sessionTitle: titleOf(String(row.session_id)),
      runtime: String(row.runtime),
      model: String(row.model),
      origin: String(row.origin),
      status: String(row.status) as RequestStatus,
      reason: row.reason ? String(row.reason) : undefined,
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      tokens: { input: Number(row.tokens_input), output: Number(row.tokens_output), reasoning: Number(row.tokens_reasoning) },
      content: row.content ? this.open(row.content, at.content(String(row.id))) : undefined,
    }));
  }

  deleteRequest(id: string) {
    if (!validId(id)) throw new Error("Invalid request ID");
    this.db.prepare("DELETE FROM request WHERE id = ?").run(id);
  }

  clearRequests() {
    this.db.exec("DELETE FROM request");
  }
}
