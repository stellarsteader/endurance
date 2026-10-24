/**
 * The sampling a call sends: only what the person set for the model in Models settings (lib/sampling), in the
 * set for whether the call thinks. Nothing else is ever sent, so everything not set stays the model's own value
 * or the runtime's default. Ollama takes them as request options; OpenAI-compatible servers take temperature,
 * top_p, top_k and presence_penalty as request fields, and vLLM's min_p and repetition_penalty beside them.
 */
import { OLLAMA_NAMES, cleanSamplingSets, samplingFor, type SamplingField } from "../lib/sampling";
import type { ChatRequest } from "./chat";
import type { OutputPlan } from "./output";

export interface Tuned {
  generation?: { maxTokens?: number; temperature?: number; topP?: number; topK?: number; presencePenalty?: number };
  body?: Record<string, unknown>;
}

/** The call's generation fields and request body: the output plan's, with the person's sampling. */
export function tuned(body: Pick<ChatRequest, "runtime" | "sampling">, thinking: boolean, output?: Pick<OutputPlan, "maxTokens" | "body">): Tuned {
  const set = samplingFor(cleanSamplingSets(body.sampling), thinking);
  const maxTokens = output?.maxTokens;
  let generation: Tuned["generation"] = maxTokens ? { maxTokens } : undefined;
  let extra: Record<string, unknown> | undefined;
  if (body.runtime === "ollama") {
    const options = Object.fromEntries(Object.entries(set).map(([field, value]) => [OLLAMA_NAMES[field as SamplingField], value]));
    if (Object.keys(options).length) extra = { options };
  } else {
    const { temperature, topP, topK, presencePenalty, minP, repetitionPenalty } = set;
    const fields = Object.fromEntries(Object.entries({ temperature, topP, topK, presencePenalty }).filter(([, value]) => value !== undefined));
    if (Object.keys(fields).length) generation = { ...generation, ...fields };
    const rest = Object.fromEntries(Object.entries({ min_p: minP, repetition_penalty: repetitionPenalty }).filter(([, value]) => value !== undefined));
    if (Object.keys(rest).length) extra = rest;
  }
  const merged = output?.body || extra ? { ...output?.body, ...extra } : undefined;
  return { ...(generation ? { generation } : {}), ...(merged ? { body: merged } : {}) };
}
