/**
 * The instructions a person wrote for a project. The main process reads them from the history and
 * adds them to the request; they go right after the model's identity, before everything that changes between
 * requests, so a runtime can reuse its cache. The text is the person's own; nothing here writes or extracts any.
 */
import { estimateText } from "../lib/token-estimate";
import { MAX_INSTRUCTIONS } from "../lib/workspace-api";

/** The share of the window instructions may fill; the conversation and the answer need the rest. */
export const INSTRUCTIONS_SHARE = 1 / 4;

export interface FittedInstructions {
  /** The system prompt section, empty when there are none. */
  text: string;
  /** Characters sent and written, when the text had to be cut to fit. */
  cut?: { kept: number; total: number };
}

const HEADER = "Project instructions from the user. Follow them in this project:";
const CUT_NOTE = "… The rest of the project instructions did not fit in this model's context window.";

/** The longest start of `text` within `tokens`, ending at a paragraph, else a line, else a word. */
function headWithin(text: string, tokens: number) {
  if (estimateText(text) <= tokens) return text;
  // The estimate grows with the text, so the longest fitting length is found by halving.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateText(text.slice(0, mid)) <= tokens) low = mid;
    else high = mid - 1;
  }
  const head = text.slice(0, low);
  for (const boundary of ["\n\n", "\n", " "]) {
    const at = head.lastIndexOf(boundary);
    // A boundary in the first half would drop too much; cutting mid-word is better than that.
    if (at > low / 2) return head.slice(0, at);
  }
  return head;
}

/**
 * The section for the system prompt. With a known window the instructions take at most INSTRUCTIONS_SHARE of it and
 * say where they were cut; with none known they go whole, as the request is not cut by length then either.
 */
export function fitInstructions(raw: unknown, window: number | undefined): FittedInstructions {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_INSTRUCTIONS) : "";
  if (!text) return { text: "" };
  if (!window) return { text: `${HEADER}\n${text}` };
  const room = Math.floor(window * INSTRUCTIONS_SHARE) - estimateText(`${HEADER}\n\n${CUT_NOTE}`);
  const head = headWithin(text, Math.max(0, room));
  if (head.length >= text.length) return { text: `${HEADER}\n${text}` };
  return { text: head ? `${HEADER}\n${head}\n${CUT_NOTE}` : "", cut: { kept: head.length, total: text.length } };
}
