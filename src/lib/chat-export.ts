/**
 * A whole chat written out as a file the person keeps. Built here, saved by the main process
 * (electron/export-ipc), which only checks and writes. The file is a plaintext copy outside the vault.
 * - Markdown: what the person and the model wrote, in order. Thoughts, tool calls and the app's own notes are left
 *   out; attached files appear by name only.
 * - JSON: the messages as stored, without file contents and without `attachment:` names, which mean nothing
 *   outside the vault.
 * Pure, so it is tested without the app.
 */
import { ATTACHMENT_URL } from "./attachments";
import type { AppUIMessage } from "./types";

export type ChatExportFormat = "markdown" | "json";
export const EXPORT_FORMATS: readonly ChatExportFormat[] = ["markdown", "json"];
export const EXPORT_EXTENSION: Record<ChatExportFormat, string> = { markdown: "md", json: "json" };
/** The largest export the main process writes. */
export const MAX_EXPORT = 50 * 1024 * 1024;

/** Characters no file system takes in a name, and control characters. */
const FORBIDDEN = /[\\/:*?"<>|\p{Cc}]/gu;
const DATA_URL = /^data:[\w.+-]+\/[\w.+-]+[;,]/i;
/** Data URLs written into a reply's text, such as an inline image. */
const DATA_IN_TEXT = /data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/=]+/g;

/** A file name from the chat's title: any language kept, characters file systems refuse removed, at most 80 characters. */
export function exportFilename(title: string, format: ChatExportFormat) {
  const clean = title.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^[.\s]+|[.\s]+$/g, "");
  // Cut by character, never inside one (emoji and other characters outside the BMP take two code units).
  const name = Array.from(clean).slice(0, 80).join("").trim() || "Chat";
  return `${name}.${EXPORT_EXTENSION[format]}`;
}

type Part = AppUIMessage["parts"][number];
type FilePart = Extract<Part, { type: "file" }>;

const fileName = (part: FilePart) => part.filename || part.mediaType || "File";

function fileLine(part: FilePart) {
  return part.mediaType.startsWith("image/") ? `[Image: ${fileName(part)}]` : `[File: ${fileName(part)}]`;
}

/** The chat as Markdown: a heading with its title, then each message's text and attached file names, in order. */
export function chatMarkdown(title: string, messages: readonly AppUIMessage[], options: { modelName?: (id: string) => string } = {}) {
  const sections = messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const body = message.parts.flatMap((part) => {
      if (part.type === "text") return part.text.trim() ? [part.text.replace(DATA_IN_TEXT, "[data omitted]").trim()] : [];
      if (part.type === "file") return [fileLine(part)];
      return [];
    });
    if (!body.length) return [];
    const model = message.role === "assistant" && message.metadata?.model ? (options.modelName?.(message.metadata.model) ?? message.metadata.model) : undefined;
    const heading = message.role === "user" ? "## You" : "## Assistant";
    return [[heading, ...(model ? [`_${model}_`] : []), ...body].join("\n\n")];
  });
  return [`# ${title.replace(/\s+/g, " ").trim() || "Chat"}`, ...sections].join("\n\n") + "\n";
}

/** The chat as JSON: its messages as stored, file contents and vault names replaced by what names them. */
export function chatJSON(title: string, messages: readonly AppUIMessage[], exportedAt = new Date()) {
  const exported = messages.map((message) => ({ ...message, parts: message.parts.map(exportPart) }));
  return JSON.stringify({ title, exportedAt: exportedAt.toISOString(), messages: exported }, null, 2) + "\n";
}

function exportPart(part: Part): unknown {
  if (part.type === "file") {
    // A file's contents stay out; a web address is kept, since it names the file rather than holding it.
    const { url, ...rest } = part;
    return /^https?:\/\//i.test(url) ? part : { ...(strip(rest) as object), filename: fileName(part), mediaType: part.mediaType };
  }
  return strip(part);
}

/** Every other value as stored, except data URLs and `attachment:` names anywhere in it (such as a file's copy before an edit). */
function strip(value: unknown): unknown {
  if (typeof value === "string") return DATA_URL.test(value) ? "[data omitted]" : value.replace(DATA_IN_TEXT, "[data omitted]");
  if (Array.isArray(value)) return value.filter((item) => !(typeof item === "string" && ATTACHMENT_URL.test(item))).map(strip);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (!(typeof item === "string" && ATTACHMENT_URL.test(item))) out[key] = strip(item);
  return out;
}
