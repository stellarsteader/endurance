/**
 * The agent's tools: their definitions for native tool calling (the same definitions are written out for models
 * without it), how each call reads in the trace, and running file and web calls. A result is sized to the room
 * the context leaves for it (budget.resultRoom), never to a fixed length: a model with a large window reads a
 * file whole, one with a small window reads it in parts, told where to continue. File access goes through
 * Workspace, which enforces the project's folder permissions.
 */
import type { UIMessageStreamWriter } from "ai";
import { AccessDenied, MAX_DELETE, type Workspace } from "./workspace-tools";
import { webFetch, webSearch } from "./web";
import { charsFor, LEAST_RESULT } from "./budget";
import { readPieces, searchPieces, type Document } from "./documents";
import type { AppUIMessage, CotKind } from "../lib/types";

export type ToolName = "list" | "search" | "read" | "edit" | "write" | "delete" | "run_shell" | "web_search" | "fetch" | "read_document" | "search_document" | "update_todos" | "propose_plan" | "ask_user" | "use_skill" | "delegate";
export const TOOL_NAMES: readonly ToolName[] = ["list", "search", "read", "edit", "write", "delete", "run_shell", "web_search", "fetch", "read_document", "search_document", "update_todos", "propose_plan", "ask_user", "use_skill", "delegate"];
export const isTool = (value: unknown): value is ToolName => TOOL_NAMES.includes(value as ToolName);
/** Subagents one delegation may start. */
export const MAX_SUBAGENTS = 3;
/** Questions one request may ask the user; past that the agent goes on with its best judgment. */
export const MAX_QUESTIONS = 2;
const MOST_OPTIONS = 4;
/** A to-do list is for work with at least this many separate changes; fewer are just done. */
export const LEAST_TODOS = 3;
const MOST_TODOS = 20;
const TODO_STATES = ["pending", "in_progress", "completed"] as const;

const text = (description: string) => ({ type: "string", description });
const object = (properties: Record<string, object>, required: string[]) => ({ type: "object", properties, required });
const PATH = "Path as listed, starting with the folder name.";

