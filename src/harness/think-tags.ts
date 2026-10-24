/**
 * Runtimes that do not separate thinking (llama.cpp with --reasoning-format none, MLX LM, some LM Studio and
 * OpenAI-compatible setups) send it inside the reply text, wrapped in the model's own tags. A thinking block
 * at the start of the reply is split out as it streams, so it is watched, shown and capped as thinking.
 * Tags can arrive split across deltas, so a possible partial tag is held back until the next delta.
 * A block the chat template opened itself, leaving only a closing tag in the reply, is not recognised.
 */
const TAGS: readonly [open: string, close: string][] = [
  ["<think>", "</think>"],
  ["<thinking>", "</thinking>"],
  ["<reasoning>", "</reasoning>"],
  ["[THINK]", "[/THINK]"],
  ["<seed:think>", "</seed:think>"],
  ["◁think▷", "◁/think▷"],
];
const LONGEST_OPEN = Math.max(...TAGS.map(([open]) => open.length));
/** Leading whitespace held back while waiting to see whether a tag follows. */
const MAX_LEADING = 256;

export type Piece = { part: "reasoning" | "text"; text: string };

/** How many characters at the end of `text` could be the start of `tag`. */
function partial(text: string, tag: string) {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) if (tag.startsWith(text.slice(-length))) return length;
  return 0;
}

export function thinkSplitter() {
  let state: "start" | "think" | "text" = "start";
  let pending = "";
  let close = "";
  /** The reply right after a thinking block starts without the blank lines that separated them. */
  let afterThought = false;

  const text = (value: string): Piece[] => {
    const trimmed = afterThought ? value.replace(/^\s+/, "") : value;
    if (trimmed) afterThought = false;
    return trimmed ? [{ part: "text", text: trimmed }] : [];
  };

  return {
    feed(delta: string): Piece[] {
      pending += delta;
      const out: Piece[] = [];
      while (pending) {
        if (state === "start") {
          const lead = pending.trimStart();
          const tag = TAGS.find(([open]) => lead.startsWith(open));
          if (tag) {
            state = "think";
            close = tag[1];
            pending = lead.slice(tag[0].length);
            continue;
          }
          // Only whitespace so far, or the start of a tag: wait for more, but not for long, so a model that
          // writes only blank lines still reaches the loop watch.
          if (pending.length < MAX_LEADING && lead.length < LONGEST_OPEN && TAGS.some(([open]) => open.startsWith(lead))) break;
          state = "text";
          continue;
        }
        if (state === "think") {
          const at = pending.indexOf(close);
          if (at >= 0) {
            if (at > 0) out.push({ part: "reasoning", text: pending.slice(0, at) });
            pending = pending.slice(at + close.length);
            state = "text";
            afterThought = true;
            continue;
          }
          const keep = partial(pending, close);
          if (pending.length > keep) out.push({ part: "reasoning", text: pending.slice(0, pending.length - keep) });
          pending = pending.slice(pending.length - keep);
          break;
        }
        out.push(...text(pending));
        pending = "";
      }
      return out;
    },
    /** What is still held back when the stream ends. */
    flush(): Piece[] {
      const rest = pending;
      pending = "";
      if (!rest) return [];
      return state === "think" ? [{ part: "reasoning", text: rest }] : text(rest);
    },
  };
}
