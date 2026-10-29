/**
 * Text too large to send whole, read as a document instead: a long paste or a large text attachment. A part
 * that takes more than half of what the request may hold is split into pieces; the model gets a list of the
 * pieces, the first ones and the last one as far as they fit, and tools to read any piece and search them all
 * (read_document, search_document). Nothing is cut away unseen, and nothing is summarized in advance.
 *
 * - Pieces end where the text does: at headings, blank lines and the edges of code blocks. Only a paragraph
 *   longer than a piece is cut, at sentence ends (lines, for code), with its last sentence repeated at the start
 *   of the next piece so nothing falls between them.
 * - A piece is an eighth of the window, at most 4K tokens, so a few fit beside the conversation and the answer.
 * - The last piece is always shown: a long paste often ends with what the person is asking.
 * - Search ranks pieces by BM25 over words; text without spaces between words (Korean, Japanese, Chinese) is
 *   also matched by pairs of characters, so a word still matches with its particle attached.
 * - The split depends only on the text and the window, so the same message reads the same on every turn.
 */
import { estimateText } from "../lib/token-estimate";
import { inputLimit, type Budget } from "./budget";
import type { AppUIMessage } from "../lib/types";
import { appNote, builtPart, quoteTags } from "./app-note";

/** Tokens per piece: an eighth of the window, at most this. */
const MOST_PIECE = 4096;
const LEAST_PIECE = 256;
/** A part over this share of what the request may hold becomes a document. */
const LARGE = 1 / 2;
/** What the shown pieces and the list of pieces may take of what the request may hold. */
const SHOWN = 1 / 4;
const LISTED = 1 / 8;
const CHARS = 3;

export interface Piece {
  /** 1-based. */
  n: number;
  text: string;
  /** Lines of the original text, 1-based. */
  from: number;
  to: number;
  /** The heading the piece falls under, if the text has headings. */
  heading?: string;
}

export interface Document {
  /** D1, D2, … in the order they appear in the conversation. */
  id: string;
  name: string;
  pieces: Piece[];
  lines: number;
  tokens: number;
}

interface Block {
  text: string;
  from: number;
  to: number;
  heading?: string;
  code: boolean;
}

/** A Markdown table: every line a row between pipes, the second line its rule. */
const isTable = (text: string) => {
  const lines = text.split("\n");
  return lines.length > 2 && lines.every((line) => line.trim().startsWith("|")) && /^\|\s*:?-{3,}/.test(lines[1].trim());
};

const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** The text as blocks: paragraphs, headings with what follows them, and whole code blocks. */
function blocks(text: string): Block[] {
  const lines = text.split("\n");
  const result: Block[] = [];
  let current: string[] = [];
  let start = 1;
  let heading: string | undefined;
  let fence: string | undefined;
  const flush = (end: number, code = false) => {
    if (current.some((line) => line.trim())) result.push({ text: current.join("\n"), from: start, to: end, heading, code });
    current = [];
  };
  lines.forEach((line, index) => {
    const number = index + 1;
    if (fence) {
      current.push(line);
      if (line.trim().startsWith(fence)) {
        fence = undefined;
        flush(number, true);
      }
      return;
    }
    const opens = FENCE.exec(line);
    if (opens || HEADING.test(line) || !line.trim()) flush(number - 1);
    if (!line.trim()) return;
    if (opens) fence = opens[1];
    if (HEADING.test(line)) heading = line.trim().replace(/^#+\s*/, "").slice(0, 80);
    if (!current.length) start = number;
    current.push(line);
  });
  flush(lines.length, Boolean(fence));
  return result;
}

/** A block too long for one piece, in parts at sentence ends (lines, for code), each repeating the last sentence before it. */
function cut(block: Block, size: number): Block[] {
  // A table is cut between rows, and every part starts with its header, so a part read alone still says what each column is.
  if (isTable(block.text)) {
    const [head, rule, ...rows] = block.text.split("\n");
    const header = `${head}\n${rule}`;
    const parts: Block[] = [];
    let current: string[] = [];
    for (const row of rows) {
      if (current.length && header.length + current.join("\n").length + row.length + 2 > size) {
        parts.push({ ...block, text: `${header}\n${current.join("\n")}` });
        current = [];
      }
      current.push(row);
    }
    if (current.length) parts.push({ ...block, text: `${header}\n${current.join("\n")}` });
    return parts;
  }
  const joiner = block.code ? "" : " ";
  const units = (block.code ? block.text.split(/(?<=\n)/) : block.text.split(/(?<=[.!?。！？])\s+/)).flatMap((unit) =>
    // A single sentence or line longer than a piece is cut where it must be.
    unit.length > size ? Array.from({ length: Math.ceil(unit.length / size) }, (_, at) => unit.slice(at * size, (at + 1) * size)) : [unit]
  );
  const parts: string[] = [];
  let current: string[] = [];
  const length = () => current.join(joiner).length;
  for (const unit of units) {
    if (current.length && length() + joiner.length + unit.length > size) {
      parts.push(current.join(joiner));
      // The next part starts with the last sentence, so a thought cut in the middle is still read whole.
      current = block.code ? [] : [current.at(-1)!];
      if (current.length && length() + joiner.length + unit.length > size) current = [];
    }
    current.push(unit);
  }
  if (current.length) parts.push(current.join(joiner));
  return parts.map((text) => ({ ...block, text }));
}

/** Tokens per piece for a window. */
export const pieceTokens = (window: number) => Math.max(LEAST_PIECE, Math.min(MOST_PIECE, Math.floor(window / 8)));

/** The text in pieces of about `tokens` tokens, ending where the text does. */
export function split(text: string, tokens: number): Piece[] {
  const size = tokens * CHARS;
  const pieces: Omit<Piece, "n">[] = [];
  let current: Block[] = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    pieces.push({ text: current.map((block) => block.text).join("\n\n"), from: current[0].from, to: current.at(-1)!.to, heading: current[0].heading });
    current = [];
    length = 0;
  };
  for (const block of blocks(text)) {
    for (const part of block.text.length > size ? cut(block, size) : [block]) {
      // A new section starts a new piece once the current one is half full.
      const section = HEADING.test(part.text) && length > size / 2;
      if (current.length && (section || length + part.text.length > size)) flush();
      current.push(part);
      length += part.text.length + 2;
    }
  }
  flush();
  return pieces.map((piece, index) => ({ ...piece, n: index + 1 }));
}

