/**
 * What fills a request's prompt, part by part, for the context meter. Every number is the same
 * estimate the budget counts with (./budget), so the parts agree with how the harness fits a request. The meter
 * shows them as shares of the total the runtime reported, labeled estimated; the runtime does not count by part.
 */
import { messageTokens } from "./budget";
import type { Message } from "./vendor/llm/schema";
import { estimateText, IMAGE_TOKENS } from "../lib/token-estimate";
import type { ContextSection } from "../lib/types";

export type Breakdown = Partial<Record<ContextSection, number>>;

/** The system prompt's parts, as the request builds them. Text that is empty adds nothing. */
export interface SystemParts {
  system: string;
  instructions?: string;
  skills?: string;
  project?: string;
}

const imagesIn = (message: Message) => message.content.filter((part) => part.type === "media").length;

/**
 * The parts of a request: its system prompt, tool definitions (`tools`, in tokens) and its messages. Messages before
 * `from` are the conversation, with `summary` (when there is one) counted on its own and images as attachments;
 * from `from` on, they are this reply's tool calls and results. `reply` is the answer's text so far.
 */
export function breakdownOf(parts: SystemParts, tools: number, history: readonly Message[], from: number, summary?: Message, reply = ""): Breakdown {
  const result: Breakdown = {
    system: estimateText(parts.system),
    instructions: estimateText(parts.instructions ?? ""),
    skills: estimateText(parts.skills ?? ""),
    project: estimateText(parts.project ?? ""),
    tools,
    attachments: 0,
    conversation: 0,
    toolResults: 0,
    summary: 0,
    reply: estimateText(reply),
  };
  history.forEach((message, index) => {
    const tokens = messageTokens(message);
    if (message === summary) result.summary! += tokens;
    else if (index >= from) result.toolResults! += tokens;
    else {
      const images = imagesIn(message) * IMAGE_TOKENS;
      result.attachments! += images;
      result.conversation! += tokens - images;
    }
  });
  // Parts with nothing in them are left out, so the meter lists only what is there.
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value && value > 0)) as Breakdown;
}
