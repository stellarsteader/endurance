"use client";

import { Button } from "@/components/ui/button";
import { findInConversation, findPattern, type FindMatch } from "@/lib/conversation-search";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useSession } from "./session-context";

const OPEN = "endurance:find-in-chat";
const ALL = "endurance-find";
const CURRENT = "endurance-find-current";

/** Opens the find bar of the chat on screen (⌘F, the command palette). */
export function openFindInChat() {
  window.dispatchEvent(new Event(OPEN));
}

/** Where the phrase shows in a message's text on screen: one range per occurrence inside a single text node. */
function rangesIn(element: Element, pattern: RegExp) {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const found of (node.nodeValue ?? "").matchAll(pattern)) {
      const range = document.createRange();
      range.setStart(node, found.index);
      range.setEnd(node, found.index + found[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}

const highlights = (): HighlightRegistry | undefined => (typeof CSS === "undefined" ? undefined : CSS.highlights);

/**
 * Find in the open chat: searches the messages (lib/conversation-search), counts the occurrences, and moves to one
 * on Enter. Occurrences on screen are marked with the CSS Custom Highlight API, so the messages are not re-rendered.
 * A jump stops the view from following a streaming reply, as scrolling up by hand does. Only the main chat on
 * screen opens it; a side chat or a chat in the background does not.
 */
export function FindBar() {
  const { chat, active, isSide } = useSession();
  const enabled = active && !isSide;
  const { scrollRef, contentRef, stopScroll } = useStickToBottomContext();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [jump, setJump] = useState(0);
  // Kept while the chat is off screen, like a browser tab's find bar, but shown and searched only on screen.
  const visible = open && enabled;
  const matches = useMemo(() => (visible ? findInConversation(chat.messages, query) : []), [visible, chat.messages, query]);
  const shown = matches.length ? Math.min(current, matches.length - 1) : -1;

  useEffect(() => {
    if (!enabled) return;
    const onOpen = () => {
      setOpen(true);
      // After any dialog that opened it (the command palette) has given focus back.
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    window.addEventListener(OPEN, onOpen);
    return () => window.removeEventListener(OPEN, onOpen);
  }, [enabled]);

  const element = useCallback(
    (match: FindMatch) => contentRef.current?.querySelector(`[data-message-id="${CSS.escape(match.messageId)}"]`) ?? undefined,
    [contentRef]
  );

  // Marks every occurrence on screen, and the current one apart; redrawn as messages change.
  const currentRange = useRef<Range | undefined>(undefined);
  useEffect(() => {
    const registry = highlights();
    const pattern = findPattern(query);
    const content = contentRef.current;
    currentRange.current = undefined;
    if (!registry || !visible || !pattern || !content) return;
    const all: Range[] = [];
    const target = matches[shown];
    for (const message of content.querySelectorAll("[data-message-id]")) {
      const ranges = rangesIn(message, pattern);
      all.push(...ranges);
      if (target && message.getAttribute("data-message-id") === target.messageId) currentRange.current = ranges[Math.min(target.occurrence, ranges.length - 1)];
    }
    registry.set(ALL, new Highlight(...all));
    if (currentRange.current) registry.set(CURRENT, new Highlight(currentRange.current));
    return () => {
      registry.delete(ALL);
      registry.delete(CURRENT);
    };
  }, [visible, query, matches, shown, contentRef]);

  // Moves to the current occurrence when the person asks for it, not when a streaming reply changes the matches.
  useEffect(() => {
    const target = matches[shown];
    const scroll = scrollRef.current;
    const message = target && element(target);
    if (!scroll || !message || !(message instanceof HTMLElement)) return;
    stopScroll();
    const range = currentRange.current;
    const box = range?.getBoundingClientRect() ?? message.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    if (box.top < view.top + 48 || box.bottom > view.bottom - 48) {
      scroll.scrollTo({ top: scroll.scrollTop + box.top - view.top - scroll.clientHeight / 3, behavior: "smooth" });
    }
    // Without a mark in the text (it spans formatting), the whole message shows where it is.
    if (!range) message.animate([{ backgroundColor: "rgb(250 204 21 / 0.18)" }, { backgroundColor: "transparent" }], { duration: 1200, easing: "ease-out" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  if (!visible) return null;

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  // A new phrase starts at the first occurrence from the top of the view, as a browser's find does.
  const change = (value: string) => {
    setQuery(value);
    const view = scrollRef.current?.getBoundingClientRect();
    const first = view ? findInConversation(chat.messages, value).findIndex((match) => (element(match)?.getBoundingClientRect().bottom ?? 0) >= view.top) : -1;
    setCurrent(Math.max(0, first));
    setJump((n) => n + 1);
  };
  const step = (by: number) => {
    if (!matches.length) return;
    setCurrent((shown + by + matches.length) % matches.length);
    setJump((n) => n + 1);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  return (
    <div
      className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-2.5 text-popover-foreground shadow-md duration-100 animate-in fade-in-0"
      role="search"
    >
      <style>{`::highlight(${ALL}){background-color:rgb(250 204 21 / 0.35);color:inherit}::highlight(${CURRENT}){background-color:rgb(249 115 22 / 0.6);color:inherit}`}</style>
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        aria-label="Find in chat"
        className="h-7 w-52 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in chat"
        ref={input}
        spellCheck={false}
        value={query}
      />
      <span aria-live="polite" className="min-w-14 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
        {findPattern(query) ? (matches.length ? `${shown + 1} of ${matches.length}` : "No results") : ""}
      </span>
      <Button aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)} size="icon-xs" title="Previous (⇧Enter)" variant="ghost">
        <ChevronUpIcon />
      </Button>
      <Button aria-label="Next match" disabled={!matches.length} onClick={() => step(1)} size="icon-xs" title="Next (Enter)" variant="ghost">
        <ChevronDownIcon />
      </Button>
      <Button aria-label="Close" onClick={close} size="icon-xs" title="Close (Esc)" variant="ghost">
        <XIcon />
      </Button>
    </div>
  );
}
