"use client";

import { cn } from "@/lib/utils";
import { Fragment, type ReactNode } from "react";

/**
 * A unified patch drawn as a reviewer reads one, as Claude Code, Codex and GitHub draw edits: each line on a tinted
 * row (added green, removed red) with its old and new line numbers, the changed words of a replaced line marked more
 * strongly, the file headers left out, and a thin divider between hunks. Syntax colouring alone left additions and
 * removals told apart only by the colour of their text.
 */

type Kind = "context" | "added" | "removed";
interface Row {
  kind: Kind;
  text: string;
  old?: number;
  new?: number;
  /** The span that differs from the line it replaces, for a removed line followed by its replacement. */
  changed?: [start: number, end: number];
}
type Block = { type: "hunk"; label: string } | { type: "row"; row: Row };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/;

function parse(patch: string): Block[] {
  const blocks: Block[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      blocks.push({ type: "hunk", label: hunk[3] ?? "" });
      continue;
    }
    if (!blocks.length && !line) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "+") blocks.push({ type: "row", row: { kind: "added", text, new: newLine++ } });
    else if (mark === "-") blocks.push({ type: "row", row: { kind: "removed", text, old: oldLine++ } });
    else blocks.push({ type: "row", row: { kind: "context", text: mark === " " ? text : line, old: oldLine++, new: newLine++ } });
  }
  markChanges(blocks);
  return blocks;
}

/** Pairs each run of removed lines with the added lines after it and marks what differs between the two, line by line. */
function markChanges(blocks: Block[]) {
  const rows = blocks.map((block) => (block.type === "row" ? block.row : undefined));
  for (let at = 0; at < rows.length; ) {
    if (rows[at]?.kind !== "removed") {
      at++;
      continue;
    }
    let end = at;
    while (rows[end]?.kind === "removed") end++;
    let added = end;
    while (rows[added]?.kind === "added") added++;
    for (let i = 0; i < Math.min(end - at, added - end); i++) span(rows[at + i]!, rows[end + i]!);
    at = added;
  }
}

function span(removed: Row, added: Row) {
  const a = removed.text;
  const b = added.text;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let tail = 0;
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  // A line rewritten whole has nothing in common worth showing, so only its row is tinted.
  if (start + tail < Math.min(a.length, b.length) / 3) return;
  removed.changed = [start, a.length - tail];
  added.changed = [start, b.length - tail];
}

const ROW: Record<Kind, string> = {
  context: "",
  added: "bg-emerald-500/12",
  removed: "bg-red-500/12",
};
/** The number gutter a shade darker than its row, as GitHub's, so the code and its line numbers read apart. */
const GUTTER: Record<Kind, string> = {
  context: "",
  added: "bg-emerald-500/20",
  removed: "bg-red-500/20",
};
const MARK: Record<Kind, string> = { context: " ", added: "+", removed: "−" };
const WORD: Record<Kind, string> = { context: "", added: "rounded-[2px] bg-emerald-500/30", removed: "rounded-[2px] bg-red-500/30" };

function Text({ row }: { row: Row }): ReactNode {
  if (!row.changed) return row.text || " ";
  const [start, end] = row.changed;
  return (
    <>
      {row.text.slice(0, start)}
      <span className={WORD[row.kind]}>{row.text.slice(start, end)}</span>
      {row.text.slice(end)}
    </>
  );
}

export function DiffView({ patch, className }: { patch: string; className?: string }) {
  const blocks = parse(patch);
  return (
    <div aria-label="Changes" className={cn("overflow-auto rounded-[6px] bg-muted/40 py-1 font-mono text-[12px] leading-[1.6]", className)} role="group">
      <div className="grid min-w-full grid-cols-[auto_auto_auto_1fr]">
        {blocks.map((block, index) =>
          block.type === "hunk" ? (
            // The first hunk needs no divider above it; later ones mark a jump in the file.
            index === 0 ? null : (
              <div className="col-span-4 my-1 border-foreground/10 border-t" key={index} role="separator" />
            )
          ) : (
            <Fragment key={index}>
              <span className={cn("select-none px-2 text-right text-muted-foreground/70 tabular-nums", GUTTER[block.row.kind])}>{block.row.old ?? ""}</span>
              <span className={cn("select-none pr-2 text-right text-muted-foreground/70 tabular-nums", GUTTER[block.row.kind])}>{block.row.new ?? ""}</span>
              <span
                className={cn(
                  "select-none pr-2",
                  ROW[block.row.kind],
                  block.row.kind === "added" && "text-emerald-600 dark:text-emerald-400",
                  block.row.kind === "removed" && "text-red-600 dark:text-red-400"
                )}
              >
                {MARK[block.row.kind]}
              </span>
              <span className={cn("whitespace-pre-wrap break-all pr-3", ROW[block.row.kind])}>
                <Text row={block.row} />
              </span>
            </Fragment>
          )
        )}
      </div>
    </div>
  );
}
