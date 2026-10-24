"use client";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cloneElement, isValidElement, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { extractTableDataFromElement, tableDataToTSV, type Components } from "streamdown";

/**
 * Tables and code blocks in replies: one box each, without the library's toolbar, and a copy icon just outside
 * the box's bottom-right corner. Streamdown's own controls (copy menu, download, full screen) are turned off where
 * these are used.
 */

interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

const textOf = (node: HastNode | undefined): string =>
  !node ? "" : node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");

function CopyBelow({ copy }: { copy: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  return (
    // The icon's right edge lines up with the box's; the row's height is the gap before what follows.
    <div className="mt-1 flex justify-end">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Copy"
              className="-mr-[5px] text-muted-foreground"
              onClick={() =>
                void copy().then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              size="icon-xs"
              type="button"
              variant="ghost"
            />
          }
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function Table({ children, className, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  const table = useRef<HTMLTableElement>(null);
  // The markdown node comes with the props; it is not an attribute.
  const attributes = { ...props };
  delete attributes.node;
  // Tab-separated text pastes into a spreadsheet as cells; the HTML keeps the table in a document.
  const copy = async () => {
    if (!table.current) return;
    const text = tableDataToTSV(extractTableDataFromElement(table.current));
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([table.current.outerHTML], { type: "text/html" }) }),
      ]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  };
  return (
    <div className="mt-4 mb-3" data-streamdown="table-wrapper">
      <div className="overflow-x-auto rounded-[12px] border border-border bg-background">
        <table className={["w-full divide-y divide-border", className].filter(Boolean).join(" ")} data-streamdown="table" ref={table} {...attributes}>
          {children}
        </table>
      </div>
      <CopyBelow copy={copy} />
    </div>
  );
}

function Pre({ children, node }: { children?: ReactNode; node?: HastNode }) {
  // As Streamdown's own: the code inside renders as a block.
  const block = isValidElement(children) ? cloneElement(children as React.ReactElement<Record<string, unknown>>, { "data-block": "true" }) : children;
  const copy = () => navigator.clipboard.writeText(textOf(node).replace(/\n$/, ""));
  return (
    <div className="mt-4 mb-3" data-streamdown="code-frame">
      {block}
      <CopyBelow copy={copy} />
    </div>
  );
}

export const markdownComponents: Components = { table: Table, pre: Pre } as Components;
