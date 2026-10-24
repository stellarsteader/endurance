/**
 * A chat's name written by its own model, when Settings → General asks for it. It runs once, after
 * the first reply, as the lowest-ranked call (./limit), with thinking off and a few tokens. Only the chat's own model
 * is used, so nothing goes anywhere the chat did not already go. Any failure leaves the name from the first message.
 */
import { request as makeRequest } from "./vendor/llm/llm";
import { Message } from "./vendor/llm/schema";
import { layer, modelFor, validate, type ChatRequest } from "./chat";
import { capsFor, guardedStream } from "./guarded";
import { runAs } from "./limit";
import { withBody } from "./output";
import { tuned } from "./sampling";
import { thinkingRequest } from "./thinking";
import { textOf } from "../lib/token-estimate";

/** Enough for a few words in any script, and not enough to wander. */
const TITLE_TOKENS = 48;
const LONGEST = 60;
/** Of each message, only the start says what the chat is about. */
const EXCERPT = 2000;

const PROMPT =
  "Name this conversation in at most six words, in the language the user wrote in. Reply with the name only: no quotes, no period, no explanation.";

/** The name from what the model wrote: its first line, without thinking, quotes, labels or a closing period. */
export function cleanTitle(raw: string): string | undefined {
  const text = raw.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, "");
  const line = text.split("\n").map((item) => item.trim()).find(Boolean);
  if (!line) return undefined;
  const name = line
    .replace(/^(title|name|제목)\s*[:：]\s*/i, "")
    .replace(/^[#*_`"'“”‘’「」『』\s]+|[*_`"'“”‘’「」『』\s]+$/g, "")
    .replace(/[.。!！]+$/, "")
    .trim();
  if (!name) return undefined;
  return name.length > LONGEST ? `${name.slice(0, LONGEST - 1).trimEnd()}…` : name;
}

/** Names the chat from its first exchange, or returns undefined when the model gave nothing usable. */
export async function titleChat(raw: ChatRequest, signal: AbortSignal): Promise<string | undefined> {
  validate(raw);
  const asked = raw.messages.find((message) => message.role === "user");
  const answered = raw.messages.find((message) => message.role === "assistant");
  if (!asked) return undefined;
  const exchange = [`User: ${textOf(asked).slice(0, EXCERPT)}`, answered ? `Assistant: ${textOf(answered).slice(0, EXCERPT)}` : ""].filter(Boolean).join("\n\n");
  const thinking = await thinkingRequest(raw, false);
  const sent = tuned(raw, false, { maxTokens: TITLE_TOKENS });
  return runAs({ chat: raw.id, kind: "title" }, async () => {
    const response = await guardedStream({
      input: makeRequest(
        withBody(
          {
            model: modelFor(raw),
            system: PROMPT,
            messages: [Message.user(exchange)],
            ...thinking,
            ...(sent.generation ? { generation: sent.generation } : {}),
          },
          sent.body
        )
      ),
      layer,
      connection: raw.connection,
      signal,
      caps: capsFor(TITLE_TOKENS),
    });
    return response.stopped ? undefined : cleanTitle(response.text);
  });
}
