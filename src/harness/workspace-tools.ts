/**
 * File tools for project folders. Every call resolves the real path first, so a symbolic link cannot
 * reach outside a project folder, then checks the effective folder access before touching the file.
 * Denials explain the permission instead of claiming the target is missing (Endurance spec: project-controls.md).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import {
  accessFor,
  displayPath,
  folderLabels,
  inheritedFrom,
  rootOf,
  within,
  ACCESS_LABEL,
  type WorkspacePolicy,
} from "../lib/workspace-policy";
import { agentWrite, contentHash, keepCopy, MAX_COPY, nextSequence } from "./file-copies";
import { ABSENT } from "../lib/file-undo";

export const IGNORED = new Set([".git", "node_modules", ".DS_Store", ".next", "dist", "out", "out-dev", "build", "coverage", ".venv", "__pycache__", ".cache"]);
/** Generated files whose matches are noise in a search. They can still be listed and read. */
const UNSEARCHED = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock", "go.sum"]);

/**
 * Files that usually hold credentials, in .gitignore syntax. The agent sees that they exist but cannot read,
 * search or change them, whatever the folder's access; examples and templates stay readable.
 */
export const SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "*.env",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!.env.dist",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "!*.pub",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  ".secrets",
  "*.tfvars",
  "terraform.tfstate*",
  ".aws/",
  ".ssh/",
  ".gnupg/",
  ".docker/config.json",
  ".kube/config",
];
const secretRules = ignore().add(SECRET_PATTERNS);
/** Characters one read returns when the caller gives no size; the agent sizes reads to the room it has. */
const DEFAULT_READ = 16_000;
const MAX_SEARCH_BYTES = 1_000_000;
const MAX_SEARCH_FILES = 2_000;
/** Files looked at for @ mentions, which read names only. */
const MAX_MENTION_FILES = 10_000;
const MAX_SEARCH_TERMS = 6;
const LINES_PER_FILE = 3;
const MAX_WRITE = 512_000;
/** The most one delete may keep as copies for undoing, as much as one attached document; past it nothing is deleted. */
export const MAX_DELETE = 200 * 1024 * 1024;

export interface SearchFile {
  path: string;
  /** How many of the query's words the file contains, in its path or its lines. */
  terms: number;
  /** Matching lines in the whole file; `lines` keeps the best few. */
  count: number;
  lines: { line: number; text: string }[];
}

/**
 * Where a word may start in a line: each name's start and its camelCase, digit and snake_case parts, in lower
 * case. "ArrowDownIcon" gives "arrowdownicon", "downicon" and "icon", so "down" matches it and "dropdown" does not.
 */
export function wordStarts(text: string) {
  const starts: string[] = [];
  for (const [name] of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    for (let index = 0; index < name.length; index++) {
      const [before, here, after] = [name[index - 1], name[index], name[index + 1]];
      const upper = (char?: string) => Boolean(char && /\p{Lu}/u.test(char));
      const lower = (char?: string) => Boolean(char && /\p{Ll}/u.test(char));
      const digit = (char?: string) => Boolean(char && /\p{N}/u.test(char));
      if (index === 0 || (upper(here) && (lower(before) || digit(before) || (upper(before) && lower(after)))) || (digit(here) && !digit(before)))
        starts.push(name.slice(index).toLowerCase());
    }
  }
  return starts;
}

/** Plain ASCII words match where a word starts; anything else, such as "bottom-4" or Korean, matches anywhere. */
function matching(terms: string[], text: string) {
  const lower = text.toLowerCase();
  let starts: string[] | undefined;
  return terms.filter((term) => {
    if (!/^[a-z0-9]+$/.test(term)) return lower.includes(term);
    if (!lower.includes(term)) return false;
    starts ??= wordStarts(text);
    return starts.some((start) => start.startsWith(term));
  });
}

/** Query words, so "scroll down arrow" finds code that never has that exact phrase. */
export const searchTerms = (query: string) =>
  [
    ...new Set(
      String(query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .map((word) => word.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, ""))
        .filter((word) => word.length >= 2)
    ),
  ].slice(0, MAX_SEARCH_TERMS);

