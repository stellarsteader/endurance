import { useCallback, useEffect, useState } from "react";
import { SettingsIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { ConnectionView } from "../../lib/connections";
import { formatContext, MODEL_KINDS, type ModelKind } from "../../lib/models";
import type { SamplingField } from "../../lib/sampling";
import { ipcMessage } from "../../lib/desktop";
import { useStore } from "../../lib/store";
import { cn } from "../../lib/utils";
import { formatBytes } from "./download-progress";
import { preferencesFor, savePreferences } from "./preferences";
import { draftOf, invalidFields, SamplingFields, setsOf } from "./sampling-fields";
import { RuntimeTitle } from "./runtime-title";
import type { ManagedModel, ManagerDownload, ManagerInfo, ManagerPlan } from "./manager-client";

const WINDOWS = [8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
const STATUS = { ready: "Ready", starting: "Starting…", stopped: "Stopped" } as const;
const manager = () => window.enduranceModels!.manager;

/** The editor for one model on a managed server: its window and image apply by restarting it there. */
function ManagedEditor({ connection, model, info, onDone }: { connection: ConnectionView; model: ManagedModel; info: ManagerInfo; onDone: () => void }) {
  const { statuses } = useStore();
  const target = { connectionId: connection.id };
  const preference = preferencesFor(connection, model.id);
  const running = model.status !== "stopped";
  const current = model.status === "stopped" ? (model.saved.window ?? undefined) : model.window;
  const [displayName, setDisplayName] = useState(preference.displayName ?? model.id);
  // Unset is the most the model takes that fits beside the running models.
  const [window, setWindow] = useState<number | undefined>(model.saved.window ?? undefined);
  const [image, setImage] = useState(model.saved.image ?? "");
  const [kind, setKind] = useState<ModelKind | "auto">(preference.kind ?? "auto");
  const [sampling, setSampling] = useState(() => draftOf(preference.sampling));
  const [plan, setPlan] = useState<ManagerPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generating = Object.values(statuses).some((status) => status === "streaming");
  const restart = window !== (model.saved.window ?? undefined) || image.trim() !== (model.saved.image ?? "");
  // What the chosen window would take beside the running models, asked before anything restarts.
  useEffect(() => {
    let cancelled = false;
    manager()
      .plan(target, model.id, window)
      .then((value) => !cancelled && setPlan(value))
      .catch(() => !cancelled && setPlan(undefined));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, model.id, window]);
  const longest = model.maxWindow ?? 131072;
  // The longest window is a choice of its own, even when it falls between presets (128,000).
  const presets = [...new Set([...WINDOWS.filter((value) => value <= longest), longest, ...(window ? [window] : [])])].sort((a, b) => a - b);
  const autoLabel = plan && window === undefined ? `Most that fits · ${formatContext(plan.window)}` : "Most that fits";
  const save = async () => {
    if (invalidFields(sampling).length) return;
    setBusy(true);
    setError("");
    try {
      savePreferences(connection, model.id, {
        ...preference,
        displayName: displayName.trim() && displayName.trim() !== model.id ? displayName : undefined,
        kind: kind === "auto" ? undefined : kind,
        sampling: setsOf(sampling, true),
      });
      if (restart || !running) await manager().start(target, model.id, { ...(window ? { window } : {}), ...(image.trim() ? { image: image.trim() } : {}) });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? ipcMessage(cause) : "Could not apply the settings.");
    } finally {
      setBusy(false);
    }
  };
  const field = "flex items-center gap-6";
  return (
    <div className="space-y-4 px-3 pt-1 pb-3">
      <div className={field}>
        <div className="shrink-0 text-[13px]">Display name</div>
        <Input aria-label={`Display name for ${model.id}`} className="h-7 flex-1 rounded-[6px] text-[13px]" disabled={busy} onChange={(event) => setDisplayName(event.target.value)} value={displayName} />
      </div>
      <div className={field}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[1.4]">Context length</div>
          <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">
            {plan ? (plan.fits ? `About ${formatBytes(plan.needBytes)} of the GPU (${Math.round(plan.share * 100)}%)` : plan.message) : "Checking the server…"}
          </div>
        </div>
        <Select disabled={busy} onValueChange={(value) => value !== null && setWindow(value === "auto" ? undefined : Number(value))} value={window === undefined ? "auto" : String(window)}>
          <SelectTrigger aria-label={`Context length for ${model.id}`} className="h-7 w-52 rounded-[6px] text-[13px]" size="sm">
            <SelectValue>{window === undefined ? autoLabel : formatContext(window)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{autoLabel}</SelectItem>
            {presets.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {formatContext(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {plan && !plan.fits && plan.largestWindow && (
        <p className="-mt-2 flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
          <span>Fits now: up to {formatContext(plan.largestWindow)}</span>
          <button className="text-foreground/85 outline-none hover:text-foreground focus-visible:underline" onClick={() => setWindow(plan.largestWindow)} type="button">
            Use {formatContext(plan.largestWindow)}
          </button>
        </p>
      )}
      <div className={field}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[1.4]">vLLM image</div>
          <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">Empty uses the server’s</div>
        </div>
        <Input aria-label={`vLLM image for ${model.id}`} className="h-7 w-52 rounded-[6px] font-mono text-[12px]" disabled={busy} onChange={(event) => setImage(event.target.value)} placeholder={info.image} value={image} />
      </div>
      <div className={field}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[1.4]">Model type</div>
          <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">Only chat models appear in the model picker</div>
        </div>
        <Select disabled={busy} onValueChange={(value) => value !== null && setKind(value as ModelKind | "auto")} value={kind}>
          <SelectTrigger aria-label={`Model type of ${model.id}`} className="h-7 w-52 rounded-[6px] text-[13px]" size="sm">
            <SelectValue>{kind === "auto" ? `Automatic · ${MODEL_KINDS.find((item) => item.value === model.kind)?.label}` : MODEL_KINDS.find((item) => item.value === kind)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic · {MODEL_KINDS.find((item) => item.value === model.kind)?.label}</SelectItem>
            {MODEL_KINDS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {(kind === "auto" ? model.kind : kind) === "chat" && (
        <SamplingFields
          details={{ modelId: model.id, capabilities: [], canSetContext: false, sampling: { values: model.sampling, own: Object.keys(model.sampling) as SamplingField[] } }}
          disabled={busy}
          draft={sampling}
          onChange={setSampling}
          thinks
        />
      )}
      {error && (
        <p className="text-[12px] leading-[1.4] text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button className="h-7 rounded-[6px] text-[12px]" disabled={busy} onClick={onDone} type="button" variant="ghost">
          Cancel
        </Button>
        <Button className="h-7 rounded-[6px] text-[12px]" disabled={busy || invalidFields(sampling).length > 0 || (restart && running && generating) || (plan !== undefined && !plan.fits && (restart || !running))} onClick={() => void save()} type="button">
          {busy ? "Applying…" : restart && running ? "Save and restart" : running ? "Save" : "Save and start"}
        </Button>
      </div>
      {restart && running && <p className="text-right text-[12px] text-muted-foreground">{current ? `It runs at ${formatContext(current)} now. ` : ""}Restarting takes a few minutes; chats on it wait.</p>}
    </div>
  );
}

/** A vLLM connection that is the Endurance manager (server/): its models, started and stopped from here. */
export function ManagedServer({ connection, info }: { connection: ConnectionView; info: ManagerInfo }) {
  const { refreshModels } = useStore();
  const target = { connectionId: connection.id };
  const [models, setModels] = useState<ManagedModel[]>([]);
  const [downloads, setDownloads] = useState<ManagerDownload[]>([]);
  const [editing, setEditing] = useState<string>();
  const [logs, setLogs] = useState<{ id: string; text: string }>();
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState<{ set: boolean; editing: boolean; value: string }>({ set: false, editing: false, value: "" });
  const load = useCallback(async () => {
    try {
      const [listed, active] = await Promise.all([manager().models(target), manager().downloads(target)]);
      setModels(listed);
      setDownloads(active);
    } catch (cause) {
      setError(cause instanceof Error ? ipcMessage(cause) : "The manager did not answer.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);
  useEffect(() => {
    // load() sets state only after the manager answers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    void window.enduranceModels?.hfToken.status().then((value) => setToken((current) => ({ ...current, set: value.set })));
  }, [load]);
  // While a model starts or a download runs, the list follows it.
  const moving = models.some((model) => model.status === "starting") || downloads.some((item) => item.state === "downloading");
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => {
      void load();
      refreshModels();
    }, 3000);
    return () => clearInterval(timer);
  }, [moving, load, refreshModels]);
  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    try {
      await work();
      await load();
      refreshModels();
    } catch (cause) {
      setError(cause instanceof Error ? ipcMessage(cause) : "The manager refused.");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section aria-label={`${connection.label} models`}>
      <RuntimeTitle label={connection.label} />
      <div className="divide-y overflow-hidden rounded-[12px] border bg-card">
      {models.map((model) => {
        const name = preferencesFor(connection, model.id).displayName ?? model.id;
        return (
          <div key={model.id}>
            <div className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 text-[13px] leading-[1.4]">
                  <span className="truncate">{name}</span>
                  <span className={cn("shrink-0 rounded-[5px] px-1.5 text-[11px]", model.status === "ready" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>{STATUS[model.status]}</span>
                </div>
                <div className="truncate text-[12px] leading-[1.35] text-muted-foreground">
                  {model.id}
                </div>
              </div>
              <Button className="h-7 rounded-[6px] px-2.5 text-[12px]" disabled={busy === model.id} onClick={() => void act(model.id, () => (model.status === "stopped" ? manager().start(target, model.id, {}) : manager().stop(target, model.id)))} type="button" variant="secondary">
                {model.status === "stopped" ? "Start" : "Stop"}
              </Button>
              <button aria-expanded={editing === model.id} aria-label={`${name} settings`} className={cn("-m-1 shrink-0 p-1 outline-none hover:text-foreground focus-visible:text-foreground", editing === model.id ? "text-foreground" : "text-muted-foreground")} onClick={() => setEditing(editing === model.id ? undefined : model.id)} type="button">
                <SettingsIcon className="size-[15px]" />
              </button>
            </div>
            {editing === model.id && (
              <>
                <ManagedEditor
                  connection={connection}
                  info={info}
                  model={model}
                  onDone={() => {
                    setEditing(undefined);
                    void load();
                    refreshModels();
                  }}
                />
                <div className="flex items-center justify-between gap-2 px-3 pb-3 text-[12px]">
                  <button className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground" onClick={() => void manager().logs(target, model.id).then((text) => setLogs({ id: model.id, text: text || "No output yet." }))} type="button">
                    Show logs
                  </button>
                  {confirm === model.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground">Delete its files from the server?</span>
                      <Button className="h-7 rounded-[6px] text-[12px]" onClick={() => setConfirm(undefined)} type="button" variant="ghost">
                        Cancel
                      </Button>
                      <Button className="h-7 rounded-[6px] bg-destructive/15 text-[12px] text-destructive hover:bg-destructive/25" onClick={() => void act(model.id, () => manager().remove(target, model.id)).then(() => savePreferences(connection, model.id, {}))} type="button" variant="ghost">
                        Delete
                      </Button>
                    </span>
                  ) : (
                    <button className="text-muted-foreground outline-none hover:text-destructive focus-visible:text-destructive" onClick={() => setConfirm(model.id)} type="button">
                      Delete
                    </button>
                  )}
                </div>
                {logs?.id === model.id && <pre className="mx-3 mb-3 max-h-64 overflow-auto rounded-[8px] bg-muted p-2 font-mono text-[11px] leading-[1.45] whitespace-pre-wrap">{logs.text}</pre>}
              </>
            )}
          </div>
        );
      })}
      {models.length === 0 && <p className="p-3 text-[12px] leading-[1.35] text-muted-foreground">No models on this server yet. Download one below.</p>}
      {downloads.filter((item) => item.state !== "done").map((item) => (
        <div className="space-y-1 p-3 text-[12px]" key={item.id}>
          <div className="flex justify-between gap-3">
            <span className="truncate">{item.id}</span>
            <span className="shrink-0 text-muted-foreground">{item.state === "failed" ? "Failed" : item.totalBytes ? `${formatBytes(item.doneBytes)} of ${formatBytes(item.totalBytes)}` : "Starting…"}</span>
          </div>
          {item.state === "failed" ? <p className="text-destructive">{item.error}</p> : <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground/60" style={{ width: `${item.totalBytes ? Math.round((item.doneBytes / item.totalBytes) * 100) : 0}%` }} /></div>}
        </div>
      ))}
      <form
        className="flex items-center gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const id = repo.trim();
          if (id) void act(`download:${id}`, () => manager().download(target, id)).then(() => setRepo(""));
        }}
      >
        <Input aria-label="Model to download to this server" className="h-7 flex-1 rounded-[6px] font-mono text-[12px]" onChange={(event) => setRepo(event.target.value)} placeholder="owner/name, as on Hugging Face" value={repo} />
        <Button className="h-7 rounded-[6px] px-2.5 text-[12px]" disabled={!repo.trim() || busy?.startsWith("download:")} type="submit" variant="secondary">
          Download
        </Button>
      </form>
      <div className="flex items-center justify-between gap-3 p-3 text-[12px] text-muted-foreground">
        {token.editing ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void window.enduranceModels?.hfToken
                .save(token.value || null)
                .then((value) => setToken({ set: value.set, editing: false, value: "" }))
                .catch((cause: unknown) => setError(cause instanceof Error ? ipcMessage(cause) : "Could not save the token."));
            }}
          >
            <Input aria-label="Hugging Face token" autoFocus className="h-7 flex-1 rounded-[6px] font-mono text-[12px]" onChange={(event) => setToken({ ...token, value: event.target.value })} placeholder="hf_…" type="password" value={token.value} />
            <Button className="h-7 rounded-[6px] text-[12px]" type="submit" variant="secondary">
              {token.value ? "Save" : "Remove"}
            </Button>
          </form>
        ) : (
          <>
            <span>{token.set ? "A Hugging Face token is saved; it goes with downloads and is not kept on the server." : "Gated models need a Hugging Face token."}</span>
            <button className="shrink-0 text-foreground/85 outline-none hover:text-foreground focus-visible:underline" onClick={() => setToken({ ...token, editing: true })} type="button">
              {token.set ? "Change" : "Add token"}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="p-3 text-[12px] leading-[1.4] text-destructive" role="alert">
          {error}
        </p>
      )}
      </div>
    </section>
  );
}
