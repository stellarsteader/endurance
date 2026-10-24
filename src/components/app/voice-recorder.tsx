"use client";

import { featureModels, voiceModel } from "@/features/model-settings/feature-models";
import { usePreferenceRevision } from "@/features/model-settings/use-chat-models";
import { ipcMessage } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { MAX_AUDIO_BYTES, MAX_RECORDING_SECONDS, SAMPLE_RATE, type VoiceChoice } from "@/lib/voice-api";
import { ArrowUpIcon, LoaderCircleIcon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const SAMPLE_MS = 55;
const HISTORY = 240;

const join = (a: string, b: string) => [a.trimEnd(), b.trim()].filter(Boolean).join(" ");

/** The composer's text with `spoken` where recording started: after the text there was then, before anything typed since. */
function insertSpoken(now: string, base: string, spoken: string) {
  const at = now.startsWith(base) ? base.length : now.length;
  return join(join(now.slice(0, at), spoken), now.slice(at));
}

/**
 * A recording as 16 kHz mono 16-bit WAV, the format speech-to-text servers take. Portions derived from MIT-licensed
 * code (notice: src/harness/vendor/LICENSE).
 */
async function voiceWav(blob: Blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, buffer.byteLength - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true));
    return buffer;
  } finally {
    await context.close();
  }
}

/** The chosen speech-to-text model as the main process takes it, or nothing when none is chosen and listed. */
function voiceChoice(): VoiceChoice | undefined {
  const model = voiceModel();
  const connectionId = model?.connectionId ?? model?.runtime;
  if (!model?.runtimeModelId || !connectionId) return undefined;
  const language = featureModels().voiceLanguage;
  return { connectionId, runtimeModelId: model.runtimeModelId, ...(language ? { language } : {}) };
}

interface RecordingSession {
  stream: MediaStream;
  audioCtx: AudioContext;
  timer: ReturnType<typeof setInterval>;
  recorder: MediaRecorder;
  chunks: Blob[];
  choice: VoiceChoice;
  base: string;
  cancelled: boolean;
  /** Set once stopped: the transcription under way, shared by every caller of stop(). */
  finishing?: Promise<VoiceResult | undefined>;
  request?: string;
}

export interface VoiceResult {
  /** The composer's text with the transcription in it. */
  text: string;
  /** What was recognized; empty when nothing was said. */
  spoken: string;
}

export type VoiceState = "idle" | "recording" | "transcribing";

/**
 * Records from the mic and exposes a rolling volume history for the waveform. Stopping sends the recording to the
 * speech-to-text model chosen in Settings → Voice and puts its text where recording started. Without a chosen
 * model, `available` is false and nothing records.
 */