export class AccessDenied extends Error {
  constructor(message: string, readonly target: string, readonly level?: "none" | "read" | "secret") {
    super(message);
  }
}

export interface Entry {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
  /** A credentials file such as .env: listed, but never read, searched or written. */
  secret?: boolean;
}

export interface WriteResult {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  created: boolean;
  /**
   * What undoing needs (./file-copies): the file before the change, kept as `attachment:<id>`, or null when the
   * change created it. Left out when no copy could be kept.
   */
  before?: string | null;
  /** SHA-256 of the file before the change; left out when it did not exist. */
  beforeHash?: string;
  /** SHA-256 of what was written, or ABSENT when the change deleted the file. */
  after: string;
  /** The change deleted the file. */
  deleted?: boolean;
}

async function real(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await real(parent), path.basename(target));
  }
}

export class Workspace {
  private readonly labels: Map<string, string>;
  private readonly gitignores = new Map<string, Promise<Ignore | undefined>>();
  /** When this was made: a chat rewound since refuses this run's writes (./file-copies). */
  private readonly started = nextSequence();
  constructor(readonly policy: WorkspacePolicy) {
    this.labels = folderLabels(policy);
  }

  /** The folder's own .gitignore. Nested .gitignore files are not read. */
  private gitignore(root: string) {
    let rules = this.gitignores.get(root);
    if (!rules) {
      rules = fs.readFile(path.join(root, ".gitignore"), "utf8").then(
        (text) => ignore().add(text),
        () => undefined
      );
      this.gitignores.set(root, rules);
    }
    return rules;
  }

  /**
   * Whether outlines and searches leave a path out: dependencies, build output and what the folder's
   * .gitignore excludes. Listing and reading such a path by name still works.
   */
  private async hidden(absolute: string, directory: boolean) {
    if (IGNORED.has(path.basename(absolute))) return true;
    const root = rootOf(this.policy, absolute);
    if (!root || root.path === absolute) return false;
    const relative = path.relative(root.path, absolute);
    return Boolean((await this.gitignore(root.path))?.ignores(directory ? `${relative}/` : relative));
  }

  /**
   * Whether a path matches SECRET_PATTERNS. Measured from above the folder, so a project folder such as .ssh
   * counts too. Tried as a folder as well, since a path checked before it is opened may be either.
   */
  secret(absolute: string) {
    const root = rootOf(this.policy, absolute);
    if (!root) return false;
    const relative = path.relative(path.dirname(root.path), absolute);
    return secretRules.ignores(relative) || secretRules.ignores(`${relative}/`);
  }

  get empty() {
    return this.policy.folders.length === 0;
  }

  /** Accepts "folder/relative/path" as shown to the model, or an absolute path inside a folder. */
  resolve(input: string): string {
    const value = String(input ?? "").trim().replace(/^\.\/+/, "");
    if (!value || value.includes("\0")) throw new AccessDenied("Choose a file or folder inside this project.", value);
    if (value.startsWith("/")) {
      const absolute = path.resolve(value);
      if (!rootOf(this.policy, absolute)) throw new AccessDenied(`${value} is outside this project's folders.`, value);
      return absolute;
    }
    const [head, ...rest] = value.split("/");
    const folder =
      this.policy.folders.find((item) => this.labels.get(item.path) === head) ??
      (this.policy.folders.length === 1 ? this.policy.folders[0] : undefined);
    if (!folder) throw new AccessDenied(`${head} is not one of this project's folders.`, value);
    const relative = this.labels.get(folder.path) === head ? rest.join("/") : value;
    const absolute = path.resolve(folder.path, relative);
    if (!within(folder.path, absolute)) throw new AccessDenied(`${value} is outside this project's folders.`, value);
    return absolute;
  }

  label(absolute: string) {
    return displayPath(this.policy, absolute);
  }

