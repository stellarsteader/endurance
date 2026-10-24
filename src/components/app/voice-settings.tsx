"use client";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { featureModels, saveFeatureModels, voiceModel, voiceModels } from "@/features/model-settings/feature-models";
import { decorateModel } from "@/features/model-settings/preferences";
import { usePreferenceRevision } from "@/features/model-settings/use-chat-models";
import { locationLabel } from "@/lib/connections";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { VOICE_LANGUAGES } from "@/lib/voice-api";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { PageScroll } from "./page-scroll";
import { useVoiceRecording } from "./voice-recorder";

function Row({ label, hint, children }: { label: string; hint: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-[13px] leading-[1.4]">{label}</div>
        <div className="text-[12px] leading-[1.35] text-muted-foreground">{hint}</div>
      </div>
      {children && <div className="flex w-52 shrink-0 justify-end">{children}</div>}
    </div>
  );
}

const trigger = "h-7 w-full rounded-[6px] text-[13px]";
const button = "h-7 shrink-0 rounded-[6px] px-2.5 text-[12px]";

/** Records a few words and shows what the chosen model heard, through the same path as the composer. */
function TestRecording({ ready }: { ready: boolean }) {
  const [heard, setHeard] = useState<string>();
  const [error, setError] = useState<string>();
  const voice = useVoiceRecording({ getText: () => "", setText: setHeard, onError: setError });
  const hint = error ? (
    <span className="text-destructive">{error}</span>
  ) : heard ? (
    <span className="text-foreground">{heard}</span>
  ) : voice.state === "recording" ? (
    "Listening… Stop to transcribe."
  ) : voice.transcribing ? (
    "Transcribing…"
  ) : (
    "Record a few words to check the model and language."
  );
  return (
    <Row hint={hint} label="Test">
      {voice.state === "recording" ? (
        <Button className={button} onClick={() => void voice.stop()} variant="secondary">
          <SquareIcon className="size-3 fill-current" />
          Stop
        </Button>
      ) : voice.transcribing ? (
        <Button className={button} onClick={voice.cancel} variant="secondary">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Cancel
        </Button>
      ) : (
        <Button
          className={button}
          disabled={!ready || !voice.available}
          onClick={() => {
            setHeard(undefined);
            setError(undefined);
            void voice.start();
          }}
          variant="secondary"
        >
          <MicIcon className="size-3.5" />
          Record
        </Button>
      )}
    </Row>
  );
}

export function VoiceSettings() {
  const { connections, setSettingsSection } = useStore();
  usePreferenceRevision();
  const choices = voiceModels().map(decorateModel);
  const { voice: chosen, voiceLanguage } = featureModels();
  const current = voiceModel();
  const language = VOICE_LANGUAGES.find((item) => item.code === voiceLanguage);
  const connection = current ? connections.find((item) => item.id === (current.connectionId ?? current.runtime)) : undefined;

  return (
    <PageScroll>
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <h1 className="mb-6 pl-2 font-medium text-[15px] leading-[1.6]">Voice</h1>
        <section className="divide-y overflow-hidden rounded-[12px] border bg-card">
          <Row
            hint={
              choices.length === 0
                ? "No speech-to-text model is listed. Run Whisper on the Endurance vLLM server, or Qwen3-ASR on Ollama (frozenlab/qwen3-asr:0.6b, a community model). Another model can be set to Speech to text in Models settings."
                : chosen && !current
                  ? "The chosen model is no longer available. Voice input is off until you choose one."
                  : "Transcribes what you record in the message box. Without a model, voice input is off."
            }
            label="Speech-to-text model"
          >
            {choices.length === 0 ? (
              <Button className={button} onClick={() => setSettingsSection("models")} variant="secondary">
                Models
              </Button>
            ) : (
              <Select
                onValueChange={(value) => {
                  if (value === null) return;
                  saveFeatureModels({ voice: value === "none" ? undefined : value });
                }}
                value={current ? current.id : "none"}
              >
                <SelectTrigger aria-label="Speech-to-text model" className={trigger} size="sm">
                  <SelectValue>{current ? (choices.find((model) => model.id === current.id)?.name ?? current.name) : "None"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {choices.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      <span className="truncate">{model.name}</span>
                      <span className="text-[12px] leading-[1.35] text-muted-foreground">{model.providerLabel}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Row>
          <Row hint="Automatic lets the model detect the language you speak." label="Language">
            <Select
              onValueChange={(value) => {
                if (value === null) return;
                saveFeatureModels({ voiceLanguage: value === "auto" ? undefined : value });
              }}
              value={language ? language.code : "auto"}
            >
              <SelectTrigger aria-label="Recognition language" className={trigger} size="sm">
                <SelectValue>{language ? language.label : "Automatic"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic</SelectItem>
                {VOICE_LANGUAGES.map((item) => (
                  <SelectItem key={item.code} value={item.code}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {connection && (
            <Row hint="Each recording is sent there to be transcribed. Endurance doesn't keep recordings." label="Where recordings go">
              <span className={cn("truncate text-[13px] leading-[1.4]", connection.location === "remote" ? "text-foreground" : "text-muted-foreground")}>
                {connection.label} · {locationLabel(connection.location)}
              </span>
            </Row>
          )}
          <TestRecording ready={Boolean(current)} />
        </section>
      </div>
    </PageScroll>
  );
}
