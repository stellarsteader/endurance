/**
 * How a runtime is told to think, shared by the harness and Models settings. Native runtimes (Ollama) apply
 * reasoning_effort to the model themselves; template runtimes pass chat_template_kwargs to the model's chat
 * template, whose variable name differs by model. Pure data, so the renderer can use it.
 */
import type { RuntimeId } from "./models";
import type { Effort } from "./types";

export const TEMPLATE_RUNTIMES: readonly RuntimeId[] = ["llamacpp", "vllm", "sglang", "lmstudio", "mlx", "jan", "docker"];
export const switchesByTemplate = (runtime: RuntimeId) => TEMPLATE_RUNTIMES.includes(runtime);

/** The person's choice for a template runtime: found from the template, a named variable, or not switchable. */
export type ThinkingSwitchChoice = "auto" | "none" | "enable_thinking" | "thinking" | "reasoning_effort";

export const THINKING_SWITCH_CHOICES: { value: ThinkingSwitchChoice; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "enable_thinking", label: "enable_thinking" },
  { value: "thinking", label: "thinking" },
  { value: "reasoning_effort", label: "reasoning_effort" },
  { value: "none", label: "Can't be switched" },
];

export const isThinkingSwitchChoice = (value: unknown): value is ThinkingSwitchChoice =>
  THINKING_SWITCH_CHOICES.some((choice) => choice.value === value);

/**
 * Which thinking choices a model offers, as its runtime reports them: on and off only (most models: Qwen3,
 * Gemma 4), or named levels (gpt-oss style). `off` says whether thinking can be turned off at all.
 */
export type ThinkingControl = { kind: "toggle"; off: boolean } | { kind: "levels"; levels: Level[]; off: boolean };
export type Level = Exclude<Effort, "none">;

const LEVELS: Level[] = ["low", "medium", "high", "xhigh"];
const LABELS: Record<Effort, string> = { none: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" };

/** A runtime's word for a level, as ours: Ollama names the top level "max", OpenAI "minimal" the bottom one. */
const asLevel = (value: string): Level | undefined =>
  ({ minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh", ultra: "xhigh" } as Record<string, Level>)[value.toLowerCase()];

/**
 * The control from a list of allowed values: Ollama's `thinking.values` ([false, true] or level names) and
 * LM Studio's `reasoning.allowed_options` ("off", "on", or level names). Undefined when nothing is usable.
 */
export function controlFromValues(values: unknown): ThinkingControl | undefined {
  if (!Array.isArray(values) || !values.length) return undefined;
  const off = values.some((value) => value === false || value === "off" || value === "none");
  const levels = LEVELS.filter((level) => values.some((value) => typeof value === "string" && asLevel(value) === level));
  return levels.length > 1 ? { kind: "levels", levels, off } : { kind: "toggle", off };
}

/**
 * The model's control, or the one its runtime implies when the model reports none: Ollama and template
 * runtimes switch thinking on and off unless the model names levels; other OpenAI-compatible servers take
 * reasoning_effort levels as sent.
 */
export function thinkingControl(model: { runtime?: RuntimeId; thinking?: ThinkingControl }): ThinkingControl {
  if (model.thinking) return model.thinking;
  if (!model.runtime) return { kind: "levels", levels: LEVELS, off: false };
  if (model.runtime === "ollama" || switchesByTemplate(model.runtime)) return { kind: "toggle", off: true };
  return { kind: "levels", levels: LEVELS, off: false };
}

/** What the effort menu offers for the control. On is sent as "high", which runtimes read as on. */
export function effortChoices(control: ThinkingControl): { id: Effort; label: string }[] {
  const off = control.off ? [{ id: "none" as const, label: LABELS.none }] : [];
  if (control.kind === "toggle") return [{ id: "high", label: "On" }, ...off];
  return [...off, ...control.levels.map((level) => ({ id: level, label: LABELS[level] }))];
}

/**
 * The person's effort as this model can take it: Off where the model can turn off, else its nearest level
 * (or On for an on/off model). Settings are shared across models, so a choice made on one is fitted to another.
 */
export function resolveEffort(control: ThinkingControl, effort: Effort | undefined): Effort {
  if (effort === "none" && control.off) return "none";
  if (control.kind === "toggle") return "high";
  const wanted = effort && effort !== "none" ? LEVELS.indexOf(effort) : LEVELS.indexOf("high");
  return control.levels.reduce((best, level) => (Math.abs(LEVELS.indexOf(level) - wanted) < Math.abs(LEVELS.indexOf(best) - wanted) ? level : best));
}

/** The label the composer shows for the resolved effort. */
export const effortLabel = (control: ThinkingControl, effort: Effort) => effortChoices(control).find((choice) => choice.id === effort)?.label ?? LABELS[effort];
