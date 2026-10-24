/**
 * Which variable a chat template reads to switch thinking. Templates name it differently (Qwen3 and GLM:
 * enable_thinking; DeepSeek-V3.1 and Granite: thinking; gpt-oss: reasoning_effort), so the template itself is
 * read rather than the model's name. Only Jinja code is searched, without its string literals, so a template
 * that writes "<think>" or reads message.thinking does not count.
 */
export type Knob = { name: "enable_thinking" | "thinking"; kind: "flag" } | { name: "reasoning_effort"; kind: "effort" };

const KNOBS: Knob[] = [
  { name: "enable_thinking", kind: "flag" },
  { name: "thinking", kind: "flag" },
  { name: "reasoning_effort", kind: "effort" },
];
export const KNOB_NAMES = KNOBS.map((knob) => knob.name);
export const knobNamed = (name: string) => KNOBS.find((knob) => knob.name === name);

/** The Jinja code of a template: what is inside {% %} and {{ }}, with string literals emptied. */
const code = (template: string) =>
  [...template.matchAll(/\{[{%]([\s\S]*?)[}%]\}/g)].map((match) => match[1].replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, '""')).join("\n");

/**
 * The variable the template switches thinking with, null when it reads none (thinking cannot be switched
 * through it), or undefined when there is no template to read.
 */
export function thinkingKnob(template: string | undefined): Knob | null | undefined {
  if (!template) return undefined;
  const jinja = code(template);
  // A variable, not an attribute (message.thinking) nor part of a longer name.
  return KNOBS.find((knob) => new RegExp(`(?<![\\w.])${knob.name}\\b`).test(jinja)) ?? null;
}