const SPECS: Record<ToolName, { description: string; parameters: object }> = {
  list: { description: "List a folder in the project.", parameters: object({ path: text(PATH) }, ["path"]) },
  search: {
    description: "Find files by name or contents. Use a few words or code names; files with more of them come first.",
    parameters: object({ query: text("A few words or code names the files would contain."), path: text("Optional folder or file to search in.") }, ["query"]),
  },
  // Several paths in one call: a model that thinks plans its reads one by one and asks for one file per response even
  // when told to batch, but fills a list when the tool takes one (Gemma4 and Nemotron e4b, 8 of 8 with thinking on).
  read: {
    description: "Read files. List every file you need in paths at once. A long file comes in parts; the result says which line to continue from.",
    parameters: object(
      {
        paths: { type: "array", minItems: 1, items: text(PATH), description: "The files to read." },
        line: { type: "integer", minimum: 1, description: "Line to start from, to continue one long file." },
        start: { type: "integer", minimum: 0, description: "Character in that line to start from, to continue one very long line." },
      },
      ["paths"]
    ),
  },
  edit: {
    description: "Change part of an existing file. find is exact text from the file, unique in it. Read the file first.",
    parameters: object({ path: text(PATH), find: text("Exact lines copied from the file."), replace: text("The text that replaces them.") }, ["path", "find", "replace"]),
  },
  write: {
    description: "Create a file, or replace one with its full content. Missing folders on its path are created. Replacing a file needs a read of all of it first in this request. Use edit for small changes. Only Read & write folders allow writing.",
    parameters: object({ path: text(PATH), content: text("The full content of the file.") }, ["path", "content"]),
  },
  delete: {
    description: "Delete one or more files (not folders) in Read & write folders. The user can undo it, as with edit and write.",
    parameters: object({ paths: { type: "array", minItems: 1, items: text(PATH) } }, ["paths"]),
  },
  run_shell: {
    description:
      "Run a shell command (zsh) in a project folder, for builds, tests, git and checks. For reading, finding, changing or deleting files, the file tools work better: they follow each folder's access, and the user can undo their changes, which is not possible for a command's changes. It runs sandboxed: it writes only in Read & write folders, cannot open secrets or No access folders, has no network unless you set network, and stops after 2 minutes. Commands may need the user's approval.",
    parameters: object(
      {
        command: text("The command."),
        cwd: text("Folder to run in, as listed; the first project folder when left out."),
        network: { type: "boolean", description: "True only when the command must reach the internet, such as installing packages or git push. The user is asked first." },
      },
      ["command"]
    ),
  },
  web_search: {
    description: `Search the internet. Results are numbered sources. For recent topics include the year (${new Date().getFullYear()}).`,
    parameters: object({ query: text("Specific keywords.") }, ["query"]),
  },
  fetch: {
    description: "Read a web page, usually one from the search results. A long page comes in parts; the result says where to continue.",
    parameters: object({ url: text("The full https:// address."), start: { type: "integer", minimum: 0, description: "Character to continue a long page from." } }, ["url"]),
  },
  read_document: {
    description: "Read pieces of a document from the conversation (one too long to send whole), from a piece number on. Long reads come in parts; the result says where to continue.",
    parameters: object({ document: text("The document's id, such as D1."), piece: { type: "integer", minimum: 1, description: "The piece to start from." } }, ["document", "piece"]),
  },
  search_document: {
    description: "Find which pieces of the conversation's documents mention something. Use a few words; the best matches come first, with the line that matched.",
    parameters: object({ query: text("A few words the pieces would contain."), document: text("Optional document id, such as D1; all of them when left out.") }, ["query"]),
  },
  update_todos: {
    description: `Keep a to-do list for work with ${LEAST_TODOS} or more separate changes: send the whole list each time, each item pending, in_progress or completed, and mark items as you finish them. Not for a single change or a question.`,
    parameters: object(
      {
        items: {
          type: "array",
          minItems: LEAST_TODOS,
          maxItems: MOST_TODOS,
          items: object({ title: text("What this step changes, in a few words."), status: { type: "string", enum: [...TODO_STATES] } }, ["title", "status"]),
        },
      },
      ["items"]
    ),
  },
  propose_plan: {
    description:
      "Before work with several changes where the approach matters or is unclear, propose a plan and wait: the user approves it, asks for changes or cancels. Read what you need first. Not for a small change or a question.",
    parameters: object(
      {
        title: text("What the plan does, in a few words."),
        summary: text("The approach in one or two sentences."),
        steps: { type: "array", minItems: 1, maxItems: 12, items: object({ title: text("The step."), detail: text("What it changes and where.") }, ["title"]) },
      },
      ["title", "steps"]
    ),
  },
  ask_user: {
    description:
      "Ask the user one question and wait for the answer, only when you cannot go on without their choice and it is not in the conversation or the files. Not to confirm, not for what you can find out yourself, never the same question twice. Give 2 to 4 short options, the one you recommend first, and set multiple when several of them may be chosen together; the user may also answer in their own words.",
    parameters: object(
      {
        question: text("The question, in the user's language."),
        options: { type: "array", minItems: 2, maxItems: MOST_OPTIONS, items: { type: "string" }, description: "Short answers to choose from." },
        multiple: { type: "boolean", description: "True when the user may choose several options." },
      },
      ["question"]
    ),
  },
  use_skill: {
    description: "Load the full instructions of an installed skill when the request matches its description.",
    parameters: object({ skill: text("The skill's name, exactly as listed.") }, ["skill"]),
  },
  delegate: {
    description:
      "Give bounded, independent work to subagents. Each works in a fresh conversation and reports back once, so its reading and searching stay out of yours. Use it to look through many files or several separate areas (one assignment each), or for independent changes to separate files. Not for one file, a quick lookup, or the step you need before anything else. Subagents know nothing of this conversation: give each a complete task with the goal, the files or folders, what is already known and what to return. Kind explore only reads and searches; kind work may also change the files in its paths, so give work assignments different files. Check what a subagent reports before relying on it. Subagents cannot delegate or ask the user.",
    parameters: object(
      {
        assignments: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SUBAGENTS,
          items: object(
            {
              name: text("A short name."),
              kind: { type: "string", enum: ["explore", "work"], description: "explore: reads and searches only. work: may also change files in its paths." },
              task: text("The complete task."),
              paths: { type: "array", items: { type: "string" }, description: "The files or folders it covers; a work assignment changes only these." },
            },
            ["name", "kind", "task"]
          ),
        },
      },
      ["assignments"]
    ),
  },
};

