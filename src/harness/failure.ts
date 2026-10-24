/**
 * Classifies a failed model call for the chat (lib/failure) and says whether trying again soon can help.
 * The vendored client reports HTTP failures as LLMError with a reason; runtimes word the rest themselves, so
 * those are recognized by their wording, which is matched broadly and only to choose what the chat offers.
 */
import { LLMError } from "./vendor/llm/schema";
import { isContextOverflow } from "./vendor/llm/provider-error";
import { tagFailure, type FailureKind } from "../lib/failure";
import { unsupportedTools } from "./tool-support";

const MEMORY = /requires more system memory|out of memory|insufficient memory|not enough memory|unable to allocate|failed to allocate|\bOOM\b|model is too large/i;
const MISSING = /model ['"]?[^'"\s]*['"]? not found|not found, try pulling|does not exist|no such model|model not found|The model `[^`]+` does not exist/i;
/** vLLM: "does not support Chat Completions API"; Ollama: "\"name\" does not support chat"; others: no chat template. */
const NOT_CHAT = /does not support (?:the )?chat|not support chat completions|chat template is not (?:set|available)|does not have a chat template|only supports? (?:the )?(?:embedding|pooling|transcription)/i;
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|connect(?:ion)? refused|socket hang up|ECONNRESET|network error/i;

const messageOf = (error: unknown) => (error instanceof LLMError ? error.reason.message : error instanceof Error ? error.message : String(error));

export function failureKind(error: unknown): FailureKind {
  const message = messageOf(error);
  if (error instanceof Error && error.name === "Silent") return "silent";
  if (MEMORY.test(message)) return "memory";
  if (unsupportedTools(message)) return "tools";
  if (isContextOverflow(message) || /context window is \d+ tokens/.test(message)) return "overflow";
  if (NOT_CHAT.test(message)) return "notChat";
  if (MISSING.test(message)) return "missing";
  if (error instanceof LLMError) {
    const tag = error.reason._tag;
    if (tag === "Authentication") return "auth";
    if (tag === "RateLimit") return "busy";
    if (tag === "Transport") return "unreachable";
    if (tag === "ProviderInternal" && error.reason.status === 503) return "busy";
    if ("status" in error.reason && error.reason.status === 404) return "missing";
  }
  if (UNREACHABLE.test(message)) return "unreachable";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) return "auth";
  return "other";
}

/**
 * Whether the same call may succeed in a moment because the connection dropped. A busy server (429, 5xx) is
 * already tried again by the vendored client (route/executor), so it is not counted here.
 */
export const transient = (error: unknown) => /ECONNRESET|socket hang up|EPIPE/i.test(messageOf(error));

/** The message the chat shows, tagged with its kind. */
export const describeFailure = (error: unknown) => tagFailure(failureKind(error), messageOf(error));