  /** `contents` is false only for listing, which shows names inside a secrets folder but nothing in them. */
  private async check(input: string, need: "read" | "write", contents = true) {
    const absolute = this.resolve(input);
    const resolved = await real(absolute);
    // A link may point elsewhere: both the lexical and the real location must be allowed.
    const levels = [accessFor(this.policy, absolute), accessFor(this.policy, resolved)];
    const level = levels.includes("none") ? "none" : levels.includes("read") ? "read" : "write";
    const shown = this.label(absolute);
    if (level === "none") throw new AccessDenied(this.refusal(absolute, shown, "none"), shown, "none");
    if (contents && (this.secret(absolute) || this.secret(resolved)))
      throw new AccessDenied(`${shown} looks like a secrets file, such as .env or a private key. You cannot open or change it; ask the user for the value you need.`, shown, "secret");
    if (need === "write" && level !== "write")
      throw new AccessDenied(this.refusal(absolute, shown, "read"), shown, "read");
    return { absolute, resolved, shown };
  }

  /**
   * Why a path was refused, written for a small model: where the setting is (the path itself or a
   * folder above it), that it is the person's setting rather than an error, that No access paths are hidden from
   * listings, and what to do instead. "Its folder is set to No access" alone was read as "the file does not exist".
   * It says the setting holds for now and the user can change it, never "do not try again": the person may change
   * the access between messages, and the folder list of the next request shows it.
   */
  private refusal(absolute: string, shown: string, level: "none" | "read") {
    const parent = inheritedFrom(this.policy, absolute);
    const where = parent && parent.access === level ? `the folder ${this.label(parent.path)}, which contains ${shown},` : shown;
    if (level === "none")
      return `Not allowed: the user set ${where} to ${ACCESS_LABEL.none}. While it is set so, you cannot open, read or list it, and No access files and folders are hidden from folder listings, so it does not appear there. This is the user's setting, not an error, and they can change it. Tell the user it is set to ${ACCESS_LABEL.none} and go on with what you can read.`;
    return `Not allowed: the user set ${where} to ${ACCESS_LABEL.read}. While it is set so, you can read it but not change, create or delete files there. Tell the user; they can change the folder's access.`;
  }

  /** Files elsewhere in the project with the name of a path that does not exist, for a model that guessed a folder. */
  private async alike(absolute: string, limit = 5) {
    const name = path.basename(absolute).toLowerCase();
    const stem = name.replace(/\.[^.]+$/, "");
    const same: string[] = [];
    const close: string[] = [];
    let visited = 0;
    const walk = async (directory: string): Promise<void> => {
      let items;
      try {
        items = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (visited++ >= MAX_SEARCH_FILES || same.length >= limit) return;
        if (item.isSymbolicLink()) continue;
        const child = path.join(directory, item.name);
        if (accessFor(this.policy, child) === "none" || (await this.hidden(child, item.isDirectory())) || this.secret(child)) continue;
        if (item.isDirectory()) await walk(child);
        else if (item.name.toLowerCase() === name) same.push(this.label(child));
        else if (stem.length >= 3 && item.name.toLowerCase().startsWith(`${stem}.`)) close.push(this.label(child));
      }
    };
    for (const folder of this.policy.folders) if (folder.access !== "none") await walk(folder.path);
    return [...same, ...close].slice(0, limit);
  }

  /** A missing path explains itself and names similar files, instead of a bare ENOENT. */
  private async missing(error: unknown, absolute: string, shown: string): Promise<never> {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const found = await this.alike(absolute);
    throw new Error(
      `${shown} does not exist. ${found.length ? `Files with that name: ${found.join(", ")}.` : "List its parent folder or search for the name to find the right path."}`
    );
  }