/** Tool definitions for the request. A skill name is limited to installed ones, so it cannot be invented. */
export function definitions(names: readonly ToolName[], skills: readonly string[] = []) {
  return names.map((name) => {
    const spec = SPECS[name];
    const parameters =
      name === "use_skill" && skills.length ? object({ skill: { type: "string", enum: [...skills], description: "The skill's name." } }, ["skill"]) : spec.parameters;
    return { name, description: spec.description, inputSchema: parameters as never };
  });
}

/** The same tools written out, for a model that calls them by writing JSON. */
export const toolGuide = (names: readonly ToolName[]) =>
  names.map((name) => `- ${name} ${JSON.stringify((SPECS[name].parameters as { properties: object }).properties)}: ${SPECS[name].description}`).join("\n");

export interface Args {
  path?: string;
  paths?: string[];
  query?: string;
  line?: number;
  find?: string;
  replace?: string;
  content?: string;
  url?: string;
  start?: number;
  skill?: string;
  document?: string;
  piece?: number;
  todos?: { title?: string; status?: string }[];
  title?: string;
  summary?: string;
  steps?: { title?: string; detail?: string }[];
  assignments?: { name?: string; kind?: "explore" | "work"; task?: string; paths?: string[] }[];
  command?: string;
  network?: boolean;
  cwd?: string;
  question?: string;
  options?: string[];
  multiple?: boolean;
}

const string = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined);
const whole = (value: unknown) => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
};

/** A call's arguments, read leniently: a JSON string is parsed, numbers written as text are numbers. */
export function argsOf(input: unknown): Args {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const assignments = Array.isArray(raw.assignments)
    ? raw.assignments.map((item) => {
        const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        // An assignment without a kind may change files, as every assignment could before kinds.
        const kind = string(entry.kind)?.trim().toLowerCase() === "explore" ? ("explore" as const) : ("work" as const);
        return { name: string(entry.name), kind, task: string(entry.task), paths: Array.isArray(entry.paths) ? entry.paths.flatMap((path) => string(path) ?? []) : undefined };
      })
    : undefined;
  // Small models give one path as a string, or as `path`.
  const paths = (Array.isArray(raw.paths) ? raw.paths : typeof raw.paths === "string" ? [raw.paths] : raw.path !== undefined ? [raw.path] : [])
    .map((item) => string(item)?.trim())
    .filter((item): item is string => Boolean(item));
  return {
    path: string(raw.path)?.trim(),
    paths,
    query: string(raw.query)?.trim(),
    line: whole(raw.line),
    find: string(raw.find),
    replace: string(raw.replace),
    content: string(raw.content),
    url: string(raw.url)?.trim(),
    start: whole(raw.start),
    skill: string(raw.skill)?.trim(),
    document: string(raw.document)?.trim().toUpperCase(),
    piece: whole(raw.piece),
    todos: Array.isArray(raw.items)
      ? raw.items.map((item) => {
          const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return { title: string(entry.title)?.trim(), status: string(entry.status) };
        })
      : undefined,
    title: string(raw.title)?.trim(),
    summary: string(raw.summary)?.trim(),
    steps: Array.isArray(raw.steps)
      ? raw.steps.map((item) => {
          const entry: Record<string, unknown> = item && typeof item === "object" ? (item as Record<string, unknown>) : { title: item };
          return { title: string(entry.title)?.trim(), detail: string(entry.detail)?.trim() };
        })
      : undefined,
    assignments,
    command: string(raw.command)?.trim(),
    cwd: string(raw.cwd)?.trim(),
    network: raw.network === true || raw.network === "true",
    question: string(raw.question)?.trim(),
    // Small models write options as objects or a single string; each becomes a short line of text.
    options: (Array.isArray(raw.options) ? raw.options : typeof raw.options === "string" ? raw.options.split(/\n|;/) : [])
      .map((item) => string(item && typeof item === "object" ? (item as Record<string, unknown>).label : item)?.trim())
      .filter((item): item is string => Boolean(item)),
    multiple: raw.multiple === true || raw.multiple === "true",
  };
}

