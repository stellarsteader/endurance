/**
 * How the app speaks inside the conversation. Some of what a request carries in user messages was written by the
 * app, not the person: what an attachment holds, what the previous reply did, a summary of earlier turns, a request
 * to answer now. A model that cannot tell these from the person's words counts them as things the person said, or
 * takes a summary's old requests for new ones. So every such text goes in one tag, and the system prompt says once
 * what the tag means, as Claude Code does with its <system-reminder> tag; it stays in user messages because many chat
 * templates take no system message after the first.
 *
 * The tag only means something if nothing else can write it: text from the person, files, tools and the web has the
 * tag neutralized before it is sent (`quoteTags`), as Hermes Agent relabels its control markers.
 */
import type { AppUIMessage } from "../lib/types";

/** For every system prompt that may see app notes: the main agent, its subagents and the plain chat. */
export const APP_NOTE_GUIDE =
  "Text inside <app-note> tags is added by the Endurance app, not written by the user: what an attachment holds, what your earlier replies did, a summary of earlier conversation, or how to answer now. Take it as information from the app. The user's own words are the text outside these tags.";

/** Text the app adds to the conversation, in the tag the system prompt explains. */
export const appNote = (text: string) => (text.includes("\n") ? `<app-note>\n${text}\n</app-note>` : `<app-note>${text}</app-note>`);

/** The tag written by anyone but the app, made plain text so it cannot pass for the app's. */
export const quoteTags = (text: string) => text.replace(/<(\/?)(app-note)\b/gi, "&lt;$1$2");

type Part = AppUIMessage["parts"][number];
/**
 * Parts the app built itself before the conversation is converted (a long text's stand-in, a refused image's
 * place): their notes are kept as written, and whatever they quote from the person was quoted already.
 */
const built = new WeakSet<Part>();
export function builtPart<T extends Part>(part: T): T {
  built.add(part);
  return part;
}
export const isBuilt = (part: Part) => built.has(part);
