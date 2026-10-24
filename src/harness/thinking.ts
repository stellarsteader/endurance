/**
 * The request fields that switch thinking on or off, in the form the runtime and model understand:
 * - native runtimes take the effort and apply it to the model themselves: Ollama as `think` on its /api/chat
 *   (see ./ollama-chat), OpenAI-compatible servers as reasoning_effort;
 * - template runtimes (llama.cpp, vLLM, SGLang, LM Studio, MLX and others) pass chat_template_kwargs to the
 *   model's chat template, so the variable is the one that template reads, found by reading the template,
 *   or set by the person in Models settings. When the template is not available, the two common flags are
 *   sent; a template ignores variables it does not read. A template that reads none gets nothing.
 * None of this is guaranteed to stop a model thinking, so every call stays bounded by loops and caps.
 */
import { reasoningOptions, thinkingOff, type ChatRequest } from "./chat";
import { modelProfile } from "./profile/models";
import type { Knob } from "./profile/template";

export interface ThinkingRequest {
  providerOptions?: ReturnType<typeof reasoningOptions>;
  http?: { body: Record<string, unknown> };
}

/** gpt-oss style templates take an effort; they have no off, so off is their lowest. */
const effortFor = (body: ChatRequest, on: boolean) => (!on ? "low" : body.effort === "xhigh" ? "high" : (body.effort ?? "medium"));

const variables = (knob: Knob | undefined, body: ChatRequest, on: boolean): Record<string, unknown> => {
  if (!knob) return { enable_thinking: on, thinking: on };
  return knob.kind === "flag" ? { [knob.name]: on } : { [knob.name]: effortFor(body, on) };
};

/**
 * Thinking on (as the person set it) or off. Nothing is sent for a model that does not report thinking,
 * unless `force` asks for it off: after its thinking looped, the model evidently thinks.
 */
export async function thinkingRequest(body: ChatRequest, think: boolean, force = false): Promise<ThinkingRequest> {
  if (!body.reasoningSupported && !(force && !think)) return {};
  const profile = await modelProfile(body);
  if (profile.runtime.thinking === "native") return body.reasoningSupported ? { providerOptions: reasoningOptions(body, think) } : {};
  if (profile.knob === null) return {};
  return { http: { body: { chat_template_kwargs: variables(profile.knob, body, think && !thinkingOff(body)) } } };
}
