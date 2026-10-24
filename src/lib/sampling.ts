/**
 * Sampling the person may set for a model in Models settings. Nothing is set by default: a field left empty is
 * the model's own value (Ollama's Modelfile, vLLM's generation_config) or, when the model has none, the
 * runtime's default. A model that thinks keeps one set for thinking on and one for off, since model makers
 * often recommend different values for each. Values set here go with every request for that model, on any
 * runtime, without restarting anything. Shared by the renderer and the harness.
 */

export const SAMPLING_FIELDS = ["temperature", "topP", "topK", "minP", "repetitionPenalty", "presencePenalty"] as const;
export type SamplingField = (typeof SAMPLING_FIELDS)[number];
export type Sampling = Partial<Record<SamplingField, number>>;

/** The sets kept for one model: `plain` is thinking off, or the only set of a model that does not think. */
export interface SamplingSets {
  thinking?: Sampling;
  plain?: Sampling;
}

export const SAMPLING_SPECS: Record<SamplingField, { label: string; min: number; max: number; integer?: boolean }> = {
  temperature: { label: "Temperature", min: 0, max: 2 },
  topP: { label: "Top P", min: 0, max: 1 },
  topK: { label: "Top K", min: 1, max: 1000, integer: true },
  minP: { label: "Min P", min: 0, max: 1 },
  repetitionPenalty: { label: "Repetition penalty", min: 0.5, max: 2 },
  presencePenalty: { label: "Presence penalty", min: -2, max: 2 },
};

/** The same values under Ollama's parameter names, as its Modelfile and request options spell them. */
export const OLLAMA_NAMES: Record<SamplingField, string> = {
  temperature: "temperature",
  topP: "top_p",
  topK: "top_k",
  minP: "min_p",
  repetitionPenalty: "repeat_penalty",
  presencePenalty: "presence_penalty",
};

/** What Ollama uses for a model whose Modelfile sets none (its documented defaults). */
export const OLLAMA_DEFAULTS: Required<Sampling> = { temperature: 0.8, topP: 0.9, topK: 40, minP: 0, repetitionPenalty: 1.1, presencePenalty: 0 };

/** A value within its field's range, or undefined. */
export function samplingValue(field: SamplingField, value: unknown): number | undefined {
  const spec = SAMPLING_SPECS[field];
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < spec.min || number > spec.max) return undefined;
  if (spec.integer && !Number.isInteger(number)) return undefined;
  return number;
}

/** Only the fields set to a valid value; undefined when none is. */
export function cleanSampling(value: unknown): Sampling | undefined {
  if (!value || typeof value !== "object") return undefined;
  const clean: Sampling = {};
  for (const field of SAMPLING_FIELDS) {
    const number = samplingValue(field, (value as Record<string, unknown>)[field]);
    if (number !== undefined) clean[field] = number;
  }
  return Object.keys(clean).length ? clean : undefined;
}

export function cleanSamplingSets(value: unknown): SamplingSets | undefined {
  if (!value || typeof value !== "object") return undefined;
  const thinking = cleanSampling((value as SamplingSets).thinking);
  const plain = cleanSampling((value as SamplingSets).plain);
  return thinking || plain ? { ...(thinking ? { thinking } : {}), ...(plain ? { plain } : {}) } : undefined;
}

/** The set a call uses: the thinking set while it thinks, the other otherwise. */
export const samplingFor = (sets: SamplingSets | undefined, thinking: boolean): Sampling => (thinking ? sets?.thinking : sets?.plain) ?? {};

/** The values a Modelfile sets, from Ollama's /api/show `parameters` text. */
export function ollamaSampling(parameters: string | undefined): Sampling {
  const values: Sampling = {};
  for (const field of SAMPLING_FIELDS) {
    const match = new RegExp(`(?:^|\\n)\\s*${OLLAMA_NAMES[field]}\\s+(\\S+)`).exec(parameters ?? "");
    const number = match ? samplingValue(field, Number(match[1])) : undefined;
    if (number !== undefined) values[field] = number;
  }
  return values;
}
