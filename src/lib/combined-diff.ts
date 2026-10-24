/**
 * All of the agent's changes to one file in a chat, as one diff (the Changes tab). A write records the whole file
 * before and after it; the agent's edits around it are applied to that text backwards and forwards, so the diff runs
 * from the file before the agent's first change to what it last wrote. When that cannot be worked out (only edits,
 * which record a few lines each, or lines that no longer match), the changes' hunks are shown one after another.
 */
import type { EditFileOutput } from "./types";

export interface FileChanges {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  /** The changes behind it, oldest first. */
  changes: EditFileOutput[];
}

interface Hunk {
  oldStart: number;
  newStart: number;
  old: string[];
  new: string[];
  context: boolean;
}
interface Parsed {
  hunks: Hunk[];
  created: boolean;
  deleted: boolean;
}

/** Lines of context around each change, as git shows them. */
const CONTEXT = 3;
/** Past this many changed lines the diff is shown as the old lines removed and the new ones added. */
const MAX_EDITS = 1000;

function parse(patch: string): Parsed {
  const hunks: Hunk[] = [];
  let created = false;
  let deleted = false;
  let hunk: Hunk | undefined;
  for (const line of patch.split("\n")) {
    if (!hunk && line.startsWith("--- ")) {
      created = line === "--- /dev/null";
      continue;
    }
    if (!hunk && line.startsWith("+++ ")) {
      deleted = line === "+++ /dev/null";
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = { oldStart: Number(header[1]), newStart: Number(header[2]), old: [], new: [], context: false };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const text = line.slice(1);
    if (line[0] === " ") {
      hunk.old.push(text);
      hunk.new.push(text);
      hunk.context = true;
    } else if (line[0] === "-") hunk.old.push(text);
    else if (line[0] === "+") hunk.new.push(text);
  }
  return { hunks, created, deleted };
}

/**
 * Whether a patch holds the whole file before and after: a write, or an edit with no context lines starting at the
 * first line (an edit shows up to two lines on each side, so none means there were none).
 */
const whole = ({ hunks, created }: Parsed) => hunks.length === 1 && !hunks[0].context && (created || hunks[0].oldStart <= 1);

const matchesAt = (text: string[], lines: string[], at: number) =>
  at >= 0 && at + lines.length <= text.length && lines.every((line, index) => text[at + index] === line);

/** Replaces a hunk's lines in `text`, forwards (old → new) or backwards; where it says, else wherever they appear once. */
function swap(text: string[] | null, hunk: Hunk, forwards: boolean): string[] | undefined {
  if (!text) return undefined;
  const [from, to] = forwards ? [hunk.old, hunk.new] : [hunk.new, hunk.old];
  let at = (forwards ? hunk.oldStart : hunk.newStart) - 1;
  if (!matchesAt(text, from, at)) {
    if (!from.length) return undefined;
    const found = text.flatMap((_, index) => (matchesAt(text, from, index) ? [index] : []));
    if (found.length !== 1) return undefined;
    at = found[0];
  }
  return [...text.slice(0, at), ...to, ...text.slice(at + from.length)];
}

/** The file before the first change (null when the agent created it) and after the last, when they can be worked out. */
function endpoints(parsed: Parsed[]): { from: string[] | null; to: string[] } | undefined {
  const anchor = parsed.findIndex(whole);
  if (anchor < 0) return undefined;
  let from: string[] | null = parsed[anchor].created ? null : parsed[anchor].hunks[0].old;
  for (let index = anchor - 1; index >= 0; index--) {
    if (parsed[index].hunks.length !== 1) return undefined;
    const earlier = swap(from, parsed[index].hunks[0], false);
    if (!earlier) return undefined;
    from = earlier;
  }
  let to = parsed[anchor].hunks[0].new;
  for (let index = anchor + 1; index < parsed.length; index++) {
    // A later write holds the whole file again.
    if (whole(parsed[index])) {
      to = parsed[index].hunks[0].new;
      continue;
    }
    if (parsed[index].hunks.length !== 1) return undefined;
    const later = swap(to, parsed[index].hunks[0], true);
    if (!later) return undefined;
    to = later;
  }
  return { from, to };
}

type Op = { kind: " " | "-" | "+"; text: string };

/** Myers' diff of two line lists, or nothing past `limit` changed lines. */
function myers(a: string[], b: string[], limit = MAX_EDITS): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const most = Math.min(n + m, limit);
  const offset = most + 1;
  const v = new Int32Array(2 * most + 3);
  // What each round started from, kept only as wide as that round reads.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= most; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
      let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const round = trace[d];
    const at = (k: number) => round[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      ops.push({ kind: " ", text: a[x] });
    }
    if (d > 0) ops.push(down ? { kind: "+", text: b[y - 1] } : { kind: "-", text: a[x - 1] });
    x = previousX;
    y = previousY;
  }
  return ops.reverse();
}

