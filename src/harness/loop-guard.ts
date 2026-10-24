/**
 * Any model on any runtime can fall into a loop, writing the same sentences until the context runs out,
 * most often while thinking. A stream is watched as it arrives and stopped once its end keeps recurring,
 * or once it has written only whitespace for a long stretch. Stopping by length is the caller's cap.
 */

/** Thinking is never meant to repeat; a reply may hold repeated rows or code, so it needs more evidence. */
const LIMITS = {
  reasoning: { window: 120, times: 5, blank: 1000 },
  text: { window: 240, times: 8, blank: 2000 },
} as const;
/** How far back a repeat is looked for. */
const SPAN = 12_000;
/** Characters between checks, so a long stream is not searched on every token. */
const EVERY = 300;

export type Watched = keyof typeof LIMITS;

/** Whether the last `window` characters occur `times` times or more in the recent text. */
export function repeating(text: string, window: number, times: number) {
  if (text.length < window * times) return false;
  const tail = text.slice(-window);
  if (!/[\p{L}\p{N}]/u.test(tail)) return false;
  const recent = text.slice(-SPAN);
  let count = 0;
  for (let at = recent.indexOf(tail); at >= 0 && count < times; at = recent.indexOf(tail, at + 1)) count++;
  return count >= times;
}

/** Whether the last `length` characters hold no letter or digit, as when a model emits only newlines. */
export const blank = (text: string, length: number) => text.length >= length && !/[\p{L}\p{N}]/u.test(text.slice(-length));

/** Counting loops differ only in their numbers ("Attempt 41", "Attempt 42"); thinking is compared without them. */
const withoutNumbers = (text: string) => text.replace(/\p{N}+/gu, "0");

export class Stopped extends Error {
  constructor(
    readonly part: Watched,
    readonly reason: "loop" | "limit"
  ) {
    super(
      reason === "loop"
        ? part === "reasoning"
          ? "The model's thinking kept repeating itself."
          : "The reply kept repeating itself."
        : part === "reasoning"
          ? "The model's thinking ran past its length limit."
          : "The reply ran past its length limit."
    );
  }
}

/** Collects a stream's thinking and text; `add` reports which one has started looping. */
export function loopWatch() {
  const text: Record<Watched, string> = { reasoning: "", text: "" };
  const checked: Record<Watched, number> = { reasoning: 0, text: 0 };
  return {
    add(part: Watched, delta: string): Watched | undefined {
      text[part] += delta;
      if (text[part].length - checked[part] < EVERY) return undefined;
      checked[part] = text[part].length;
      const limit = LIMITS[part];
      const recent = part === "reasoning" ? withoutNumbers(text[part].slice(-SPAN)) : text[part];
      return repeating(recent, limit.window, limit.times) || blank(text[part], limit.blank) ? part : undefined;
    },
  };
}