export function useVoiceRecording({
  getText,
  setText,
  onError,
}: {
  getText: () => string;
  setText: (text: string) => void;
  onError: (message: string) => void;
}) {
  usePreferenceRevision();
  const available = typeof window !== "undefined" && Boolean(window.enduranceVoice) && Boolean(voiceChoice());
  const [state, setState] = useState<VoiceState>("idle");
  const [levels, setLevels] = useState<number[]>([]);
  const session = useRef<RecordingSession | null>(null);
  const starting = useRef(false);
  // The text and callbacks as of the last render: a transcription finishes long after it was started.
  const latest = useRef({ getText, setText, onError });
  useLayoutEffect(() => {
    latest.current = { getText, setText, onError };
  });

  const release = useCallback((s: RecordingSession) => {
    clearInterval(s.timer);
    for (const track of s.stream.getTracks()) track.stop();
    s.audioCtx.close().catch(() => {});
  }, []);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.cancelled = true;
    if (s.recorder.state !== "inactive") s.recorder.stop();
    release(s);
    if (s.request) window.enduranceVoice?.cancelTranscription(s.request);
    session.current = null;
    setState("idle");
  }, [release]);

  useEffect(() => () => cancel(), [cancel]);

  const stop = useCallback((): Promise<VoiceResult | undefined> => {
    const s = session.current;
    if (!s) return Promise.resolve(undefined);
    if (s.finishing) return s.finishing;
    const recorded = new Promise<Blob>((resolve) => {
      const blob = () => new Blob(s.chunks, { type: s.recorder.mimeType || "audio/webm" });
      if (s.recorder.state === "inactive") return resolve(blob());
      s.recorder.onstop = () => resolve(blob());
      s.recorder.stop();
    });
    release(s);
    setState("transcribing");
    s.finishing = (async () => {
      try {
        const blob = await recorded;
        if (s.cancelled) return undefined;
        if (!blob.size) throw new Error("Nothing was recorded.");
        const wav = await voiceWav(blob);
        if (s.cancelled) return undefined;
        if (wav.byteLength > MAX_AUDIO_BYTES) throw new Error(`Recordings can be up to ${Math.floor(MAX_RECORDING_SECONDS / 60)} minutes.`);
        s.request = crypto.randomUUID();
        const spoken = (await window.enduranceVoice!.transcribe(s.request, s.choice, wav)).trim();
        if (s.cancelled) return undefined;
        if (!spoken) latest.current.onError("No speech was recognized.");
        const text = spoken ? insertSpoken(latest.current.getText(), s.base, spoken) : latest.current.getText();
        latest.current.setText(text);
        return { text, spoken };
      } catch (error) {
        if (!s.cancelled) latest.current.onError(error instanceof Error ? ipcMessage(error) : "Speech to text failed.");
        return undefined;
      } finally {
        if (session.current === s) {
          session.current = null;
          setState("idle");
        }
      }
    })();
    return s.finishing;
  }, [release]);

  const stopRef = useRef(stop);
  useLayoutEffect(() => {
    stopRef.current = stop;
  });

  const start = useCallback(async () => {
    if (session.current || starting.current) return;
    const choice = voiceChoice();
    if (!choice || !window.enduranceVoice) {
      latest.current.onError("Choose a speech-to-text model in Settings → Voice.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      latest.current.onError("Recording isn't available in this window.");
      return;
    }
    starting.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      latest.current.onError("Microphone access was blocked. Allow Endurance under Privacy & Security → Microphone in System Settings.");
      return;
    } finally {
      starting.current = false;
    }

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);
    let smoothed = 0;
    const startedAt = Date.now();

    const timer = setInterval(() => {
      // A recording stops at the longest that can be sent, and is transcribed up to there.
      if (Date.now() - startedAt >= (MAX_RECORDING_SECONDS - 2) * 1000) {
        latest.current.onError(`Recording stopped at ${Math.floor(MAX_RECORDING_SECONDS / 60)} minutes, the longest that can be transcribed.`);
        void stopRef.current();
        return;
      }
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const level = Math.min(1, Math.sqrt(sum / buffer.length) * 5);
      smoothed = level > smoothed ? level : smoothed * 0.6 + level * 0.4;
      setLevels((prev) => [...prev.slice(-(HISTORY - 1)), smoothed]);
    }, SAMPLE_MS);

    const recorder = new MediaRecorder(stream);
    const s: RecordingSession = { stream, audioCtx, timer, recorder, chunks: [], choice, base: latest.current.getText(), cancelled: false };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) s.chunks.push(e.data);
    };
    recorder.start(250);

    session.current = s;
    setLevels([]);
    setState("recording");
  }, []);

  return { available, state, active: state !== "idle", transcribing: state === "transcribing", levels, start, cancel, stop };
}

function Waveform({ levels }: { levels: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(80);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setSlots(Math.max(10, Math.floor(entry.contentRect.width / 6)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visible = levels.slice(-slots);
  const padded = [...Array.from({ length: slots - visible.length }, () => 0), ...visible];

  return (
    <div aria-hidden className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden" ref={ref}>
      {padded.map((level, i) => {
        const quiet = level < 0.05;
        return (
          <span
            className={cn(
              "w-[3px] shrink-0 rounded-full transition-[height] duration-75",
              quiet ? "bg-muted-foreground/40" : "bg-foreground/70"
            )}
            key={i}
            style={{ height: quiet ? 3 : Math.round(4 + level * 26) }}
          />
        );
      })}
    </div>
  );
}

export function RecordingBar({
  levels,
  transcribing,
  onCancel,
  onStop,
  onSend,
}: {
  levels: number[];
  transcribing?: boolean;
  onCancel: () => void;
  onStop: () => void;
  onSend: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-3">
      <button
        aria-label={transcribing ? "Cancel transcription" : "Cancel recording"}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={onCancel}
        type="button"
      >
        <XIcon className="size-4" />
      </button>
      {transcribing ? (
        <div className="flex h-7 min-w-0 flex-1 items-center justify-end gap-2 text-[13px] text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Transcribing…
        </div>
      ) : (
        <>
          <Waveform levels={levels} />
          <button
            aria-label="Stop recording"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/70 text-foreground transition-colors hover:bg-muted"
            onClick={onStop}
            type="button"
          >
            <SquareIcon className="size-3 fill-current" />
          </button>
        </>
      )}
      <button
        aria-label="Send voice message"
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
        onClick={onSend}
        type="button"
      >
        <ArrowUpIcon className="size-4" />
      </button>
    </div>
  );
}
