/**
 * A reply's text made ready for math rendering with single-dollar inline math on. Models write math as $…$, $$…$$,
 * \(…\) and \[…\], and prices as $5; the parser knows only the dollar forms and cannot tell a price from a formula.
 * So, as the llama.cpp web UI and LobeHub UI do before their math parser:
 * - code (fenced blocks and inline code) is left exactly as written;
 * - a dollar sign before an amount ($5, $3.99, $1,200, $10K) is escaped, so "$5 and $10" stays text;
 * - \[…\] becomes $$…$$ and \(…\) becomes $…$, outside math that is already delimited.
 * A formula that starts with a lone number ($2 x$) reads as a price; one that goes on with math ($2^n$) does not.
 */

/** Fenced code blocks (to their closing fence, or the end while one streams) and inline code spans. */
const CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))|(`+)(?!`)[^\n]*?(?<!`)\2(?!`)/gm;

/** A dollar sign before an amount that ends there: at a space, punctuation or the end, not at math such as ^ or _. */
const PRICE = /(?<![\\$])\$(?=\d[\d,]*(?:\.\d+)?(?:[kKmMbB]|bn)?(?:[\s,.;:!?)\]'"/-]|$))/g;

/** Math already delimited (kept as it is), then the bracket forms to convert. */
const DELIMITED = /\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\\\n])+\$|(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g;

function prose(text: string) {
  return text.replace(PRICE, "\\$").replace(DELIMITED, (match, display: string | undefined, inline: string | undefined) => {
    if (display !== undefined) return "$$" + display + "$$";
    if (inline !== undefined) return "$" + inline.trim() + "$";
    return match;
  });
}

export function mathText(text: string) {
  let result = "";
  let from = 0;
  for (const match of text.matchAll(CODE)) {
    const at = match.index ?? 0;
    result += prose(text.slice(from, at)) + match[0];
    from = at + match[0].length;
  }
  return result + prose(text.slice(from));
}