const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim().replace(/^#+\s*/, "").slice(0, 70);

/** One line per piece, or per run of pieces when that is too long for `chars`. */
export function outline(document: Document, chars: number) {
  const line = (from: Piece, to: Piece) =>
    `${from.n === to.n ? `#${from.n}` : `#${from.n}–${to.n}`} (lines ${from.from}–${to.to})${from.heading ? ` § ${from.heading}` : ""}: ${firstLine(from.text)}`;
  const pieces = document.pieces;
  const each = pieces.map((piece) => line(piece, piece));
  if (each.join("\n").length <= chars) return each.join("\n");
  // Runs of pieces under one heading, then runs of equal length, until the list fits.
  const runs: Piece[][] = [];
  for (const piece of pieces) {
    const last = runs.at(-1);
    if (last && last[0].heading && last[0].heading === piece.heading) last.push(piece);
    else runs.push([piece]);
  }
  let listed = runs.map((run) => line(run[0], run.at(-1)!));
  for (let span = 2; listed.join("\n").length > chars && span < pieces.length; span *= 2) {
    listed = [];
    for (let at = 0; at < pieces.length; at += span) listed.push(line(pieces[at], pieces[Math.min(pieces.length, at + span) - 1]));
  }
  return listed.join("\n");
}

/** How the document stands in for the text in the conversation: what it is, its pieces, and those that fit. */
function standIn(document: Document, budget: Budget) {
  const room = inputLimit(budget);
  const list = outline(document, Math.floor(room * LISTED * CHARS));
  const shown = new Set<number>();
  let used = 0;
  const fits = (piece: Piece) => used + estimateText(piece.text) <= room * SHOWN;
  const last = document.pieces.at(-1)!;
  // The last piece first, so the end of the text is always there; then from the start as far as they fit.
  if (fits(last)) {
    shown.add(last.n);
    used += estimateText(last.text);
  }
  for (const piece of document.pieces) {
    if (shown.has(piece.n)) continue;
    if (!fits(piece)) break;
    shown.add(piece.n);
    used += estimateText(piece.text);
  }
  const ordered = document.pieces.filter((piece) => shown.has(piece.n));
  const gaps = ordered.length < document.pieces.length;
  return [
    appNote(`${document.name} is too long to send whole (${document.lines} lines, about ${document.tokens} tokens), so it is document ${document.id} in ${document.pieces.length} pieces.${gaps ? " Read the pieces not shown here with read_document, and find where something is with search_document." : ""}\nPieces of ${document.id}:\n${list}`),
    // The pieces are the person's text, quoted here because the stand-in is kept as the app wrote it (app-note).
    ...ordered.map((piece) => `--- ${document.id} piece #${piece.n} (lines ${piece.from}–${piece.to}) ---\n${quoteTags(piece.text)}`),
  ].join("\n\n");
}

/** Whether a part of this size is read as a document in this budget. */
export const isLarge = (tokens: number, budget: Budget) => Boolean(budget.window) && tokens > inputLimit(budget) * LARGE;

/** Whether any message has a part read as a document in this budget, so the request needs the document tools. */
export const hasLarge = (messages: AppUIMessage[], budget: Budget) =>
  messages.some((message) => message.role === "user" && message.parts.some((part) => {
    const text = part.type === "text" ? part.text : attachedText(part);
    return text !== undefined && isLarge(estimateText(text), budget);
  }));

/** The text of a text attachment, or undefined for other parts. */
function attachedText(part: AppUIMessage["parts"][number]) {
  if (part.type !== "file" || !part.mediaType.startsWith("text/")) return undefined;
  const match = /^data:[^,]*;base64,(.*)$/.exec(part.url);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : undefined;
}

/**
 * The conversation with every part too large for the request read as a document, and those documents. Nothing
 * changes when the window is not known: what does not fit is then refused by the runtime.
 */
export function documentize(messages: AppUIMessage[], budget: Budget): { messages: AppUIMessage[]; documents: Document[] } {
  const documents: Document[] = [];
  if (!budget.window) return { messages, documents };
  const size = pieceTokens(budget.window);
  const converted = messages.map((message) => {
    if (message.role !== "user") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      const text = part.type === "text" ? part.text : attachedText(part);
      if (text === undefined) return part;
      const tokens = estimateText(text);
      if (!isLarge(tokens, budget)) return part;
      changed = true;
      const name = part.type === "file" ? (part.filename ?? "An attached file") : "The pasted text";
      const document: Document = { id: `D${documents.length + 1}`, name, pieces: split(text, size), lines: text.split("\n").length, tokens };
      documents.push(document);
      return builtPart({ type: "text" as const, text: standIn(document, budget) });
    });
    return changed ? { ...message, parts } : message;
  });
  return { messages: converted, documents };
}