/** What a call is missing to run, said as a fact; undefined when it can run. */
export function missing(name: ToolName, args: Args) {
  if ((name === "search" || name === "web_search" || name === "search_document") && !args.query) return "Not run: a search needs a query.";
  if (name === "fetch" && !/^https?:\/\//.test(args.url ?? "")) return "Not run: fetch needs a full https:// address.";
  if (name === "read" && !args.paths?.length) return "Not run: read needs the paths of the files to read.";
  if ((name === "edit" || name === "write") && !args.path) return `Not run: ${name} needs a path.`;
  if (name === "delete" && !args.paths?.length) return "Not run: delete needs the paths of the files to delete.";
  if (name === "edit" && (!args.find || args.replace === undefined)) return "Not run: edit needs the exact text to find and its replacement.";
  if (name === "write" && args.content === undefined) return "Not run: write needs the full file content.";
  if (name === "run_shell" && !args.command) return "Not run: run_shell needs a command.";
  if (name === "use_skill" && !args.skill) return "Not run: use_skill needs a skill name from the skills list.";
  if (name === "propose_plan" && !(args.steps ?? []).some((step) => step.title)) return "Not run: a plan needs its steps.";
  if (name === "ask_user" && !args.question) return "Not asked: ask_user needs the question.";
  if (name === "update_todos" && (args.todos ?? []).filter((item) => item.title).length < LEAST_TODOS)
    return `Not run: a to-do list is for work with ${LEAST_TODOS} or more separate changes. Do this work directly.`;
  if (name === "delegate" && !(args.assignments ?? []).some((item) => item.task?.trim())) return "Not run: delegate needs at least one assignment with a task.";
  return undefined;
}

type TodoArg = { title?: string; status?: string };
const titleWords = (title: string) => new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const wordShare = (one: string, other: string) => {
  const mine = titleWords(one);
  const theirs = titleWords(other);
  return [...mine].filter((word) => theirs.has(word)).length / Math.max(mine.size, theirs.size, 1);
};
const sameStep = (one: string, other: string) => one.trim().toLowerCase() === other.trim().toLowerCase() || wordShare(one, other) >= 0.5;

/**
 * A to-do update shorter than the list kept is taken as the steps it changes, the rest standing as they were.
 * Nemotron e4b on Ollama sent only the step it had just finished; taken as a whole list it was refused for being too
 * short, and no step was marked done until the end. Each step is found by its title, else by most shared words, else
 * it is the step in progress (or the first open one), which a progress report is most likely about. With no step left
 * in progress, the next open one starts, so the reminder can name it.
 */
export function mergeTodos(current: readonly TodoArg[] | undefined, update: readonly TodoArg[]): TodoArg[] {
  const named = update.filter((item) => item.title);
  if (!current?.length || named.length >= current.length) return [...update];
  // An update naming none of the kept steps is a new list for new work, not progress on the old one.
  if (!named.some((item) => current.some((other) => sameStep(other.title ?? "", item.title!)))) return [...update];
  const merged = current.map((item) => ({ ...item }));
  const open = () => merged.findIndex((item) => item.status === "in_progress");
  for (const item of named) {
    const mine = titleWords(item.title!);
    let best = merged.findIndex((other) => other.title?.trim().toLowerCase() === item.title!.trim().toLowerCase());
    if (best < 0) {
      let score = 0.5;
      merged.forEach((other, index) => {
        const theirs = titleWords(other.title ?? "");
        const shared = [...mine].filter((word) => theirs.has(word)).length / Math.max(mine.size, theirs.size, 1);
        if (shared >= score) [best, score] = [index, shared + Number.EPSILON];
      });
    }
    if (best < 0) best = open() >= 0 ? open() : merged.findIndex((other) => other.status !== "completed");
    if (best >= 0) merged[best].status = item.status;
  }
  if (open() < 0) {
    const next = merged.find((item) => item.status !== "completed");
    if (next) next.status = "in_progress";
  }
  return merged;
}

/** How each tool appears in the trace: its kind, and its verb while running, once done, and when it failed. */
const TRACE: Record<ToolName, { kind: CotKind; verbs: readonly [active: string, done: string, failed: string] }> = {
  list: { kind: "list", verbs: ["Looking in", "Looked in", "look in"] },
  search: { kind: "search", verbs: ["Searching for", "Searched for", "search for"] },
  read: { kind: "read", verbs: ["Reading", "Read", "read"] },
  edit: { kind: "write", verbs: ["Editing", "Edited", "edit"] },
  write: { kind: "write", verbs: ["Writing", "Wrote", "write"] },
  delete: { kind: "write", verbs: ["Deleting", "Deleted", "delete"] },
  run_shell: { kind: "verify", verbs: ["Running", "Ran", "run"] },
  web_search: { kind: "web", verbs: ["Searching the web for", "Searched the web for", "search the web for"] },
  fetch: { kind: "page", verbs: ["Reading", "Read", "read"] },
  read_document: { kind: "read", verbs: ["Reading", "Read", "read"] },
  update_todos: { kind: "think", verbs: ["Updating", "Updated", "update"] },
  propose_plan: { kind: "think", verbs: ["Proposing", "Proposed", "propose"] },
  ask_user: { kind: "think", verbs: ["Asking", "Asked", "ask"] },
  search_document: { kind: "search", verbs: ["Searching", "Searched", "search"] },
  use_skill: { kind: "skill", verbs: ["Using", "Used", "use"] },
  delegate: { kind: "delegate", verbs: ["Delegating to", "Delegated to", "delegate to"] },
};

function subject(name: ToolName, args: Args) {
  if (name === "list") return args.path || "the project";
  if (name === "search") return `“${args.query ?? ""}”${args.path ? ` in ${args.path}` : ""}`;
  if (name === "web_search") return `“${args.query ?? ""}”`;
  if (name === "fetch") return args.url?.replace(/^https?:\/\//, "").slice(0, 80) || "a page";
  if (name === "use_skill") return args.skill || "a skill";
  if (name === "run_shell") return `\`${(args.command ?? "").replace(/\s+/g, " ").slice(0, 80)}\``;
  if (name === "update_todos") return "the to-do list";
  if (name === "propose_plan") return args.title ? `a plan: ${args.title}` : "a plan";
  if (name === "ask_user") return `you: “${(args.question ?? "").replace(/\s+/g, " ").slice(0, 80)}”`;
  if (name === "read_document") return `${args.document || "the document"}${args.piece && args.piece > 1 ? ` from piece ${args.piece}` : ""}`;
  if (name === "search_document") return `${args.document || "the documents"} for “${args.query ?? ""}”`;
  if (name === "delegate") return (args.assignments ?? []).map((item) => item.name).filter(Boolean).join(", ") || "subagents";
  if (name === "delete" || (name === "read" && (args.paths?.length ?? 0) > 1))
    return args.paths?.length ? `${args.paths[0]}${args.paths.length > 1 ? ` and ${args.paths.length - 1} more` : ""}` : "files";
  if (name === "read") return `${args.paths?.[0] || args.path || "a file"}${args.line && args.line > 1 ? ` from line ${args.line}` : ""}`;
  return args.path || "a file";
}

export const kindOf = (name: ToolName) => TRACE[name].kind;

/** The trace's words for a call. */
export function wording(name: ToolName, args: Args) {
  const [active, done, failed] = TRACE[name].verbs;
  const what = subject(name, args);
  return { active: `${active} ${what}`, done: `${done} ${what}`, failed: `Couldn't ${failed} ${what}` };
}

export interface Source {
  n: number;
  url: string;
  title: string;
}

export interface ToolContext {
  workspace: Workspace;
  writer: UIMessageStreamWriter<AppUIMessage>;
  signal: AbortSignal;
  sources: Source[];
  /** Tokens this result may take, and the runtime's tokens per estimated token. */
  room: number;
  ratio: number;
  /** Text from the conversation too long to send whole (./documents). */
  documents?: Document[];
}

export interface Outcome {
  /** What goes back to the model. */
  text: string;
  /** Short names for the trace. */
  files?: string[];
  /** Files a read showed from first line to last, which a write may then replace (agent seesFile). */
  whole?: string[];
  /** Folder access refused it. */
  blocked?: string;
  level?: "none" | "read" | "secret";
  /** Files it changed or deleted. */
  wrote?: string | string[];
  /** The change's own card (its diff), drawn at the call's step in the trace instead of a second row after it. */
  card?: string;
  failed?: string;
  /** The whole failure when `failed` is only its start, such as an edit's hint with the closest lines. */
  detail?: string;
}

function cite(context: ToolContext, url: string, title: string) {
  const known = context.sources.find((source) => source.url === url);
  if (known) return known.n;
  const source = { n: context.sources.length + 1, url, title };
  context.sources.push(source);
  context.writer.write({ type: "source-url", sourceId: `source-${source.n}`, url, title });
  return source.n;
}

const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Text from the internet, marked as such: a page may hold instructions written for a model, and these tags are what
 * the system prompt tells the model never to follow (agent webNote). A closing tag inside the text cannot end it early.
 */
const fromWeb = (text: string) => `<web_content>\n${text.replace(/<\/?web_content>/gi, "")}\n</web_content>`;

/** Whole blocks that fit in `size` characters, then what was left out. */
function fitBlocks(blocks: string[], size: number, rest: (left: number) => string) {
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (kept.length && used + block.length + 1 > size) break;
    kept.push(block.length > size ? `${block.slice(0, size)}…` : block);
    used += block.length + 1;
  }
  const left = blocks.length - kept.length;
  return kept.join("\n") + (left ? `\n${rest(left)}` : "");
}

/** A plan as the approval card shows it, from the call's arguments. */
export const planOf = (args: Args) => ({
  title: args.title || "Plan",
  summary: args.summary ?? "",
  steps: (args.steps ?? []).filter((step) => step.title).map((step) => ({ title: step.title!.slice(0, 160), detail: (step.detail ?? "").slice(0, 600) })),
});

/** A question as its card shows it: one question and up to MOST_OPTIONS distinct answers, a lone option dropped. */
export function questionOf(args: Args) {
  const options = [...new Set((args.options ?? []).map((option) => option.slice(0, 160)))].slice(0, MOST_OPTIONS);
  const offered = options.length >= 2 ? options : [];
  return { question: (args.question ?? "").slice(0, 600), options: offered, ...(args.multiple && offered.length ? { multiple: true } : {}) };
}

const mb = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

/**
 * Deletes files, each checked and kept as a copy for undoing as one delete would be (Workspace.delete). Every file is
 * checked first: past MAX_DELETE of copies nothing is deleted, so one call cannot remove more than can be undone.
 * Files that cannot be deleted are named with the reason; the others are deleted.
 */
async function deleteFiles(context: ToolContext, paths: string[]): Promise<Outcome> {
  const { workspace, writer } = context;
  const reason = (error: unknown) => `${error instanceof AccessDenied ? "Denied" : "Not deleted"}: ${error instanceof Error ? error.message : "the delete failed."}`;
  const checked = await Promise.all(paths.map((path) => workspace.deletable(path).then((file) => ({ path, size: file.size }), (error: unknown) => ({ path, error }))));
  const total = checked.reduce((sum, file) => sum + ("size" in file ? file.size : 0), 0);
  if (total > MAX_DELETE)
    return { text: `Not run: these files would keep ${mb(total)} of copies for undoing, more than the ${mb(MAX_DELETE)} one delete may keep. Nothing was deleted. Tell the user; they can delete them themselves.`, failed: "Too large to undo" };
  const deleted: string[] = [];
  const problems: unknown[] = [];
  const lines: string[] = [];
  for (const file of checked) {
    if (context.signal.aborted) break;
    try {
      if ("error" in file) throw file.error;
      const result = await workspace.delete(file.path);
      const id = `edit-${crypto.randomUUID()}`;
      writer.write({ type: "tool-input-available", toolCallId: id, toolName: "edit_file", input: { path: result.path }, dynamic: true });
      writer.write({ type: "tool-output-available", toolCallId: id, output: result, dynamic: true });
      deleted.push(result.path);
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push(error);
      lines.push(reason(error));
    }
  }
  if (deleted.length) lines.unshift(`Deleted ${deleted.join(", ")}.`);
  if (deleted.length || !problems.length) return { text: lines.join("\n"), wrote: deleted, files: deleted.slice(0, 8) };
  const denied = problems.find((error): error is AccessDenied => error instanceof AccessDenied);
  return denied && problems.every((error) => error instanceof AccessDenied)
    ? { text: lines.join("\n"), blocked: denied.message, level: denied.level }
    : { text: lines.join("\n"), failed: (problems[0] instanceof Error ? problems[0].message : "Not deleted").slice(0, 120) };
}

/** Runs a file or web call. use_skill, delegate, propose_plan and ask_user are run by the agent, which holds the run's state. */
export async function runTool(context: ToolContext, name: ToolName, args: Args): Promise<Outcome> {
  const { workspace, writer } = context;
  const size = charsFor(context.room, context.ratio);
  const reads = name === "read" || name === "list" || name === "search" || name === "web_search" || name === "fetch" || name === "read_document" || name === "search_document";
  if (reads && context.room < LEAST_RESULT) return { text: "Not run: the context has no room left for another result. Answer with what you have.", failed: "No room left" };
  try {
    if (name === "web_search") {
      const found = await webSearch(args.query ?? "", context.signal);
      if (!found.results.length) return { text: found.raw ? fromWeb(found.raw.slice(0, size)) : `No web results for "${found.query}".` };
      // Each result gets an equal share, so the last ones are not dropped for the first one's length.
      const share = Math.max(200, Math.floor(size / found.results.length) - 120);
      const lines = found.results.map((result) => `[${cite(context, result.url, result.title)}] ${result.title} — ${result.url}\n${result.text.length > share ? `${result.text.slice(0, share)}…` : result.text}`);
      return { text: fromWeb(lines.join("\n\n")), files: [...new Set(found.results.map((result) => domain(result.url)))].slice(0, 6) };
    }
    if (name === "fetch") {
      const page = await webFetch(args.url ?? "", context.signal);
      const n = cite(context, page.url, page.title);
      const start = Math.min(args.start ?? 0, page.text.length);
      const header = `[${n}] ${page.title} — ${page.url}`;
      const end = Math.min(page.text.length, start + Math.max(200, size - header.length - 120));
      const where = start > 0 || end < page.text.length ? ` (characters ${start}–${end} of ${page.text.length})` : "";
      const more = end < page.text.length ? `\n… more below. Fetch again with start ${end} to continue.` : "";
      return { text: `${header}${where}\n${fromWeb(page.text.slice(start, end))}${more}`, files: [domain(page.url)] };
    }
    if (name === "update_todos") {
      // One list per reply, replaced in place each time; the result repeats it so the model sees where it is.
      const items = (args.todos ?? [])
        .filter((item) => item.title)
        .slice(0, MOST_TODOS)
        .map((item, index) => ({ id: `todo-${index + 1}`, title: item.title!.slice(0, 120), status: TODO_STATES.find((state) => state === item.status) ?? "pending" }));
      writer.write({ type: "data-todos", id: "todos", data: { items } });
      const done = items.filter((item) => item.status === "completed").length;
      const marks = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
      return { text: `To-do list (${done} of ${items.length} done):\n${items.map((item) => `${marks[item.status]} ${item.title}`).join("\n")}` };
    }
    if (name === "read_document" || name === "search_document") {
      const documents = context.documents ?? [];
      const named = args.document ? documents.filter((document) => document.id === args.document) : documents;
      if (!named.length) return { text: `Not run: there is no document ${args.document ?? ""}. Documents: ${documents.map((document) => document.id).join(", ") || "none"}.`, failed: "No such document" };
      if (name === "read_document") return { text: readPieces(named[0], args.piece ?? 1, size), files: [named[0].name] };
      const found = searchPieces(named, args.query ?? "");
      if (!found.length) return { text: `No piece mentions any of: ${args.query}.` };
      const lines = found.map(({ document, piece, line }) => `${document.id} piece #${piece.n} (lines ${piece.from}–${piece.to})${piece.heading ? ` § ${piece.heading}` : ""}: ${line}`);
      return { text: `${lines.join("\n")}\nRead a piece with read_document.`, files: [...new Set(found.map(({ document }) => document.name))] };
    }
    if (name === "list") {
      const listed = await workspace.list(args.path || workspace.label(workspace.policy.folders[0].path));
      const names = listed.entries.map((entry) => `${entry.path}${entry.directory ? "/" : ""}${entry.secret ? " (secret: cannot be opened)" : ""}`);
      if (!names.length) return { text: "(empty folder)" };
      return { text: fitBlocks(names, size, (left) => `… ${left} more entries.`) + (listed.more ? "\n…" : ""), files: listed.entries.slice(0, 8).map((entry) => entry.name) };
    }
    if (name === "search") {
      const found = await workspace.search(args.query ?? "", args.path || undefined);
      if (!found.files.length) return { text: `No file contains any of: ${found.terms.join(", ")}.` };
      const blocks = found.files.map((file) =>
        [`${file.path}${file.count ? ` (${file.count} matching line${file.count === 1 ? "" : "s"})` : " (name matches)"}`, ...file.lines.map((line) => `  ${line.line}: ${line.text}`)].join("\n")
      );
      const words = found.terms.length > 1 && found.partial ? `No file has all of: ${found.terms.join(", ")}. Files with the most of them:\n` : "";
      const total = found.total - found.files.length;
      const listed = fitBlocks(blocks, size - words.length, (left) => `… ${left + total} more files.`);
      return { text: `${words}${listed}${total && !listed.includes("more files") ? `\n… ${total} more files.` : ""}`, files: found.files.map((file) => file.path).slice(0, 8) };
    }
    if (name === "read") {
      // Each file gets an equal share of the result's room; `line` continues one long file.
      const paths = [...new Set(args.paths ?? [])];
      const share = Math.floor(size / paths.length);
      const read = async (path: string) => {
        try {
          const one = paths.length === 1;
          const file = await workspace.read(path, one ? args.line : undefined, share - 160, one ? args.start : undefined);
          if (file.binary) return { text: `${file.path} is a binary file.`, path: file.path };
          const span =
            file.nextColumn !== undefined
              ? ` (line ${file.start}, characters ${file.column}–${file.nextColumn} of a long line; ${file.lines} line${file.lines === 1 ? "" : "s"} in all)`
              : file.column
                ? ` (line ${file.start} from character ${file.column}, through line ${file.end} of ${file.lines})`
                : file.start > 1 || file.truncated
                  ? ` (lines ${file.start}–${file.end} of ${file.lines})`
                  : "";
          const again = `Read ${paths.length > 1 ? `${file.path} ` : ""}again from`;
          const more = file.nextColumn
            ? `\n… this line goes on. ${again} line ${file.start}, start ${file.nextColumn} to continue.`
            : file.next
              ? `\n… more below. ${again} line ${file.next} to continue.`
              : file.truncated && !file.column
                ? "\n… the file is larger than can be read here."
                : "";
          return { text: `${file.path}${span}:\n${file.content}${more}`, path: file.path, whole: !span && !more };
        } catch (error) {
          // One file that cannot be read leaves the others' results; alone, it fails the call as before.
          if (paths.length === 1 || context.signal.aborted) throw error;
          return { text: `${path}: ${error instanceof AccessDenied ? "Denied" : "Failed"}: ${error instanceof Error ? error.message : "it could not be read."}`, path: undefined };
        }
      };
      const results = await Promise.all(paths.map(read));
      return {
        text: results.map((result) => result.text).join("\n\n"),
        files: results.flatMap((result) => (result.path ? [result.path] : [])),
        whole: results.flatMap((result) => (result.path && "whole" in result && result.whole ? [result.path] : [])),
      };
    }
    if (name === "edit") {
      const edited = await workspace.edit(args.path ?? "", args.find ?? "", args.replace ?? "");
      const id = `edit-${crypto.randomUUID()}`;
      writer.write({ type: "tool-input-available", toolCallId: id, toolName: "edit_file", input: { path: edited.path }, dynamic: true });
      writer.write({ type: "tool-output-available", toolCallId: id, output: edited, dynamic: true });
      // The change as it was written, which may differ from what the call sent: a loose match re-indents it and keeps
      // the file's line endings (Workspace.edit). Seeing it, the model need not read the file again to check.
      const said = `Edited ${edited.path}: replaced ${edited.deletions} line${edited.deletions === 1 ? "" : "s"} with ${edited.additions}.`;
      const room = size - said.length - 40;
      const change = edited.patch.length <= room ? edited.patch : room > 200 ? `${edited.patch.slice(0, room)}\n… the rest of the change is left out.` : "";
      return { text: change ? `${said} The change as written:\n${change}` : said, wrote: edited.path, card: id };
    }
    if (name === "write") {
      const written = await workspace.write(args.path ?? "", args.content ?? "");
      const id = `edit-${crypto.randomUUID()}`;
      writer.write({ type: "tool-input-available", toolCallId: id, toolName: "edit_file", input: { path: written.path }, dynamic: true });
      writer.write({ type: "tool-output-available", toolCallId: id, output: written, dynamic: true });
      return { text: `${written.created ? "Created" : "Replaced"} ${written.path} (${written.additions} lines).`, wrote: written.path, card: id };
    }
    if (name === "delete") return await deleteFiles(context, [...new Set(args.paths ?? [])]);
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : "The action failed.";
    if (error instanceof AccessDenied) return { text: `Denied: ${message}`, blocked: message, level: error.level };
    // The trace shows the failure's first line; the rest (an edit's closest lines) opens under it.
    const failed = message.split("\n")[0].slice(0, 120);
    return { text: `Failed: ${message}`, failed, ...(message.length > failed.length ? { detail: message } : {}) };
  }
  return { text: `Not run: ${name} is not available here.`, failed: "Not available" };
}