function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (text: string): Op => ({ kind: " ", text });
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const middle = myers(removed, added) ?? [...removed.map((text): Op => ({ kind: "-", text })), ...added.map((text): Op => ({ kind: "+", text }))];
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(endA).map(same)];
}

/** Unified diff hunks with CONTEXT lines around each change. */
function hunkLines(ops: Op[]): string[] {
  const groups: [number, number][] = [];
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    const last = groups.at(-1);
    if (last && index - last[1] <= 2 * CONTEXT + 1) last[1] = index;
    else groups.push([index, index]);
  });
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    oldBefore.push(oldLine);
    newBefore.push(newLine);
    if (op.kind !== "+") oldLine++;
    if (op.kind !== "-") newLine++;
  }
  return groups.flatMap(([first, last]) => {
    const from = Math.max(0, first - CONTEXT);
    const slice = ops.slice(from, Math.min(ops.length, last + CONTEXT + 1));
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    return [
      `@@ -${oldBefore[from] + (oldCount ? 1 : 0)},${oldCount} +${newBefore[from] + (newCount ? 1 : 0)},${newCount} @@`,
      ...slice.map((op) => op.kind + op.text),
    ];
  });
}

function combine(changes: EditFileOutput[]): FileChanges {
  const path = changes[0].path;
  const parsed = changes.map((change) => parse(change.patch));
  const ends = endpoints(parsed);
  if (ends) {
    const ops: Op[] = ends.from ? diffLines(ends.from, ends.to) : ends.to.map((text): Op => ({ kind: "+", text }));
    const lines = ends.from ? hunkLines(ops) : [`@@ -0,0 +1,${ends.to.length} @@`, ...ops.map((op) => op.kind + op.text)];
    return {
      path,
      additions: ops.filter((op) => op.kind === "+").length,
      deletions: ops.filter((op) => op.kind === "-").length,
      patch: [`--- ${ends.from ? `a/${path}` : "/dev/null"}`, `+++ ${parsed.at(-1)?.deleted ? "/dev/null" : `b/${path}`}`, ...lines].join("\n"),
      changes,
    };
  }
  const hunks = changes.flatMap((change) => {
    const lines = change.patch.split("\n");
    const at = lines.findIndex((line) => line.startsWith("@@"));
    return at < 0 ? [] : lines.slice(at);
  });
  return {
    path,
    additions: changes.reduce((sum, change) => sum + change.additions, 0),
    deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
    patch: [`--- ${parsed[0].created ? "/dev/null" : `a/${path}`}`, `+++ ${parsed.at(-1)?.deleted ? "/dev/null" : `b/${path}`}`, ...hunks].join("\n"),
    changes,
  };
}

/** Recent results, as the Changes tab is derived again while a reply streams. */
const recent = new Map<string, Omit<FileChanges, "changes">>();

/** One file's changes, oldest first, as one diff. A single change is shown as it was recorded. */
export function combineChanges(changes: EditFileOutput[]): FileChanges {
  if (changes.length === 1) {
    const [change] = changes;
    return { path: change.path, additions: change.additions, deletions: change.deletions, patch: change.patch, changes };
  }
  const key = changes.map((change) => change.patch).join("\0");
  const known = recent.get(key);
  if (known) return { ...known, changes };
  const combined = combine(changes);
  recent.set(key, { path: combined.path, additions: combined.additions, deletions: combined.deletions, patch: combined.patch });
  if (recent.size > 64) recent.delete(recent.keys().next().value!);
  return combined;
}
