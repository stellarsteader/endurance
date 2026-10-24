/**
 * The text of documents attached to a chat (lib/attachments), taken out in the chat worker before the request
 * is built. A message names a document as `attachment:<name>`; its text replaces it as a text file part, so
 * the rest of the harness treats it as any text: sent whole when it fits, read as a document in pieces when it
 * does not (./documents).
 *
 * - PDF: text per page, under a "Page N" heading so pieces say where they are. A page with no text (a scan or a
 *   photo) is read by the reading model, one page at a time, from the page's own image; with none, the page is
 *   said to be unreadable rather than guessed.
 * - Word: headings, paragraphs, lists and tables as Markdown.
 * - Spreadsheets and CSV: a Markdown table per sheet under its name; formulas as their calculated values. The
 *   document splitter repeats a table's header at the top of every piece.
 * - Text and code: as they are.
 *
 * What is taken out is kept with the file, so a long document is read once, not on every turn. A document whose
 * scanned pages could not all be read is not kept, so it is read again once a model can. The files are encrypted
 * and only the main process holds the key: the worker reads and keeps them through AttachmentFiles, which asks it.
 */
import { request as makeRequest } from "./vendor/llm/llm";
import { Message } from "./vendor/llm/schema";
import { layer, modelFor, type ChatRequest } from "./chat";
import { guardedStream } from "./guarded";
import { outputPlan, withBody } from "./output";
import { tuned } from "./sampling";
import { thinkingRequest } from "./thinking";
import { measure } from "./profile/models";
import { attachmentId, documentFormat, MAX_PAGES, type DocumentFormat } from "../lib/attachments";
import type { AppUIMessage } from "../lib/types";

/** Changes when the way text is taken out changes, so what was kept is taken out again. */
const VERSION = "v1";
/** A page with fewer characters than this is taken to be an image of text. */
const LEAST_TEXT = 20;
/** Page images are scaled to at most this many pixels on their longer side before reading. */
const LONGEST_SIDE = 1600;
const READ_PROMPT =
  "Transcribe all the text on this page exactly, in reading order. Keep headings, lists and tables, as Markdown. Do not describe the page or add anything.";

export type Reader = Pick<ChatRequest, "runtime" | "runtimeModelId" | "connection" | "model" | "modelName" | "reasoningSupported" | "sampling" | "contextWindow">;

export interface ReadProgress {
  file: string;
  done: number;
  total: number;
}

/** Attached documents and the text kept from them, by their name in `attachment:<name>`. */
export interface AttachmentFiles {
  /** The document's bytes, or nothing when it is no longer kept. */
  read(id: string): Promise<Uint8Array | undefined>;
  readText(id: string, version: string): Promise<string | undefined>;
  writeText(id: string, version: string, text: string): Promise<void>;
}

/** The worker's question to the main process, and its answer (electron/attachments-ipc). */
export type AttachmentAsk = { type: "attachment"; request: number; id: string } & (
  | { op: "read"; version?: undefined; text?: undefined }
  | { op: "read-text"; version: string; text?: undefined }
  | { op: "write-text"; version: string; text: string }
);
export type AttachmentAnswer = { type: "attachment"; request: number } & ({ ok: true; bytes?: Uint8Array; text?: string } | { ok: false; error: string });

let kept: AttachmentFiles | undefined;
/** Where documents are kept in this process: the chat worker sets the main process's files at start. */
export function setAttachmentFiles(files: AttachmentFiles | undefined) {
  kept = files;
}

export interface ReadOptions {
  signal: AbortSignal;
  /** The model that reads pages that are images; none leaves them unread. */
  reader?: Reader;
  onProgress?: (progress: ReadProgress) => void;
  /** Where documents are kept; the ones set for this process by default. */
  files?: AttachmentFiles;
}

/** Whether any message names an attached document. */
export const hasAttachments = (messages: AppUIMessage[]) =>
  messages.some((message) => message.parts.some((part) => part.type === "file" && attachmentId(part.url) !== undefined));

