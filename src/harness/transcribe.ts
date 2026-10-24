/**
 * Speech to text through a model's OpenAI-compatible /audio/transcriptions, such as Whisper on the managed vLLM
 * server, or through Ollama's own chat and generate endpoints for Qwen3-ASR. The recording arrives as 16 kHz mono
 * 16-bit WAV (src/components/app/voice-recorder.tsx) and is sent in pieces of at most 30 seconds, cut where it is
 * quietest, whose texts are joined in order. Portions derived from MIT-licensed code (notice: vendor/LICENSE).
 */
import { Ollama } from "./vendor/schema/ollama";
import { checkTimeout, classify, endpoint, headers, ollamaSpeech, runtimeUrl } from "./runtime";
import { CHUNK_SECONDS, MAX_AUDIO_BYTES, SAMPLE_RATE, validLanguage } from "../lib/voice-api";
import type { RuntimeConnection, RuntimeId } from "../lib/models";

export interface TranscribeRequest {
  runtime?: RuntimeId;
  runtimeModelId: string;
  connection: RuntimeConnection;
  /** ISO 639-1; unset lets the model detect the language. */
  language?: string;
}

export interface TranscribeOptions {
  transport?: typeof fetch;
  /** How long one piece may take; Whisper on a CPU can need most of a minute for 30 seconds of audio. */
  timeoutMs?: number;
}

const HEADER = 44;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
export const PIECE_TIMEOUT_MS = 120_000;
/** A cut is looked for in the last seconds of each piece, in frames of 20 ms. */
const SEARCH_SECONDS = 5;
const FRAME_SAMPLES = SAMPLE_RATE / 50;

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** The samples of a 16 kHz mono 16-bit PCM WAV with the plain 44-byte header the app writes. */
export function wavSamples(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const valid =
    wav.byteLength >= HEADER &&
    ascii(wav, 0, 4) === "RIFF" &&
    ascii(wav, 8, 4) === "WAVE" &&
    ascii(wav, 12, 4) === "fmt " &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === SAMPLE_RATE &&
    view.getUint16(34, true) === 16 &&
    ascii(wav, 36, 4) === "data" &&
    view.getUint32(40, true) === wav.byteLength - HEADER;
  if (!valid) throw new Error("The recording could not be read. Record again.");
  return wav.subarray(HEADER);
}

/** A WAV file around 16 kHz mono 16-bit samples. */
export function wavFile(samples: Uint8Array): Uint8Array<ArrayBuffer> {
  const file = new Uint8Array(HEADER + samples.byteLength);
  const view = new DataView(file.buffer);
  const text = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, file.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.byteLength, true);
  file.set(samples, HEADER);
  return file;
}

/**
 * Pieces of at most `seconds`, in order and together the whole recording. Each one longer than that ends at the
 * quietest 20 ms in its last seconds, so a cut seldom falls inside a word.
 */
export function splitSamples(samples: Uint8Array, seconds = CHUNK_SECONDS): Uint8Array[] {
  const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength);
  const total = Math.floor(samples.byteLength / 2);
  const most = seconds * SAMPLE_RATE;
  const search = Math.min(SEARCH_SECONDS * SAMPLE_RATE, Math.floor(most / 6));
  const pieces: Uint8Array[] = [];
  let start = 0;
  while (start < total) {
    const limit = Math.min(total, start + most);
    let end = limit;
    if (limit < total) {
      let quietest = Infinity;
      for (let frame = limit - search; frame + FRAME_SAMPLES <= limit; frame += FRAME_SAMPLES) {
        let loudness = 0;
        for (let i = frame; i < frame + FRAME_SAMPLES; i++) loudness += Math.abs(view.getInt16(i * 2, true));
        if (loudness < quietest) {
          quietest = loudness;
          end = frame + FRAME_SAMPLES;
        }
      }
    }
    pieces.push(samples.subarray(start * 2, end * 2));
    start = end;
  }
  return pieces;
}

/** Chinese and Japanese pieces join without a space; other scripts with one. */
const DENSE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
export function joinPieces(texts: string[]) {
  return texts.reduce((joined, text) => {
    const next = text.trim();
    if (!next) return joined;
    if (!joined) return next;
    return DENSE.test(joined.at(-1)!) && DENSE.test(next[0]) ? joined + next : `${joined} ${next}`;
  }, "");
}

