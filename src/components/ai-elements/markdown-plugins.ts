/**
 * The markdown plugins every reply, thought and Library page renders with, in one place so they read the same.
 */
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
// KaTeX's stylesheet loads with the app's other styles (main.tsx).

/** Single-dollar inline math, as models write it; prices and the \( \) and \[ \] forms are handled first (lib/math-text). */
export const streamdownPlugins = { cjk, code, math: createMathPlugin({ singleDollarTextMath: true }), mermaid };