// ---------------------------------------------------------------------------- tables

const cell = (value: string) => value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

/** Rows as a Markdown table, the first row as its header. */
export function markdownTable(rows: string[][]) {
  const kept = rows.filter((row) => row.some((value) => value.trim()));
  if (!kept.length) return "";
  const width = Math.max(...kept.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(row[i] ?? "")).join(" | ")} |`;
  return [line(kept[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...kept.slice(1).map(line)].join("\n");
}

/** CSV (or TSV) as rows, with quoted fields that hold separators, quotes and line breaks. */
export function parseCsv(text: string, separator = text.split("\n", 1)[0].includes("\t") ? "\t" : ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------- formats

async function spreadsheet(bytes: Buffer) {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as never);
  const value = (raw: unknown): string => {
    if (raw === null || raw === undefined) return "";
    if (raw instanceof Date) return raw.toISOString().replace(/T00:00:00\.000Z$/, "");
    if (typeof raw === "object") {
      const object = raw as { result?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: string; error?: string };
      // A formula's calculated value, rich text's characters, a link's text.
      if ("result" in object) return value(object.result);
      if (object.richText) return object.richText.map((part) => part.text).join("");
      if (typeof object.text === "string") return object.text;
      if (object.error) return object.error;
    }
    return String(raw);
  };
  const sheets: string[] = [];
  book.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map(value));
    });
    const table = markdownTable(rows);
    if (table) sheets.push(`## Sheet: ${sheet.name}\n\n${table}`);
  });
  return sheets.join("\n\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name]).replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
const strip = (html: string) => decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();

/** Word's HTML (from mammoth) as Markdown: headings, paragraphs, lists and tables. */
export function wordMarkdown(html: string) {
  const blocks: string[] = [];
  const pattern = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[1].toLowerCase();
    if (tag === "table") {
      const rows = [...match[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cellHtml) => strip(cellHtml[1])));
      const table = markdownTable(rows);
      if (table) blocks.push(table);
    } else {
      const text = strip(match[2]);
      if (!text) continue;
      blocks.push(tag.startsWith("h") ? `${"#".repeat(Number(tag[1]))} ${text}` : tag === "li" ? `- ${text}` : text);
    }
  }
  return blocks.join("\n\n");
}

async function word(bytes: Buffer) {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.convertToHtml({ buffer: bytes });
  return wordMarkdown(value);
}

/** An image's pixels as a JPEG, scaled down so its longer side is at most LONGEST_SIDE. */
async function jpeg(image: { data: Uint8ClampedArray; width: number; height: number; channels: 1 | 3 | 4 }) {
  const { encode } = await import("jpeg-js");
  const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / LONGEST_SIDE));
  const width = Math.floor(image.width / step);
  const height = Math.floor(image.height / step);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = ((y * step) * image.width + x * step) * image.channels;
      const to = (y * width + x) * 4;
      const gray = image.channels === 1;
      data[to] = image.data[from];
      data[to + 1] = image.data[gray ? from : from + 1];
      data[to + 2] = image.data[gray ? from : from + 2];
      data[to + 3] = 255;
    }
  return `data:image/jpeg;base64,${Buffer.from(encode({ data, width, height }, 85).data).toString("base64")}`;
}

/** The reading model's transcription of one page image. */
async function readPage(reader: Reader, image: string, signal: AbortSignal) {
  const body = reader as ChatRequest;
  const messages = [Message.user([{ type: "media", mediaType: "image/jpeg", data: image }, { type: "text", text: READ_PROMPT }])];
  const measured = await measure(body, "", messages, false);
  const output = outputPlan(body.runtime, measured.budget, measured.input, measured.cap, false);
  const sent = tuned(body, false, output);
  const result = await guardedStream({
    input: makeRequest(withBody({ model: modelFor(body), messages, ...(await thinkingRequest(body, false)), ...(sent.generation ? { generation: sent.generation } : {}) }, sent.body)),
    layer,
    connection: body.connection,
    signal,
    caps: output.caps,
    maxTokens: output.maxTokens,
  });
  return result.stopped ? "" : result.text.trim();
}