/** The server's own reason in an error answer, when it gives one. */
async function serverReason(response: Response) {
  try {
    const text = (await response.text()).slice(0, 4000);
    const value: unknown = JSON.parse(text);
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const error = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).message : record.error;
    const reason = typeof error === "string" ? error : typeof record.detail === "string" ? record.detail : typeof record.message === "string" ? record.message : undefined;
    return reason?.trim().slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

function failure(status: number, reason: string | undefined, missing = "This server has no speech-to-text endpoint (/audio/transcriptions), or it doesn't serve this model.") {
  if (status === 401 || status === 403) return "The speech-to-text server refused the request. Check its key in Settings → Connections.";
  if (status === 413) return "The recording is too large for this server.";
  if ((status === 404 || status === 405) && !reason) return missing;
  return reason ? `Speech to text failed: ${reason}` : `Speech to text failed: the server answered HTTP ${status}.`;
}

function unreachable(error: unknown, timeoutMs: number) {
  const reason = classify(error);
  if (reason === "timeout") return `The speech-to-text model didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`;
  if (reason === "refused" || reason === "host") return "Couldn't reach the speech-to-text server. Check that it is running.";
  if (reason === "tls") return "The speech-to-text server's certificate was not accepted.";
  if (reason === "address") return "The speech-to-text server's address is not valid.";
  return "Couldn't reach the speech-to-text server.";
}

async function transcribePiece(request: TranscribeRequest, url: string, wav: Uint8Array<ArrayBuffer>, signal: AbortSignal, options: Required<TranscribeOptions>) {
  const body = new FormData();
  body.append("file", new Blob([wav], { type: "audio/wav" }), "recording.wav");
  body.append("model", request.runtimeModelId);
  body.append("response_format", "json");
  if (validLanguage(request.language)) body.append("language", request.language);
  let response: Response;
  try {
    response = await options.transport(url, {
      method: "POST",
      body,
      headers: headers(request.connection),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(unreachable(error, options.timeoutMs));
  }
  if (!response.ok) throw new Error(failure(response.status, await serverReason(response)));
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error("The speech-to-text server's answer was not a transcription.");
  }
  const text = value && typeof value === "object" ? (value as { text?: unknown }).text : undefined;
  if (typeof text !== "string") throw new Error("The speech-to-text server's answer was not a transcription.");
  return text;
}

/** Qwen3-ASR's language names, by the ISO 639 code the app keeps; its prompt names the language in English. */
export const QWEN_ASR_LANGUAGES: Record<string, string> = {
  ko: "Korean",
  en: "English",
  zh: "Chinese",
  yue: "Cantonese",
  ar: "Arabic",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  id: "Indonesian",
  it: "Italian",
  ru: "Russian",
  th: "Thai",
  vi: "Vietnamese",
  ja: "Japanese",
  tr: "Turkish",
  hi: "Hindi",
  ms: "Malay",
  nl: "Dutch",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  pl: "Polish",
  cs: "Czech",
  fil: "Filipino",
  fa: "Persian",
  el: "Greek",
  ro: "Romanian",
  hu: "Hungarian",
  mk: "Macedonian",
};

const ASR_MARKER = "<asr_text>";

/** The text Qwen3-ASR heard: what follows its `<asr_text>` marker, without special tokens. */
export function asrText(content: string, prefixed: boolean) {
  const marker = content.indexOf(ASR_MARKER);
  // Without a language prefix the model writes the marker itself; an answer without it is not a transcription.
  if (marker < 0 && !prefixed) return undefined;
  return (marker < 0 ? content : content.slice(marker + ASR_MARKER.length)).replace(/<\|[^>]*\|>/g, "").trim();
}

const NOT_ASR = "This Ollama model doesn't transcribe speech. Choose a Qwen3-ASR model, such as frozenlab/qwen3-asr:0.6b, in Settings → Voice.";
const CLOUD = "Ollama cloud models can't transcribe recordings. Choose a model on the Ollama server in Settings → Voice.";
const MISSING = "This Ollama server doesn't have the speech-to-text model. Choose another in Settings → Voice.";

/**
 * Checks with /api/show that the Ollama model is on the server, runs there rather than in Ollama's cloud, and
 * is a speech model (runtime's ollamaSpeech). A chat model that also hears would answer Qwen3-ASR's prompt as a
 * chat, and its reply would be pasted as if it were what was said.
 */
async function checkOllamaModel(request: TranscribeRequest, root: string, signal: AbortSignal, transport: typeof fetch) {
  if (/[:-]cloud$/i.test(request.runtimeModelId)) throw new Error(CLOUD);
  const timeoutMs = checkTimeout(request.connection, 5000);
  let response: Response;
  try {
    response = await transport(runtimeUrl(request.connection, `${root}/api/show`), {
      method: "POST",
      body: JSON.stringify({ model: request.runtimeModelId }),
      headers: { ...headers(request.connection), "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(unreachable(error, timeoutMs));
  }
  if (!response.ok) throw new Error(failure(response.status, await serverReason(response), MISSING));
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error("The Ollama server's answer about the model could not be read.");
  }
  const info = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if ((typeof info.remote_host === "string" && info.remote_host) || (typeof info.remote_model === "string" && info.remote_model))
    throw new Error(CLOUD);
  if (!ollamaSpeech(info, request.runtimeModelId)) throw new Error(NOT_ASR);
}

/**
 * One piece through Ollama, as Qwen3-ASR takes it: with automatic language a chat message with an empty prompt
 * and the audio as its image; with a chosen language a raw generation whose prompt ends in Qwen's
 * `language {Language}<asr_text>` prefix, which raw mode keeps even under older chat templates.
 */
async function transcribeOllamaPiece(request: TranscribeRequest, root: string, language: string | undefined, wav: Uint8Array<ArrayBuffer>, signal: AbortSignal, options: Required<TranscribeOptions>) {
  const audio = Buffer.from(wav).toString("base64");
  const body = language
    ? { model: request.runtimeModelId, stream: false, raw: true, prompt: `<|im_start|>system\n<|im_end|>\n<|im_start|>user\n[img-0]<|im_end|>\n<|im_start|>assistant\nlanguage ${language}${ASR_MARKER}`, images: [audio] }
    : { model: request.runtimeModelId, stream: false, messages: [{ role: "user", content: "", images: [audio] }] };
  let response: Response;
  try {
    response = await options.transport(runtimeUrl(request.connection, `${root}/api/${language ? "generate" : "chat"}`), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { ...headers(request.connection), "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(unreachable(error, options.timeoutMs));
  }
  if (!response.ok) throw new Error(failure(response.status, await serverReason(response), MISSING));
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error("The speech-to-text server's answer was not a transcription.");
  }
  const data = value && typeof value === "object" ? (value as { response?: unknown; message?: { content?: unknown } }) : {};
  const content = language ? data.response : data.message && typeof data.message === "object" ? data.message.content : undefined;
  const text = typeof content === "string" ? asrText(content, Boolean(language)) : undefined;
  if (text === undefined) throw new Error(typeof content === "string" ? NOT_ASR : "The speech-to-text server's answer was not a transcription.");
  return text;
}

/** The recording's text, empty when nothing was said. Rejects with `signal.reason` once cancelled. */
export async function transcribe(request: TranscribeRequest, wav: Uint8Array, signal: AbortSignal, options: TranscribeOptions = {}) {
  if (typeof request.runtimeModelId !== "string" || !request.runtimeModelId) throw new Error("Choose a speech-to-text model in Settings → Voice.");
  if (wav.byteLength > MAX_AUDIO_BYTES) throw new Error(`The recording is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB. Record a shorter one.`);
  const samples = wavSamples(wav);
  if (samples.byteLength < 2) throw new Error("Nothing was recorded.");
  const settings = { transport: options.transport ?? fetch, timeoutMs: options.timeoutMs ?? PIECE_TIMEOUT_MS };
  const texts: string[] = [];
  if (request.runtime === "ollama") {
    // Qwen3-ASR's prompt names the language; one it does not know is refused rather than sent as automatic.
    const language = validLanguage(request.language) ? QWEN_ASR_LANGUAGES[request.language] : undefined;
    if (validLanguage(request.language) && !language) throw new Error("Qwen3-ASR doesn't recognise the chosen language. Choose another, or Automatic, in Settings → Voice.");
    const root = Ollama.baseURL(endpoint(request.connection));
    if (signal.aborted) throw signal.reason;
    await checkOllamaModel(request, root, signal, settings.transport);
    for (const piece of splitSamples(samples)) {
      if (signal.aborted) throw signal.reason;
      texts.push(await transcribeOllamaPiece(request, root, language, wavFile(piece), signal, settings));
    }
    return joinPieces(texts);
  }
  const url = runtimeUrl(request.connection, `${endpoint(request.connection)}/audio/transcriptions`);
  for (const piece of splitSamples(samples)) {
    if (signal.aborted) throw signal.reason;
    texts.push(await transcribePiece(request, url, wavFile(piece), signal, settings));
  }
  return joinPieces(texts);
}

/** A transcription job from the main process (electron/voice-ipc): the request as JSON and the WAV bytes. */
export function transcribeJob(body: string, audio: unknown, signal: AbortSignal) {
  const bytes = audio instanceof Uint8Array ? audio : audio instanceof ArrayBuffer ? new Uint8Array(audio) : undefined;
  if (!bytes) throw new Error("The recording could not be read. Record again.");
  return transcribe(JSON.parse(body) as TranscribeRequest, bytes, signal);
}