/** Pieces from `from` on, as many as fit in `chars`, and where to go on. */
export function readPieces(document: Document, from: number, chars: number) {
  const start = Math.min(Math.max(1, from), document.pieces.length);
  const parts: string[] = [];
  let used = 0;
  let next: number | undefined;
  for (const piece of document.pieces.slice(start - 1)) {
    const text = `--- ${document.id} piece #${piece.n} (lines ${piece.from}–${piece.to}) ---\n${piece.text}`;
    if (parts.length && used + text.length > chars) {
      next = piece.n;
      break;
    }
    parts.push(text.length > chars ? `${text.slice(0, chars)}…` : text);
    used += text.length;
  }
  return parts.join("\n\n") + (next ? `\n\n… pieces #${next}–${document.pieces.length} remain. Read again from piece ${next} to continue.` : "");
}

const UNSPACED = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Words, and for text written without spaces between words, also its pairs of characters. */
export function terms(text: string) {
  const result: string[] = [];
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    result.push(word);
    if (word.length > 2 && UNSPACED.test(word)) for (let at = 0; at < word.length - 1; at++) result.push(word.slice(at, at + 2));
  }
  return result;
}

/** The pieces that best match the query, best first, by BM25. */
export function searchPieces(documents: Document[], query: string, most = 5) {
  const wanted = [...new Set(terms(query))];
  const all = documents.flatMap((document) => document.pieces.map((piece) => ({ document, piece, words: terms(piece.text) })));
  if (!wanted.length || !all.length) return [];
  const average = all.reduce((total, item) => total + item.words.length, 0) / all.length;
  const containing = new Map(wanted.map((term) => [term, all.filter((item) => item.words.includes(term)).length]));
  const scored = all.map((item) => {
    const counts = new Map<string, number>();
    for (const word of item.words) if (containing.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    let score = 0;
    for (const term of wanted) {
      const count = counts.get(term) ?? 0;
      if (!count) continue;
      const idf = Math.log(1 + (all.length - containing.get(term)! + 0.5) / (containing.get(term)! + 0.5));
      score += (idf * count * 2.2) / (count + 1.2 * (0.25 + 0.75 * (item.words.length / average)));
    }
    return { ...item, score };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, most)
    .map(({ document, piece }) => {
      // The line with the most of the query's terms shows where in the piece the match is.
      const hits = (text: string) => new Set(terms(text).filter((term) => containing.has(term))).size;
      const line = piece.text.split("\n").reduce((best, text) => (hits(text) > hits(best) ? text : best), firstLine(piece.text));
      return { document, piece, line: line.trim().slice(0, 160) };
    });
}
