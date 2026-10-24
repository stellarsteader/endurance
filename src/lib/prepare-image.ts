/**
 * Images are made ready in the window when a message is sent, and the chat keeps only what was
 * sent, so the person and the model see the same image under the same name. The format comes from the bytes. PNG,
 * JPEG, GIF and WebP within IMAGE_SIDE and IMAGE_BYTES go as they are. Anything else, anything larger, and a photo
 * that is turned by its EXIF orientation is drawn again (the window applies the orientation) and sent as PNG, or as
 * JPEG when it has no transparency and PNG would be too large. HEIC and TIFF, which the window cannot decode, are
 * converted to PNG by macOS first; elsewhere they are refused.
 */
import type { FileUIPart } from "ai";
import { base64Size, IMAGE_BYTES, IMAGE_SIDE, imageFormat, MAC_IMAGE_FORMATS, MAX_IMAGE, MAX_PIXELS, SENT_IMAGE_FORMATS, type ImageFormat } from "./attachments";

/** Why an image cannot be sent, worded for the person. */
export class ImageError extends Error {}

const TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };
/** Tried in order until the image fits IMAGE_BYTES; an opaque image may fall back to JPEG. */
const OPAQUE = [["image/png"], ["image/jpeg", 0.85], ["image/jpeg", 0.7], ["image/jpeg", 0.55]] as const;
const PHOTO = [["image/jpeg", 0.85], ["image/jpeg", 0.7], ["image/jpeg", 0.55]] as const;
const CLEAR = [["image/png"]] as const;

async function bytesOf(url: string) {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

function dataUrl(bytes: Uint8Array, type: string) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

/** The EXIF orientation of a JPEG (1 when upright or not stated). */
function orientation(bytes: Uint8Array) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 2; at + 4 <= view.byteLength; ) {
      const marker = view.getUint16(at);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1;
      // APP1 holding "Exif\0\0", then a TIFF header and the first directory of tags.
      if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966) {
        const tiff = at + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const directory = tiff + view.getUint32(tiff + 4, little);
        const count = view.getUint16(directory, little);
        for (let index = 0; index < count; index++) {
          const entry = directory + 2 + index * 12;
          if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
        }
        return 1;
      }
      at += 2 + view.getUint16(at + 2);
    }
  } catch {
    // A malformed header reads as upright; the image is still decoded and checked.
  }
  return 1;
}

function decode(bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode"));
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

function draw(image: HTMLImageElement, width: number, height: number, scale: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function transparent(canvas: HTMLCanvasElement) {
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < data.length; index += 4) if (data[index] < 255) return true;
  return false;
}

async function encode(canvas: HTMLCanvasElement, type: string, quality?: number) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error("encode");
  return new Uint8Array(await blob.arrayBuffer());
}

/** The file's name for its new format, so the name and the bytes agree (photo.heic sent as PNG is photo.png). */
function renamed(filename: string | undefined, type: string) {
  if (!filename) return filename;
  const extension = EXTENSIONS[type];
  const stem = filename.replace(/\.[^./\\]+$/, "");
  return /\.(jpe?g)$/i.test(filename) && extension === "jpg" ? filename : `${stem}.${extension}`;
}

/** The image as it is sent and kept. `convert` turns HEIC or TIFF bytes into PNG; it is given on macOS only. */
export async function prepareImage(file: FileUIPart, convert?: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<FileUIPart> {
  const name = file.filename ?? "The image";
  let bytes: Uint8Array = await bytesOf(file.url);
  if (bytes.byteLength > MAX_IMAGE) throw new ImageError(`${name} is larger than ${MAX_IMAGE / 1024 / 1024} MB.`);
  let format = imageFormat(bytes);
  let converted = false;
  if (format && MAC_IMAGE_FORMATS.has(format)) {
    if (!convert) throw new ImageError(`${name} is ${format.toUpperCase()}, which can be converted only on macOS. Save it as PNG or JPEG and attach it again.`);
    bytes = await convert(bytes).catch(() => {
      throw new ImageError(`${name} could not be converted to PNG.`);
    });
    format = imageFormat(bytes);
    converted = true;
  }
  if (!format) throw new ImageError(`${name} is not an image format that can be read.`);
  const image = await decode(bytes, TYPES[format]).catch(() => {
    throw new ImageError(`${name} could not be read as an image.`);
  });
  // An SVG may state no size of its own.
  const width = image.naturalWidth || IMAGE_SIDE;
  const height = image.naturalHeight || IMAGE_SIDE;
  if (width * height > MAX_PIXELS) throw new ImageError(`${name} has too many pixels to prepare (${width}×${height}).`);
  const fits = Math.max(width, height) <= IMAGE_SIDE && base64Size(bytes.byteLength) <= IMAGE_BYTES;
  const upright = format !== "jpeg" || orientation(bytes) === 1;
  if (SENT_IMAGE_FORMATS.has(format) && fits && upright)
    return { ...file, mediaType: TYPES[format], filename: converted ? renamed(file.filename, TYPES[format]) : file.filename, url: dataUrl(bytes, TYPES[format]) };
  let scale = Math.min(1, IMAGE_SIDE / Math.max(width, height));
  // Each pass that cannot fit IMAGE_BYTES draws the image a quarter smaller.
  for (let pass = 0; pass < 6; pass++, scale *= 0.75) {
    const canvas = draw(image, width, height, scale);
    const tries = format === "jpeg" ? PHOTO : transparent(canvas) ? CLEAR : OPAQUE;
    for (const [type, quality] of tries) {
      const encoded = await encode(canvas, type, quality);
      if (base64Size(encoded.byteLength) <= IMAGE_BYTES) return { ...file, mediaType: type, filename: renamed(file.filename, type), url: dataUrl(encoded, type) };
    }
  }
  throw new ImageError(`${name} could not be made small enough to send.`);
}
