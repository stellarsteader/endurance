/**
 * Voice input: the renderer records and converts to 16 kHz mono 16-bit WAV, the main process names the
 * connection, and the chat worker sends the audio to the model's OpenAI-compatible /audio/transcriptions, or on
 * Ollama to Qwen3-ASR through /api/chat and /api/generate.
 * Pure, shared by the renderer, the main process and the harness.
 */

/** Whisper's sample rate; the renderer converts every recording to it. */
export const SAMPLE_RATE = 16_000;
/** The largest recording sent, as WAV: OpenAI's transcription limit, about 13 minutes at 16 kHz. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Whisper hears 30 seconds at a time; longer recordings are sent in pieces of at most this length. */
export const CHUNK_SECONDS = 30;
/** The longest recording that fits under MAX_AUDIO_BYTES, in seconds. */
export const MAX_RECORDING_SECONDS = Math.floor((MAX_AUDIO_BYTES - 44) / (SAMPLE_RATE * 2));

/** The recognition language as sent (ISO 639-1); unset lets the model detect it. */
export const VOICE_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ko", label: "Korean" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ru", label: "Russian" },
  { code: "hi", label: "Hindi" },
];
export const validLanguage = (value: unknown): value is string => typeof value === "string" && /^[a-z]{2,3}$/.test(value);

/** The model that transcribes, by name; the main process adds its address and secrets. */
export interface VoiceChoice {
  connectionId: string;
  runtimeModelId: string;
  language?: string;
}

/** The chat worker's answer to a transcription. */
export type TranscribeEvent = { id: string; type: "transcribed"; text: string };

export interface VoiceAPI {
  /** The recording's text. `id` names the request so it can be cancelled; `audio` is a 16 kHz mono WAV. */
  transcribe(id: string, choice: VoiceChoice, audio: ArrayBuffer): Promise<string>;
  /** Stops a transcription; its promise rejects and no text arrives. */
  cancelTranscription(id: string): void;
}
declare global {
  interface Window {
    enduranceVoice?: VoiceAPI;
  }
}
