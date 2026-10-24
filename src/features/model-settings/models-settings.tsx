import { useEffect, useRef, useState } from "react";
import { SettingsIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { formatContext, MODEL_KINDS, runtimeName, type ModelInfo, type ModelKind } from "../../lib/models";
import type { ConnectionView } from "../../lib/connections";
import { useStore } from "../../lib/store";
import { cn } from "../../lib/utils";
import { HuggingFaceSettings } from "./huggingface-settings";
import { clearInstallFocus, useInstallFocus } from "./downloads";
import { connectionKey, decorateModel, preferencesFor, recordReportedMemory, savePreferences } from "./preferences";
import { featureModels, readingModels, saveFeatureModels } from "./feature-models";
import { ManagedServer } from "./managed-server";
import { RuntimeTitle } from "./runtime-title";
import type { ManagerInfo } from "./manager-client";
import { usePreferenceRevision } from "./use-chat-models";
import type { RuntimeModelDetails } from "./types";
import { draftOf, invalidFields, SamplingFields, setsOf, type SamplingDraft } from "./sampling-fields";
import { formatBytes } from "./download-progress";
import { estimateMemory, type ReportedMemory } from "../../lib/memory-estimate";
import { windowStore, type WindowStore } from "../../lib/context-window";
import { switchesByTemplate, THINKING_SWITCH_CHOICES, type ThinkingSwitchChoice } from "../../lib/thinking-switch";
import { ipcMessage } from "../../lib/desktop";
import { PageScroll } from "@/components/app/page-scroll";

type ModelProps = {
  model: ModelInfo;
  connection: ConnectionView;
};

const CONTEXT_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
const contextLabel = formatContext;

/** An estimate reads as one: ≈ about, ≤ at most, ≥ at least. */
function estimateLabel(details: RuntimeModelDetails, context: number | undefined, reported?: ReportedMemory[]) {
  if (!context) return undefined;
  const estimate = estimateMemory(details, context, reported);
  if (!estimate) return undefined;
  const mark = estimate.bound === "upper" ? "≤" : estimate.bound === "lower" ? "≥" : "≈";
  return { bytes: estimate.bytes, text: `${mark} ${formatBytes(estimate.bytes)} at ${contextLabel(context)}` };
}

/**
 * The model's context setting, kept where the runtime keeps it (lib/context-window): Ollama's Modelfile num_ctx;
 * LM Studio's window is the person's, else what is loaded; on other servers it is the person's cap, and unset
 * means the whole window the server serves.
 */
function contextSetting(store: WindowStore, details: RuntimeModelDetails, limit?: number) {
  if (store === "runtime") return details.configured;
  if (store === "load") return limit ?? details.loadedContext;
  return limit;
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-6">
      <div className={wide ? "shrink-0" : "min-w-0 flex-1"}>
        <div className="text-[13px] leading-[1.4]">{label}</div>
        {hint && <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">{hint}</div>}
      </div>
      <div className={wide ? "flex min-w-0 flex-1 justify-end" : "flex w-52 shrink-0 justify-end"}>{children}</div>
    </div>
  );
}

function ModelEditor({
  model,
  connection,
  suggestedName,
  onClose,
}: ModelProps & { suggestedName?: string; onClose: () => void }) {
  const { refreshModels, statuses } = useStore();
  const modelId = model.runtimeModelId ?? model.name;
  const preference = preferencesFor(connection, modelId);
  const name = preference.displayName ?? model.name;
  const target = { connectionId: connection.id };
  const runtime = model.runtime ?? connection.kind;
  const [displayName, setDisplayName] = useState(preference.displayName ?? suggestedName ?? model.name);
  const [context, setContext] = useState<number | undefined>(undefined);
  const [thinking, setThinking] = useState(preference.thinking !== false);
  // For runtimes that do not report capabilities, the person says what the model takes.
  const [visionSet, setVisionSet] = useState(Boolean(preference.vision));
  const [reasoningSet, setReasoningSet] = useState(Boolean(preference.reasoning));
  const [thinkingSwitch, setThinkingSwitch] = useState<ThinkingSwitchChoice>(preference.thinkingSwitch ?? "auto");
  const [sampling, setSampling] = useState<SamplingDraft>(() => draftOf(preference.sampling));
  // "auto" follows the runtime (and chat when it does not say).
  const [kind, setKind] = useState<ModelKind | "auto">(preference.kind ?? "auto");
  const detectedKind = MODEL_KINDS.find((item) => item.value === (model.kind ?? "chat"))!.label;
  const [details, setDetails] = useState<RuntimeModelDetails | null>(null);
  const [loading, setLoading] = useState(Boolean(window.enduranceModels));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = Object.values(statuses).some((status) => status === "streaming");
  useEffect(() => {
    if (!window.enduranceModels) return;
    let cancelled = false;
    window.enduranceModels
      .details({ connectionId: connection.id }, modelId)
      .then((value) => {
        if (cancelled) return;
        setDetails(value);
        // What the runtime reports the loaded model uses here makes later estimates for it follow this machine.
        if (value.loaded && value.loadedContext && value.memory)
          recordReportedMemory(connection, modelId, { context: value.loadedContext, bytes: value.memory.total });
        setContext(contextSetting(windowStore(runtime), value, preferencesFor(connection, modelId).contextLimit));
      })
      .catch(() => {
        if (!cancelled) setDetails(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, modelId, runtime]);
  const store = windowStore(runtime);
  // A fixed-window server's window bounds the cap; elsewhere the model's maximum bounds the setting.
  const served = store === "cap" ? (details?.context ?? details?.maxContext) : undefined;
  const maximum = store === "cap" ? served : (details?.maxContext ?? model.maxContext ?? 131072);
  const presets = [...new Set([...CONTEXT_PRESETS.filter((value) => !maximum || (store === "cap" ? value < maximum : value <= maximum)), ...(context ? [context] : [])])].sort((a, b) => a - b);
  const setting = details ? contextSetting(store, details, preference.contextLimit) : undefined;
  // Ollama's setting cannot be taken back to its default from here; a cap can, back to the server's window.
  const contextChanged = context !== setting && (store === "cap" || context !== undefined);
  const editable = store === "cap" ? Boolean(served) : Boolean(details?.canSetContext);
  // Ollama and LM Studio report capabilities; others leave them to the person.
  const reported = Boolean(model.capabilitiesReported || details?.capabilities.length);
  const canThink =
    details?.capabilities.includes("thinking") || model.capabilities.includes("reasoning");
  const vision = reported ? Boolean(details?.capabilities.includes("vision") || model.capabilities.includes("vision")) : visionSet;
  // Ollama and LM Studio describe their models, so missing capabilities there mean this model's lookup failed.
  const capabilitySource =
    runtime === "ollama" || runtime === "lmstudio"
      ? `${runtimeName(runtime)} didn't return capabilities for this model`
      : `${runtimeName(runtime)} doesn't expose model capabilities`;
  // Template runtimes pass the switch to the model's chat template; the person can name the variable it reads.
  const showSwitch = switchesByTemplate(runtime) && (reported ? Boolean(canThink) : reasoningSet);
  const thinks = Boolean(reported ? canThink : reasoningSet);
  const badSampling = invalidFields(sampling).length > 0;
  const save = async () => {
    if (!displayName.trim() || (contextChanged && !editable) || badSampling) return;
    setBusy(true);
    setError("");
    try {
      if (contextChanged && store !== "cap" && context !== undefined) {
        // Reloading LM Studio's instance would cut off a reply it is writing; Ollama keeps a running reply and
        // loads the new window with the next request.
        if (store === "load" && running) throw new Error("Stop active generations before changing the context length.");
        if (!window.enduranceModels) throw new Error("Runtime management is unavailable.");
        if (store === "runtime" || details?.loaded) await window.enduranceModels.mutate(target, modelId, "context", context);
      }
      savePreferences(connection, modelId, {
        ...preference,
        displayName: displayName.trim() === model.name ? undefined : displayName,
        thinking: reported ? (canThink ? thinking : preference.thinking) : undefined,
        vision: reported ? undefined : visionSet,
        reasoning: reported ? undefined : reasoningSet,
        thinkingSwitch: showSwitch ? thinkingSwitch : preference.thinkingSwitch,
        // Sent with every request for this model from now on; nothing is restarted.
        sampling: setsOf(sampling, thinks),
        kind: kind === "auto" ? undefined : kind,
        // Ollama's setting lives in its Modelfile; a limit saved here would only disagree with it.
        contextLimit: store === "runtime" ? undefined : contextChanged ? context : preference.contextLimit,
      });
      refreshModels();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? ipcMessage(cause) : "Could not save model settings.");
      // A native reload may unload successfully before its load fails. Reconcile the actual state.
      if (contextChanged && window.enduranceModels) {
        try {
          setDetails(await window.enduranceModels.details(target, modelId));
        } catch {
          /* Keep the original operation error. */
        }
        refreshModels();
      }
    } finally {
      setBusy(false);
    }
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = async () => {
    if (!window.enduranceModels || running) return;
    setBusy(true);
    setError("");
    try {
      await window.enduranceModels.mutate(target, modelId, "delete");
      // The name and picker settings belonged to files that no longer exist.
      savePreferences(connection, modelId, {});
      refreshModels();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? ipcMessage(cause) : "Could not delete the model.");
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };
  // What the chosen window would take, where that can be told, against this computer's memory.
  const reportedMemory = preferencesFor(connection, modelId).reportedMemory;
  const estimate = details && store !== "cap" ? estimateLabel(details, context, reportedMemory) : undefined;
  const memory = details?.hostMemory;
  const overMemory = Boolean(estimate && memory && estimate.bytes > memory);
  const defaultLabel =
    store === "cap"
      ? served ? `Server maximum · ${contextLabel(served)}` : "Server maximum"
      : store === "runtime"
        ? model.runtimeDefaultContext ? `${runtimeName(runtime)} default · ${contextLabel(Math.min(model.runtimeDefaultContext, maximum ?? Infinity))}` : `${runtimeName(runtime)} default`
        : "Runtime default";
  const contextHint = loading
    ? "Checking runtime…"
    : !editable
      ? store === "cap" ? "The server does not report its window" : "Not editable through this runtime"
      : store === "cap"
        ? `Up to the ${contextLabel(served!)} the server runs with`
        : context === undefined && store === "runtime"
          ? `${runtimeName(runtime)} sets the context size when it loads the model${details?.maxContext ? `, up to ${contextLabel(details.maxContext)}` : ""}`
          : details?.maxContext
            ? `Up to ${contextLabel(details.maxContext)} tokens`
            : undefined;
  return (
    <form
      className="space-y-4 px-3 pt-1 pb-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="Display name" wide>
        <Input
          aria-label={`Display name for ${modelId}`}
          autoFocus
          className="h-7 rounded-[6px] text-[13px]"
          disabled={busy}
          maxLength={160}
          onChange={(event) => setDisplayName(event.target.value)}
          value={displayName}
        />
      </Field>
      <Field hint={contextHint} label="Context length">
        <Select
          disabled={busy || loading || !editable}
          onValueChange={(value) => {
            // The select reports null when the default item unmounts after a choice.
            if (value === null) return;
            setContext(value === "default" ? undefined : Number(value));
          }}
          value={context === undefined ? "default" : String(context)}
        >
          <SelectTrigger aria-label={`Context length for ${modelId}`} className="h-7 w-full rounded-[6px] text-[13px]" size="sm">
            <SelectValue>{context === undefined ? defaultLabel : contextLabel(context)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(context === undefined || store === "cap") && <SelectItem value="default">{defaultLabel}</SelectItem>}
            {presets.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {contextLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {overMemory && memory && (
        <p className="-mt-2 text-[12px] leading-[1.35] text-amber-700 dark:text-amber-300" role="status">
          About {formatBytes(estimate!.bytes)} at this length, more than this computer’s {formatBytes(memory)}. It may load slowly on the CPU or fail to load.
        </p>
      )}
      {reported ? (
        <Field hint={canThink ? "New chats start with this; change it per chat in the model menu" : "Not supported by this model"} label="Thinking">
          <Switch
            aria-label={`Thinking for ${name}`}
            checked={canThink ? thinking : false}
            disabled={busy || !canThink}
            onCheckedChange={setThinking}
            size="sm"
          />
        </Field>
      ) : (
        <>
          <Field hint={`Set manually · ${capabilitySource}`} label="Image input">
            <Switch aria-label={`Image input for ${name}`} checked={visionSet} disabled={busy} onCheckedChange={setVisionSet} size="sm" />
          </Field>
          <Field hint="Set manually · sends a reasoning effort with each request" label="Thinking">
            <Switch aria-label={`Thinking for ${name}`} checked={reasoningSet} disabled={busy} onCheckedChange={setReasoningSet} size="sm" />
          </Field>
        </>
      )}
      {showSwitch && (
        <Field hint="The chat template variable that turns thinking on and off" label="Thinking switch">
          <Select
            disabled={busy}
            onValueChange={(value) => {
              const choice = THINKING_SWITCH_CHOICES.find((item) => item.value === value);
              if (choice) setThinkingSwitch(choice.value);
            }}
            value={thinkingSwitch}
          >
            <SelectTrigger aria-label={`Thinking switch for ${name}`} className="h-7 w-full rounded-[6px] text-[13px]" size="sm">
              <SelectValue>{THINKING_SWITCH_CHOICES.find((item) => item.value === thinkingSwitch)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {THINKING_SWITCH_CHOICES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field
        hint={
          kind === "other" && preference.kind === "other"
            ? "Set to Not a chat model after it refused a chat request"
            : `Only chat models appear in the model picker. Automatic uses what ${runtimeName(runtime)} reports.`
        }
        label="Model type"
      >
        <Select
          disabled={busy}
          onValueChange={(value) => {
            if (value === null) return;
            setKind(value as ModelKind | "auto");
          }}
          value={kind}
        >
          <SelectTrigger aria-label={`Model type of ${name}`} className="h-7 w-full rounded-[6px] text-[13px]" size="sm">
            <SelectValue>{kind === "auto" ? `Automatic · ${detectedKind}` : MODEL_KINDS.find((item) => item.value === kind)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic · {detectedKind}</SelectItem>
            {MODEL_KINDS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {(kind === "auto" ? (model.kind ?? "chat") : kind) === "chat" && (
        <SamplingFields details={details} disabled={busy} draft={sampling} onChange={setSampling} thinks={thinks} />
      )}
      {details && (
        <p className="text-[12px] leading-[1.35] text-muted-foreground">
          {[details.quantization, vision ? "Text and image input" : "Text input", overMemory ? undefined : estimate?.text].filter(Boolean).join(" · ")}
        </p>
      )}
      {error && (
        <p className="text-[12px] leading-[1.4] text-destructive" role="alert">
          {error}
        </p>
      )}
      {confirmDelete ? (
        <div className="flex items-center justify-between gap-3" key="confirm-delete" role="group" aria-label={`Delete ${name}`}>
          <p className="min-w-0 text-[12px] leading-[1.35] text-muted-foreground">
            Delete {name}? {runtimeName(runtime)} removes the model files from {connection.location === "this-computer" ? "this computer" : connection.host}.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button className="h-7 rounded-[6px] text-[12px]" disabled={busy} onClick={() => setConfirmDelete(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              autoFocus
              className="h-7 rounded-[6px] bg-destructive/15 text-[12px] text-destructive hover:bg-destructive/25 hover:text-destructive dark:not-aria-expanded:hover:bg-destructive/25"
              disabled={busy || running}
              onClick={() => void remove()}
              type="button"
              variant="ghost"
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      ) : (
      <div className="flex items-center justify-between gap-2" key="actions">
        <div className="flex items-center gap-2">
          <button
            className="text-left text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            disabled={busy}
            onClick={() => {
              savePreferences(connection, modelId, { ...preference, displayName: undefined, thinking: undefined, thinkingSwitch: undefined, vision: undefined, reasoning: undefined, sampling: undefined, kind: undefined, visible: true });
              setSampling(draftOf(undefined));
              setKind("auto");
              setDisplayName(model.name);
              setThinking(true);
              setVisionSet(false);
              setReasoningSet(false);
              setThinkingSwitch("auto");
            }}
            type="button"
          >
            Reset
          </button>
          {details?.canDelete && (
            <Button
              className="h-7 rounded-[6px] text-[12px] text-muted-foreground hover:text-destructive"
              disabled={busy || running}
              onClick={() => setConfirmDelete(true)}
              type="button"
              variant="ghost"
            >
              Delete
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button className="h-7 rounded-[6px] text-[12px]" disabled={busy} onClick={() => onClose()} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            className="h-7 rounded-[6px] text-[12px]"
            disabled={busy || !displayName.trim() || badSampling || (contextChanged && (!editable || (store === "load" && running)))}
            type="submit"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      )}
    </form>
  );
}

function ModelRow({
  model,
  connection,
  open,
  suggestedName,
  onOpenChange,
}: ModelProps & { open: boolean; suggestedName?: string; onOpenChange: (open: boolean) => void }) {
  const modelId = model.runtimeModelId ?? model.name;
  const preference = preferencesFor(connection, modelId);
  const name = preference.displayName ?? model.name;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  return (
    <div ref={row}>
      <div className="flex items-center gap-3 p-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="truncate text-[13px] leading-[1.4]">{name}</div>
          {/* The model as the runtime itself lists it, whatever the runtime; the rest is in its settings. */}
          <div className="truncate text-[12px] leading-[1.35] text-muted-foreground">{modelId}</div>
        </div>
        <Switch
          aria-label={`Show ${name} in model picker`}
          checked={preference.visible !== false}
          onCheckedChange={(visible) => savePreferences(connection, modelId, { ...preference, visible })}
          size="sm"
        />
        <button
          aria-expanded={open}
          aria-label={`${name} settings`}
          className={cn(
            "-m-1 shrink-0 p-1 outline-none hover:text-foreground focus-visible:text-foreground",
            open ? "text-foreground" : "text-muted-foreground"
          )}
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          <SettingsIcon className="size-[15px]" />
        </button>
      </div>
      {open && (
        <ModelEditor
          connection={connection}
          model={model}
          onClose={() => onOpenChange(false)}
          suggestedName={suggestedName}
        />
      )}
    </div>
  );
}

/** The model that reads scanned documents and photos of pages, for every chat. */
function ReadingModel() {
  const choices = readingModels().map(decorateModel);
  const chosen = featureModels().reading;
  const current = choices.find((model) => model.id === chosen);
  return (
    <section className="rounded-[12px] border bg-card p-3">
      <Field hint={current || !chosen ? "Reads pages that are images, such as scanned PDFs. Automatic uses the chat’s model when it takes images" : "The chosen model is no longer available; Automatic is used"} label="Reading scanned documents">
        <Select
          onValueChange={(value) => {
            if (value === null) return;
            saveFeatureModels({ reading: value === "auto" ? undefined : value });
          }}
          value={current ? current.id : "auto"}
        >
          <SelectTrigger aria-label="Model for reading scanned documents" className="h-7 w-full rounded-[6px] text-[13px]" size="sm">
            <SelectValue>{current ? current.name : "Automatic"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic</SelectItem>
            {choices.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                <span className="truncate">{model.name}</span>
                <span className="text-[12px] leading-[1.35] text-muted-foreground">{model.providerLabel}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </section>
  );
}

export function ModelsSettings() {
  const { runtimeCatalog, connections, setSettingsSection } = useStore();
  usePreferenceRevision();
  const [editing, setEditing] = useState<string | null>(null);
  // Set when a download finishes, wherever it was started from.
  const installed = useInstallFocus();
  // In catalog order: this computer, then the person's network, then remote servers.
  const connected = runtimeCatalog
    .filter((result) => !result.error)
    .flatMap((result) => {
      const connection = connections.find((item) => item.id === result.connectionId);
      return connection ? [{ connection, models: result.models }] : [];
    });

  // A vLLM server marked as the person's own may be the Endurance manager (server/), which runs its models from here.
  const [managers, setManagers] = useState<Record<string, ManagerInfo | null>>({});
  const owned = connected.filter(({ connection }) => connection.kind === "vllm" && connection.mine).map(({ connection }) => connection.id);
  useEffect(() => {
    let cancelled = false;
    for (const id of owned)
      void window.enduranceModels?.manager
        .info({ connectionId: id })
        .catch(() => undefined)
        .then((info) => !cancelled && setManagers((current) => (current[id] === (info ?? null) ? current : { ...current, [id]: info ?? null })));
    return () => {
      cancelled = true;
    };
  }, [owned.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  // A finished download opens its settings so it can be named and sized right away.
  useEffect(() => {
    if (!installed) return;
    const connection = connections.find((item) => item.id === installed.connectionId);
    const models = runtimeCatalog.find((item) => item.connectionId === installed.connectionId)?.models ?? [];
    const match = models.find((model) => (model.runtimeModelId ?? "").toLowerCase() === installed.model.toLowerCase());
    if (!match || !connection) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditing(connectionKey(connection, match.runtimeModelId ?? match.name));
  }, [installed, runtimeCatalog, connections]);

  return (
    <PageScroll>
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <h1 className="mb-6 pl-2 font-medium text-[15px] leading-[1.6]">Models</h1>
        {connected.length === 0 ? (
          <section className="flex items-center gap-6 rounded-[12px] border bg-card p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-[13px] leading-[1.4]">No runtime connected</div>
              <div className="text-[12px] leading-[1.35] text-muted-foreground">Connect Ollama to download and run models on this Mac.</div>
            </div>
            <Button className="h-7 shrink-0 rounded-[6px] px-2.5 text-[12px]" onClick={() => setSettingsSection("connections")} variant="secondary">
              Connections
            </Button>
          </section>
        ) : (
          <div className="flex flex-col gap-7">
            <ReadingModel />
            {connected.map(({ connection, models }) => {
              const managed = managers[connection.id];
              if (managed) return <ManagedServer connection={connection} info={managed} key={connection.id} />;
              return (
                // The runtime names its models' group; its address and refresh are in Connections.
                <section aria-label={`${connection.label} models`} key={connection.id}>
                  <RuntimeTitle label={connection.label} />
                  <div className="divide-y overflow-hidden rounded-[12px] border bg-card">
                  {models.map((model) => {
                    const id = connectionKey(connection, model.runtimeModelId ?? model.name);
                    return (
                      <ModelRow
                        connection={connection}
                        key={id}
                        model={model}
                        onOpenChange={(open) => {
                          setEditing(open ? id : null);
                          if (!open) clearInstallFocus();
                        }}
                        open={editing === id}
                        suggestedName={installed && installed.connectionId === connection.id && installed.model.toLowerCase() === (model.runtimeModelId ?? "").toLowerCase() ? installed.name : undefined}
                      />
                    );
                  })}
                  {models.length === 0 && <p className="p-3 text-[12px] leading-[1.35] text-muted-foreground">No models yet. Download one below.</p>}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {connected.length > 0 && (
          <HuggingFaceSettings />
        )}
      </div>
    </PageScroll>
  );
}