async function pdf(bytes: Buffer, name: string, options: ReadOptions): Promise<{ text: string; complete: boolean }> {
  const { getDocumentProxy, extractImages } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(bytes));
  if (document.numPages > MAX_PAGES) throw new Error(`${name} has ${document.numPages} pages; up to ${MAX_PAGES} can be read.`);
  const pages: string[] = [];
  for (let n = 1; n <= document.numPages; n++) {
    if (options.signal.aborted) throw options.signal.reason;
    const page = await document.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("").trim());
    if (n % 25 === 0) options.onProgress?.({ file: name, done: n, total: document.numPages });
  }
  const images = pages.flatMap((text, index) => (text.replace(/\s/g, "").length < LEAST_TEXT ? [index] : []));
  let complete = true;
  for (const [done, index] of images.entries()) {
    if (options.signal.aborted) throw options.signal.reason;
    options.onProgress?.({ file: name, done, total: images.length });
    const found = options.reader ? await extractImages(document, index + 1) : [];
    // A scanned page is one image covering it; the largest one is the page.
    const largest = found.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const read = largest && options.reader ? await readPage(options.reader, await jpeg(largest), options.signal) : "";
    if (read) pages[index] = read;
    else {
      complete = false;
      pages[index] = options.reader ? "[This page is an image, and its text could not be read.]" : "[This page is an image. Choose a model that reads images under Reading scanned documents in Models settings to read it.]";
    }
  }
  if (images.length) options.onProgress?.({ file: name, done: images.length, total: images.length });
  return { text: pages.map((text, index) => `## Page ${index + 1}\n\n${text}`).join("\n\n"), complete };
}

/** The text of one document, from what was kept when there is any. */
async function textOf(format: DocumentFormat, files: AttachmentFiles, id: string, name: string, options: ReadOptions) {
  const saved = await files.readText(id, VERSION);
  if (saved !== undefined) return saved;
  const stored = await files.read(id);
  if (!stored) throw new Error(`${name} is no longer in the app's data folder. Attach it again.`);
  const bytes = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  let text: string;
  let complete = true;
  if (format === "pdf") ({ text, complete } = await pdf(bytes, name, options));
  else if (format === "docx") text = await word(bytes);
  else if (format === "xlsx") text = await spreadsheet(bytes);
  else if (format === "csv") text = markdownTable(parseCsv(bytes.toString("utf8").replace(/^\uFEFF/, "")));
  else text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (complete) await files.writeText(id, VERSION, text).catch(() => undefined);
  return text;
}

/**
 * The messages with every attached document replaced by its text, as a text file part under the document's
 * name. A format that cannot be read is refused with its name.
 */
export async function readAttachments(messages: AppUIMessage[], options: ReadOptions): Promise<AppUIMessage[]> {
  if (!hasAttachments(messages)) return messages;
  const files = options.files ?? kept;
  if (!files) throw new Error("Attached documents cannot be read here.");
  const out: AppUIMessage[] = [];
  for (const message of messages) {
    const parts: AppUIMessage["parts"] = [];
    for (const part of message.parts) {
      const id = part.type === "file" ? attachmentId(part.url) : undefined;
      if (part.type !== "file" || !id) {
        parts.push(part);
        continue;
      }
      const name = part.filename ?? "The attached document";
      const format = documentFormat(part.mediaType, part.filename);
      if (!format) throw new Error(`${name} is a ${part.mediaType || "kind of"} file, which can't be read. Attach PDF, Word, Excel, CSV or text files.`);
      const text = await textOf(format, files, id, name, options);
      parts.push({ type: "file", mediaType: "text/markdown", filename: name, url: `data:text/markdown;base64,${Buffer.from(text).toString("base64")}` });
    }
    out.push({ ...message, parts });
  }
  return out;
}
