import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, UtilityProcess, WebContents } from "electron";
import { resolveConnection } from "./connections-ipc";
import { MAX_AUDIO_BYTES, validLanguage, type TranscribeEvent } from "../src/lib/voice-api";

type Trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => void;

/** Transcriptions waiting for the chat worker, by the worker's request ID. */
const pending = new Map<string, { owner: WebContents; id: string; child: UtilityProcess; resolve: (text: string) => void; reject: (error: Error) => void; done: () => void }>();

/** Microphone only: a request that also asks for the camera or the screen is refused. */
export function audioOnly(details: object) {
  const types = "mediaTypes" in details ? details.mediaTypes : undefined;
  return Array.isArray(types) && types.length === 1 && types[0] === "audio";
}

/** Settles a transcription from the worker's answer; false when the event is not one. */
export function answerTranscription(event: { id?: unknown; type: string; message?: string; text?: string }) {
  const request = typeof event.id === "string" ? pending.get(event.id) : undefined;
  if (!request) return false;
  if (event.type === "transcribed") request.resolve((event as TranscribeEvent).text);
  else if (event.type === "error") request.reject(new Error(event.message ?? "Speech to text failed."));
  else return true;
  request.done();
  return true;
}

/** The worker stopped: every waiting transcription fails. */
export function failTranscriptions() {
  for (const request of [...pending.values()]) {
    request.reject(new Error("The local chat process stopped. Record again."));
    request.done();
  }
}

/**
 * The renderer sends the recording and names the model; the connection's address and secrets come from the
 * saved copy here, and the chat worker makes the request.
 */
export function registerVoiceIPC(trusted: Trusted, worker: () => UtilityProcess) {
  ipcMain.handle("voice:transcribe", (event, id: unknown, choice: unknown, audio: unknown) => {
    trusted(event);
    const value = (choice && typeof choice === "object" ? choice : {}) as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9-]{1,80}$/i.test(id) || [...pending.values()].some((request) => request.owner === event.sender && request.id === id)) throw new Error("Invalid transcription request");
    if (typeof value.connectionId !== "string" || value.connectionId.length > 128 || typeof value.runtimeModelId !== "string" || !value.runtimeModelId || value.runtimeModelId.length > 512) throw new Error("Invalid transcription request");
    if (value.language !== undefined && !validLanguage(value.language)) throw new Error("Invalid transcription request");
    if (!(audio instanceof ArrayBuffer) && !(audio instanceof Uint8Array)) throw new Error("Invalid transcription request");
    const bytes = audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio;
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error(`The recording is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB. Record a shorter one.`);
    const resolved = resolveConnection(value.connectionId);
    if (!resolved) throw new Error("The speech-to-text model's server is no longer listed. Choose another model in Settings → Voice.");
    const body = { runtime: resolved.runtime, runtimeModelId: value.runtimeModelId, connection: resolved.value, ...(value.language ? { language: value.language } : {}) };
    const job = crypto.randomUUID();
    const owner = event.sender;
    const child = worker();
    return new Promise<string>((resolve, reject) => {
      // A window that closes or reloads cancels its transcriptions.
      // A cancel settles with no text rather than an error: the window drops it anyway, and Electron logs every rejection.
      const gone = () => { child.postMessage({ id: job, type: "cancel" }); resolve(""); done(); };
      const done = () => { pending.delete(job); owner.removeListener("destroyed", gone); };
      owner.once("destroyed", gone);
      pending.set(job, { owner, id, child, resolve, reject, done });
      child.postMessage({ id: job, type: "transcribe", body: JSON.stringify(body), audio: bytes });
    });
  });
  ipcMain.on("voice:cancel", (event, id: unknown) => {
    trusted(event);
    for (const [job, request] of pending)
      if (request.owner === event.sender && request.id === id) {
        request.child.postMessage({ id: job, type: "cancel" });
        request.resolve("");
        request.done();
      }
  });
}
