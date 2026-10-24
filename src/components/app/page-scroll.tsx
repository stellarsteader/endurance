"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { ReactNode } from "react";

/**
 * The scrolling body of a right-side page: Settings sections and the Library. It uses the thin overlay
 * scrollbar of the model menu and the chat list, which takes no layout space. The scrollbar sits inside
 * the page's own side gutter, so the centered column stays in place whether or not the page scrolls.
 */
export function PageScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full" scrollbarClassName="w-1.5 p-0 py-1">
      <div className="px-8 py-6">{children}</div>
    </ScrollArea>
  );
}
