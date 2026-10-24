/**
 * Which attached files are documents the chat reads as text, and how a message refers to one. A document is
 * kept encrypted in the app's data folder (electron/attachments-ipc) and named in the message as `attachment:<name>`;
 * the chat worker takes its text out (src/harness/attachments). Images keep going to the model as images.
 * Shared by the renderer and the harness.
 */

export const ATTACHMENT_URL = /^attachment:([a-f0-9]{64})$/;
export const attachmentUrl = (id: string) => `attachment:${id}`;
export const attachmentId = (url: string) => ATTACHMENT_URL.exec(url)?.[1];

/** The largest document a chat takes, and the most pages of a PDF. */
export const MAX_DOCUMENT = 200 * 1024 * 1024;
export const MAX_PAGES = 2000;
/** The largest image file taken; it is made ready for the model before it is sent (src/lib/prepare-image). */
export const MAX_IMAGE = 50 * 1024 * 1024;
/** An image goes within this side and this much base64, sizes vision models commonly take. */
export const IMAGE_SIDE = 2000;
export const IMAGE_BYTES = 5 * 1024 * 1024;
/** Past this many pixels an image is refused before it is drawn, so decoding it cannot exhaust the window's memory. */
export const MAX_PIXELS = 100_000_000;

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "heic" | "tiff" | "svg";
/** Formats sent as they are; every other one is drawn again as PNG or JPEG first. */
export const SENT_IMAGE_FORMATS: ReadonlySet<ImageFormat> = new Set(["png", "jpeg", "gif", "webp"]);
/** Formats the window cannot decode, converted by macOS's own image support (electron/attachments-ipc). */
export const MAC_IMAGE_FORMATS: ReadonlySet<ImageFormat> = new Set(["heic", "tiff"]);
export const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** The format an image's bytes say it is: browsers and file names report types that are not always right. */
export function imageFormat(bytes: Uint8Array): ImageFormat | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (at(0, 0x42, 0x4d)) return "bmp";
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return "tiff";
  // ISO media files name their kind in the "ftyp" box.
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "svg";
  return undefined;
}

const IMAGE_TYPES: Record<string, ImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};
const IMAGE_EXTENSIONS: Record<string, ImageFormat> = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", bmp: "bmp", avif: "avif", heic: "heic", heif: "heic", tif: "tiff", tiff: "tiff", svg: "svg" };

/** The format a file's type or name claims, before its bytes are read; the bytes decide when it is sent. */
export function claimedImageFormat(mediaType: string, filename?: string): ImageFormat | undefined {
  return IMAGE_TYPES[mediaType] ?? IMAGE_EXTENSIONS[extension(filename)];
}

/** Whether an image can be attached here: one the window decodes, or HEIC and TIFF on macOS. */
export function attachableImage(mediaType: string, filename: string | undefined, platform: string | undefined) {
  const format = claimedImageFormat(mediaType, filename);
  return Boolean(format) && (platform === "darwin" || !MAC_IMAGE_FORMATS.has(format!));
}

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "csv" | "text";

const BY_TYPE: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "text/tab-separated-values": "csv",
};
const BY_EXTENSION: Record<string, DocumentFormat> = { pdf: "pdf", docx: "docx", xlsx: "xlsx", csv: "csv", tsv: "csv" };
/** Text and code without a text/* type, as browsers often report them. */
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "jsonl", "yaml", "yml", "toml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "sql", "ini", "log", "env", "conf"]);

const extension = (name?: string) => name?.toLowerCase().split(".").at(-1) ?? "";

/** The document format of an attached file, or undefined for images, audio and formats not read. */
export function documentFormat(mediaType: string, filename?: string): DocumentFormat | undefined {
  if (mediaType.startsWith("image/") || mediaType.startsWith("audio/")) return undefined;
  const ext = extension(filename);
  return BY_TYPE[mediaType] ?? BY_EXTENSION[ext] ?? (mediaType.startsWith("text/") || mediaType === "application/json" || TEXT_EXTENSIONS.has(ext) ? "text" : undefined);
}

/** Formats the file dialog offers besides images. */
export const DOCUMENT_ACCEPT = ".pdf,.docx,.xlsx,.csv,.tsv,.md,.txt,.json,text/*";