  async list(input: string, limit = 200): Promise<{ entries: Entry[]; more: boolean }> {
    const { absolute, resolved, shown } = await this.check(input, "read", false);
    const items = await fs.readdir(resolved, { withFileTypes: true }).catch((error: unknown) => this.missing(error, absolute, shown));
    const entries: Entry[] = [];
    for (const item of items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (IGNORED.has(item.name)) continue;
      const child = path.join(resolved, item.name);
      if (accessFor(this.policy, child) === "none") continue;
      entries.push({
        name: item.name,
        path: this.label(child),
        directory: item.isDirectory(),
        symlink: item.isSymbolicLink(),
        ...(this.secret(child) ? { secret: true } : {}),
      });
      if (entries.length > limit) break;
    }
    return { entries: entries.slice(0, limit), more: entries.length > limit };
  }

  /**
   * Reads a text file from `from` (a 1-based line, default 1) for up to `max` characters, ending on a whole
   * line. `next` is the line to continue from when more is left.
   */
  /**
   * Files whose shown path contains `query`, for @ mentions in the composer. Only names are read. Leaves out
   * what searches leave out: no-access folders, ignored and .gitignore'd paths, secrets files and links.
   */
  async files(query: string, limit = 30) {
    const needle = String(query ?? "").trim().toLowerCase().slice(0, 200);
    const found: { path: string; rank: number; depth: number }[] = [];
    let visited = 0;
    const walk = async (directory: string): Promise<void> => {
      let items;
      try {
        items = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (visited >= MAX_MENTION_FILES) return;
        if (item.isSymbolicLink()) continue;
        const child = path.join(directory, item.name);
        if (accessFor(this.policy, child) === "none" || (await this.hidden(child, item.isDirectory())) || this.secret(child)) continue;
        if (item.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!item.isFile()) continue;
        visited++;
        const shown = this.label(child);
        const name = item.name.toLowerCase();
        // Names that start with the query first, then names that hold it, then folders on the way that do.
        const rank = !needle ? 0 : name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : shown.toLowerCase().includes(needle) ? 2 : -1;
        if (rank >= 0) found.push({ path: shown, rank, depth: shown.split("/").length });
      }
    };
    for (const folder of this.policy.folders) if (folder.access !== "none") await walk(folder.path);
    found.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.path.localeCompare(b.path));
    return { files: found.slice(0, limit).map((file) => file.path), more: found.length > limit || visited >= MAX_MENTION_FILES };
  }

  async read(input: string, from = 1, max = DEFAULT_READ) {
    const { absolute, resolved, shown } = await this.check(input, "read");
    const stat = await fs.stat(resolved).catch((error: unknown) => this.missing(error, absolute, shown));
    if (stat.isDirectory()) throw new AccessDenied(`${shown} is a folder. List it instead.`, shown);
    const handle = await fs.open(resolved, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_SEARCH_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, 8000).includes(0)) return { path: shown, content: "", binary: true, truncated: false, start: 1, end: 0, lines: 0 };
      const all = buffer.toString("utf8").split("\n");
      // A file larger than the buffer may end mid-line; its last line is not counted as whole.
      if (stat.size > buffer.length) all.pop();
      const start = Math.min(Math.max(1, Math.floor(from) || 1), Math.max(1, all.length));
      let end = start - 1;
      let size = 0;
      const limit = Math.max(200, max);
      while (end < all.length && (end === start - 1 || size + all[end].length + 1 <= limit)) size += all[end++].length + 1;
      const content = all.slice(start - 1, end).join("\n").slice(0, limit);
      const truncated = end < all.length || stat.size > buffer.length;
      return { path: shown, content, binary: false, truncated, start, end, lines: all.length, ...(end < all.length ? { next: end + 1 } : {}) };
    } finally {
      await handle.close();
    }
  }

  /**
   * Case-insensitive search for the query's words in file paths and lines, grouped by file. Files holding
   * more of the words rank first, so a phrase still finds code that uses only some of them.
   * Restricted folders are skipped before they are traversed; ignored ones too, unless searched by name.
   */
  async search(query: string, input?: string, limit = 10) {
    const terms = searchTerms(query);
    if (!terms.length) throw new AccessDenied("Search for at least two characters.", "");
    const starts = input
      ? [(await this.check(input, "read")).resolved]
      : this.policy.folders.filter((folder) => folder.access !== "none").map((folder) => folder.path);
    const files: SearchFile[] = [];
    /** The most words any one line of a file holds, the second ranking key. */
    const best = new Map<SearchFile, number>();
    let visited = 0;
    const walk = async (directory: string, filtered: boolean): Promise<void> => {
      let items;
      try {
        items = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (visited >= MAX_SEARCH_FILES) return;
        if (item.isSymbolicLink()) continue;
        const child = path.join(directory, item.name);
        if (accessFor(this.policy, child) === "none") continue;
        if (filtered ? await this.hidden(child, item.isDirectory()) : IGNORED.has(item.name)) continue;
        if (this.secret(child)) continue;
        if (item.isDirectory()) {
          await walk(child, filtered);
          continue;
        }
        if (!item.isFile() || UNSEARCHED.has(item.name)) continue;
        visited++;
        const shown = this.label(child);
        const found = new Set(matching(terms, shown));
        const lines: { line: number; text: string; hits: number }[] = [];
        try {
          const stat = await fs.stat(child);
          if (stat.size <= MAX_SEARCH_BYTES) {
            const buffer = await fs.readFile(child);
            if (!buffer.subarray(0, 8000).includes(0))
              buffer
                .toString("utf8")
                .split("\n")
                .forEach((text, index) => {
                  const hit = matching(terms, text);
                  if (!hit.length) return;
                  hit.forEach((term) => found.add(term));
                  lines.push({ line: index + 1, text: text.trim().slice(0, 160), hits: hit.length });
                });
          }
        } catch {
          /* Unreadable files are skipped, as a search does not promise every file. */
        }
        if (!found.size) continue;
        const top = lines.toSorted((a, b) => b.hits - a.hits || a.line - b.line).slice(0, LINES_PER_FILE);
        const file = { path: shown, terms: found.size, count: lines.length, lines: top.toSorted((a, b) => a.line - b.line).map(({ line, text }) => ({ line, text })) };
        files.push(file);
        best.set(file, top[0]?.hits ?? 0);
      }
    };
    for (const start of starts) await walk(start, !(input && (await this.hidden(start, true))));
    files.sort((a, b) => b.terms - a.terms || best.get(b)! - best.get(a)! || b.count - a.count || a.path.localeCompare(b.path));
    return {
      query: terms.join(" "),
      terms,
      files: files.slice(0, limit),
      total: files.length,
      /** No file holds every word: the results are the closest ones. */
      partial: files.length > 0 && files[0].terms < terms.length,
      truncated: files.length > limit || visited >= MAX_SEARCH_FILES,
    };
  }

  /**
   * Replaces one exact piece of a file. The text must appear exactly once, so a small model cannot change the
   * wrong place or rewrite a whole file to change a line.
   */
  edit(input: string, find: string, replace: string): Promise<WriteResult> {
    return agentWrite(this.started, () => this.replaceText(input, find, replace));
  }

  private async replaceText(input: string, find: string, replace: string): Promise<WriteResult> {
    const { absolute, resolved, shown } = await this.check(input, "write");
    const bytes = await fs.readFile(resolved).catch((error: unknown) => this.missing(error, absolute, shown));
    const before = bytes.toString("utf8");
    if (!find) throw new Error("Edit needs the exact text to replace.");
    const at = before.indexOf(find);
    if (at < 0) throw new Error(`The text to replace is not in ${shown}. Read the file and copy the lines exactly, including spaces.`);
    if (before.indexOf(find, at + 1) >= 0) throw new Error(`The text to replace appears more than once in ${shown}. Include more of the surrounding lines.`);
    const after = before.slice(0, at) + replace + before.slice(at + find.length);
    const written = Buffer.from(after, "utf8");
    if (written.byteLength > MAX_WRITE) throw new AccessDenied("That file is too large to write here.", shown);
    // The exact bytes, kept before the write, so the change can be undone.
    const copy = await keepCopy(bytes);
    await fs.writeFile(resolved, written);
    // One hunk around the change, with up to two lines of context on each side.
    const old = before.split("\n");
    const next = after.split("\n");
    const first = before.slice(0, at).split("\n").length - 1;
    const removed = find.split("\n").length;
    const added = replace.split("\n").length;
    const top = Math.max(0, first - 2);
    const tail = Math.min(2, old.length - first - removed);
    const patch = [
      `--- a/${shown}`,
      `+++ b/${shown}`,
      `@@ -${top + 1},${first - top + removed + tail} +${top + 1},${first - top + added + tail} @@`,
      ...old.slice(top, first).map((line) => ` ${line}`),
      ...old.slice(first, first + removed).map((line) => `-${line}`),
      ...next.slice(first, first + added).map((line) => `+${line}`),
      ...old.slice(first + removed, first + removed + tail).map((line) => ` ${line}`),
    ].join("\n");
    return {
      path: shown,
      additions: added,
      deletions: removed,
      patch,
      created: false,
      ...(copy ? { before: copy } : {}),
      beforeHash: contentHash(bytes),
      after: contentHash(written),
    };
  }

  write(input: string, content: string): Promise<WriteResult> {
    return agentWrite(this.started, () => this.writeText(input, content));
  }

  private async writeText(input: string, content: string): Promise<WriteResult> {
    const text = String(content ?? "");
    const written = Buffer.from(text, "utf8");
    if (written.byteLength > MAX_WRITE) throw new AccessDenied("That file is too large to write here.", input);
    const { resolved, shown } = await this.check(input, "write");
    let bytes: Buffer | undefined;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) throw new AccessDenied(`${shown} is a folder.`, shown);
      bytes = await fs.readFile(resolved);
    } catch (error) {
      if (error instanceof AccessDenied) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const previous = bytes?.toString("utf8");
    // The exact bytes, kept before the write, so the change can be undone; a new file is undone by deleting it.
    const copy = bytes === undefined ? null : await keepCopy(bytes);
    // Missing parents are created only after the write check on the final path.
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, written);
    const before = previous === undefined ? [] : previous.split("\n");
    const after = text.split("\n");
    const patch = [
      `--- ${previous === undefined ? "/dev/null" : `a/${shown}`}`,
      `+++ b/${shown}`,
      `@@ -${before.length ? 1 : 0},${before.length} +1,${after.length} @@`,
      ...before.map((line) => `-${line}`),
      ...after.map((line) => `+${line}`),
    ].join("\n");
    return {
      path: shown,
      additions: after.length,
      deletions: before.length,
      patch,
      created: previous === undefined,
      ...(copy !== undefined ? { before: copy } : {}),
      ...(bytes ? { beforeHash: contentHash(bytes) } : {}),
      after: contentHash(written),
    };
  }

  /**
   * Deletes one file, through the same checks as a write. A copy is kept first so it can be undone like an edit; a
   * file too large to keep a copy of is not deleted. Folders and links are not deleted here.
   */
  delete(input: string): Promise<WriteResult> {
    return agentWrite(this.started, () => this.deleteFile(input));
  }

  /** What deleting a file would keep as its copy, checked as the delete checks it, without deleting anything. */
  async deletable(input: string) {
    const { absolute, resolved, shown } = await this.check(input, "write");
    const stat = await fs.lstat(absolute).catch((error: unknown) => this.missing(error, absolute, shown));
    if (stat.isDirectory()) throw new Error(`${shown} is a folder; delete removes files, not folders.`);
    if (stat.isSymbolicLink()) throw new Error(`${shown} is a link; delete removes files, not links.`);
    if (stat.size > MAX_COPY)
      throw new Error(`${shown} is larger than ${MAX_COPY / 1024 / 1024} MB, too large to keep a copy for undoing. Tell the user; they can delete it themselves.`);
    return { resolved, shown, size: stat.size };
  }

  private async deleteFile(input: string): Promise<WriteResult> {
    const { resolved, shown } = await this.deletable(input);
    const bytes = await fs.readFile(resolved);
    const copy = await keepCopy(bytes);
    await fs.unlink(resolved);
    // The removed lines, as a diff shows a deleted file; a binary or very large file is named without its lines.
    const text = bytes.byteLength <= MAX_WRITE && !bytes.subarray(0, 8000).includes(0) ? bytes.toString("utf8") : undefined;
    // A final newline ends the last line rather than starting another.
    const lines = text === undefined || text === "" ? [] : text.replace(/\n$/, "").split("\n");
    const patch = [`--- a/${shown}`, "+++ /dev/null", ...(lines.length ? [`@@ -1,${lines.length} +0,0 @@`, ...lines.map((line) => `-${line}`)] : [])].join("\n");
    return {
      path: shown,
      additions: 0,
      deletions: lines.length,
      patch,
      created: false,
      deleted: true,
      ...(copy ? { before: copy } : {}),
      beforeHash: contentHash(bytes),
      after: ABSENT,
    };
  }

  /**
   * Puts back a file the agent changed, through the same checks as a write: a folder now Read only or No access,
   * or a secrets file, is refused. Only while the file still holds exactly what the agent last wrote (`expected`,
   * its SHA-256, or ABSENT for a file the agent deleted, which must still be gone): anything else is "changed" and
   * left alone. `original` gives the bytes to put back, null to delete a file the agent created, or nothing when the
   * copy is no longer kept ("missing").
   */
  async putBack(input: string, expected: string, original: () => Promise<Uint8Array | null | undefined>): Promise<"restored" | "deleted" | "changed" | "missing"> {
    const { resolved } = await this.check(input, "write");
    let current: Buffer | undefined;
    try {
      current = await fs.readFile(resolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EISDIR" || (code === "ENOENT" && expected !== ABSENT)) return "changed";
      if (code !== "ENOENT") throw error;
    }
    if (current ? contentHash(current) !== expected : expected !== ABSENT) return "changed";
    if (!current) {
      const bytes = await original();
      if (bytes === undefined) return "missing";
      // Created and then deleted by the agent: gone, as it was before.
      if (bytes === null) return "deleted";
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, bytes);
      return "restored";
    }
    const bytes = await original();
    if (bytes === undefined) return "missing";
    if (bytes === null) {
      await fs.unlink(resolved);
      return "deleted";
    }
    await fs.writeFile(resolved, bytes);
    return "restored";
  }

  /**
   * A short outline for the model: one line per folder, with its full path as the tools take it, its access
   * when it differs from its parent's, and its files. Shallow folders come first; ignored ones are left out.
   */
  async outline(maxChars = 6000, maxDepth = 6, filesPerFolder = 30) {
    const lines: string[] = [];
    let size = 0;
    let more = false;
    const queue: { directory: string; depth: number; root: boolean }[] = this.policy.folders
      .filter((folder) => folder.access !== "none")
      .map((folder) => ({ directory: folder.path, depth: 0, root: true }));
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { directory, depth, root } = next;
      let items;
      try {
        items = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      const files: string[] = [];
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.isSymbolicLink()) continue;
        const child = path.join(directory, item.name);
        if (accessFor(this.policy, child) === "none" || (await this.hidden(child, item.isDirectory())) || this.secret(child)) continue;
        if (!item.isDirectory()) files.push(item.name);
        else if (depth < maxDepth) queue.push({ directory: child, depth: depth + 1, root: false });
        else more = true;
      }
      const level = accessFor(this.policy, directory);
      const note = root || level !== accessFor(this.policy, path.dirname(directory)) ? ` (${ACCESS_LABEL[level].toLowerCase()})` : "";
      const shown = files.slice(0, filesPerFolder).join(", ") + (files.length > filesPerFolder ? `, +${files.length - filesPerFolder} more` : "");
      const line = `${this.label(directory)}/${note}${shown ? `: ${shown}` : ""}`;
      if (size + line.length > maxChars) {
        more = true;
        break;
      }
      lines.push(line);
      size += line.length + 1;
    }
    if (more) lines.push("… more folders not shown. List a folder to see inside it.");
    return lines.join("\n");
  }
}
