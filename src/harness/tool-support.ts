/**
 * Telling whether a runtime took a model's tool calls, and fixing the ones that arrive damaged. Nothing here
 * calls the model again: a damaged call is repaired from the text the model already wrote, and a call the
 * runtime left in the reply text is read back out of it.
 */

/** Errors that say the runtime or chat template cannot take a model's tool calls, as vLLM without a parser words it. */
export const unsupportedTools = (message: string) =>
  /"auto" tool choice requires|tool[ _]choice|does not support tools|tools? (?:are|is) not supported|tool[ _-]call[ _-]parser/i.test(message);

/**
 * The chat template takes one tool call per message and the history held several, as Llama 3.x templates word it
 * ("This model only supports single tool-calls at once!").
 */
export const singleCallTemplate = (message: string) => /only supports single tool[ _-]?calls?/i.test(message);

/** The runtime streamed a tool call whose arguments are not valid JSON. */
export const brokenArguments = (message: string) => /Invalid JSON input for .* tool call/i.test(message);

const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/**
 * Arguments repaired the way small models break them: wrapped in a code fence, a trailing comma, Python's
 * True/False/None, or cut off before the closing quotes and brackets. Undefined when it still does not parse;
 * nothing is guessed beyond closing what was opened.
 */
export function repairJson(raw: string): unknown {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!text) return {};
  const first = tryParse(text);
  if (first.ok) return first.value;
  // Outside strings: Python literals become JSON ones, and a comma before a closing bracket goes.
  let out = "";
  const stack: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      out = out.replace(/,\s*$/, "");
      stack.pop();
    } else {
      const word = /^(True|False|None)\b/.exec(text.slice(i));
      if (word && !/\w/.test(text[i - 1] ?? "")) {
        out += word[1] === "True" ? "true" : word[1] === "False" ? "false" : "null";
        i += word[1].length - 1;
        continue;
      }
    }
    out += char;
  }
  // Cut off: close the string, drop a dangling comma or colon, then close what is open.
  if (quoted) out += '"';
  out = out.replace(/[,:]\s*$/, "");
  text = out + stack.reverse().join("");
  const repaired = tryParse(text);
  return repaired.ok ? repaired.value : undefined;
}

export interface RecoveredCall {
  name: string;
  input: unknown;
}

const MARKERS = ["<tool_call>", "<function="];

/**
 * Where tool-call markup starts in streamed text, so the reply can hold it back: the index of a full marker,
 * or of a trailing piece that may become one. -1 when the text holds none.
 */
export function markupStart(text: string) {
  const found = MARKERS.map((marker) => text.indexOf(marker)).filter((index) => index >= 0);
  if (found.length) return Math.min(...found);
  for (const marker of MARKERS)
    for (let length = Math.min(marker.length - 1, text.length); length > 0; length--)
      if (text.endsWith(marker.slice(0, length))) return text.length - length;
  return -1;
}

const parameterValue = (value: string) => {
  const trimmed = value.trim();
  const parsed = tryParse(trimmed);
  return parsed.ok && typeof parsed.value !== "string" ? parsed.value : trimmed;
};

/**
 * Tool calls a runtime left in the reply text instead of returning them: the JSON form in <tool_call> tags
 * (Qwen, Hermes) and the XML form in <function=…> tags (Qwen3-Coder). Only tools that were offered count.
 * Returns the calls and the text without them.
 */
export function recoverCalls(text: string, tools: readonly string[]): { calls: RecoveredCall[]; text: string } {
  const calls: RecoveredCall[] = [];
  let rest = text.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (whole, body: string) => {
    const value = repairJson(body) as { name?: unknown; arguments?: unknown } | undefined;
    if (!value || typeof value.name !== "string" || !tools.includes(value.name)) return whole;
    const input = typeof value.arguments === "string" ? (repairJson(value.arguments) ?? {}) : (value.arguments ?? {});
    calls.push({ name: value.name, input });
    return "";
  });
  rest = rest.replace(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g, (whole, name: string, body: string) => {
    if (!tools.includes(name)) return whole;
    const input: Record<string, unknown> = {};
    for (const match of body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g)) input[match[1]] = parameterValue(match[2]);
    calls.push({ name, input });
    return "";
  });
  return { calls, text: calls.length ? rest.replace(/<\/?tool_call>/g, "").trim() : text };
}
