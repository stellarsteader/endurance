"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ipcMessage } from "@/lib/desktop";
import {
  endpointLabel,
  formatContext,
  getModel,
  modelIdFor,
  normalizeBaseUrl,
  RUNTIMES,
  runtimeName,
  type RuntimeId,
} from "@/lib/models";
import { classifyHost, locationLabel, parseServerInput, plainHttpRefusal, SUPPORTED_RUNTIMES, type ConnectionView, type ParsedServer } from "@/lib/connections";
import { LocationBadge } from "./location-badge";
import { DragCard, DropIndicator, Reorderable, useReorderDrag, useReorderDrop } from "./reorder";
import { moveId, type DropPosition } from "@/lib/ordering";
import type { ServerInfo } from "@/harness/server-info";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { CatalogResult, ProbeReason, RuntimeProbe, ServerCheck } from "@/lib/desktop";
import type { OllamaStatus } from "@/lib/workspace-api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, CopyIcon, LoaderCircleIcon, PlusIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PageScroll } from "./page-scroll";
import { toast } from "sonner";

const OLLAMA_DOWNLOAD = "https://ollama.com/download";
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

type Panel = "settings" | "setup";

interface SetupStep {
  title: string;
  detail?: string;
  command?: string;
  link?: { label: string; url: string };
  /** Opens this row's address settings, for servers that run on another machine. */
  editAddress?: boolean;
}

// Install guidance only: Endurance opens these pages and shows these commands, it never runs them.
// Servers added by address have no install steps: they already run somewhere.
const SETUP: Partial<Record<RuntimeId, { steps: SetupStep[]; docs: string }>> = {
  ollama: {
    docs: "https://docs.ollama.com",
    steps: [
      { title: "Download Ollama", link: { label: "Download", url: OLLAMA_DOWNLOAD } },
      { title: "Open the app", detail: "It keeps running in the background." },
      { title: "Get a model", command: "ollama pull gemma3" },
    ],
  },
  vllm: {
    docs: "https://docs.vllm.ai/en/latest/getting_started/installation/",
    steps: [
      {
        title: "Install on a Linux machine with an NVIDIA GPU",
        detail: IS_MAC ? "On Apple Silicon, follow the vLLM-Metal guide in the docs." : undefined,
        command: "pip install vllm",
      },
      { title: "Start the server", command: "vllm serve Qwen/Qwen2.5-1.5B-Instruct" },
      { title: "Running it on another machine?", editAddress: true },
    ],
  },
  lmstudio: {
    docs: "https://lmstudio.ai/docs/developer",
    steps: [
      { title: "Download LM Studio", link: { label: "Download", url: "https://lmstudio.ai/download" } },
      { title: "Download a model", detail: "Search for one in the app and download it." },
      { title: "Start the server", detail: "Turn it on in the Developer tab, or run:", command: "lms server start" },
    ],
  },
  llamacpp: {
    docs: "https://github.com/ggml-org/llama.cpp#quick-start",
    steps: [
      IS_MAC
        ? { title: "Install with Homebrew", command: "brew install llama.cpp" }
        : { title: "Download a release", link: { label: "Releases", url: "https://github.com/ggml-org/llama.cpp/releases" } },
      { title: "Start the server", detail: "Downloads a small model on first run.", command: "llama-server -hf ggml-org/gemma-3-1b-it-GGUF" },
    ],
  },
  mlx: {
    docs: "https://github.com/ml-explore/mlx-lm#server",
    steps: [
      { title: "Install on a Mac with Apple Silicon", command: "pip install mlx-lm" },
      { title: "Start the server", detail: "Downloads the model on first run.", command: "mlx_lm.server --model mlx-community/Qwen3-4B-4bit" },
    ],
  },
  jan: {
    docs: "https://www.jan.ai/docs/desktop/api-server",
    steps: [
      { title: "Download Jan", link: { label: "Download", url: "https://www.jan.ai/download" } },
      { title: "Start the server", detail: "Settings → Local API Server. Paste the API key you set there into this connection." },
    ],
  },
  gpt4all: {
    docs: "https://docs.gpt4all.io/gpt4all_api_server/home.html",
    steps: [
      { title: "Download GPT4All", link: { label: "Download", url: "https://www.nomic.ai/gpt4all" } },
      { title: "Turn on the server", detail: "Settings → Application → Advanced → Enable Local API Server." },
    ],
  },
  koboldcpp: {
    docs: "https://github.com/LostRuins/koboldcpp/wiki",
    steps: [
      { title: "Download KoboldCpp", link: { label: "Releases", url: "https://github.com/LostRuins/koboldcpp/releases" } },
      { title: "Start it with a GGUF model", command: "./koboldcpp --model model.gguf" },
    ],
  },
  textgen: {
    docs: "https://github.com/oobabooga/text-generation-webui/wiki/12-%E2%80%90-OpenAI-API",
    steps: [
      { title: "Download text-generation-webui", link: { label: "GitHub", url: "https://github.com/oobabooga/text-generation-webui" } },
      {
        title: "Start it with the API turned on",
        detail: IS_MAC ? "AirPlay Receiver also uses port 5000. Turn it off in System Settings → General → AirDrop & Handoff." : undefined,
        command: IS_MAC ? "./start_macos.sh --api" : "./start_linux.sh --api",
      },
    ],
  },
  localai: {
    docs: "https://localai.io/basics/getting_started/",
    steps: [
      { title: "Start LocalAI", command: "docker run -p 8080:8080 --name local-ai -ti localai/localai:latest" },
      { title: "Install a model", detail: "From its web page at localhost:8080." },
    ],
  },
  docker: {
    docs: "https://docs.docker.com/ai/model-runner/",
    steps: [
      { title: "Download Docker Desktop", link: { label: "Download", url: "https://www.docker.com/products/docker-desktop/" } },
      { title: "Turn on host access", command: "docker desktop enable model-runner --tcp 12434" },
      { title: "Get a model", command: "docker model pull ai/smollm2" },
    ],
  },
  sglang: {
    docs: "https://docs.sglang.ai/get_started/install.html",
    steps: [
      { title: "Install on a Linux machine with an NVIDIA GPU", command: "pip install sglang" },
      { title: "Start the server", command: "python -m sglang.launch_server --model-path Qwen/Qwen2.5-1.5B-Instruct" },
      { title: "Running it on another machine?", editAddress: true },
    ],
  },
  tgi: {
    docs: "https://huggingface.co/docs/text-generation-inference/quicktour",
    steps: [
      {
        title: "Start it on a Linux machine with an NVIDIA GPU",
        command: "docker run --gpus all -p 8080:80 ghcr.io/huggingface/text-generation-inference --model-id Qwen/Qwen2.5-1.5B-Instruct",
      },
      { title: "Running it on another machine?", editAddress: true },
    ],
  },
};

function openExternal(url: string) {
  window.open(url, "_blank", "noopener");
}

/** One short phrase for why a runtime did not answer. */
function reasonText(reason: ProbeReason | undefined, hasKey: boolean, status?: number, detected?: RuntimeProbe["detected"]) {
  switch (reason) {
    case "other":
      if (detected === "airplay") return "AirPlay Receiver is using this port";
      return detected ? `${runtimeName(detected)} is at this address` : "Another server is at this address";
    case "refused":
      return "Not running";
    case "host":
      return "Host not found";
    case "timeout":
      return "Not responding";
    case "auth":
      return hasKey ? "API key rejected" : "Needs an API key";
    case "not-api":
      return "Unexpected response";
    case "tls":
      return "Certificate not trusted";
    case "starting":
      return "Starting";
    case "address":
      return "Invalid address";
    case "insecure":
      return "Needs an https:// address";
    default:
      return status ? `Unavailable · HTTP ${status}` : "Unavailable";
  }
}

/** "3 min ago", "2 h ago", "4 days ago". */
function ago(at: number) {
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function statusLine(result: CatalogResult | undefined, ollama: OllamaStatus | null | undefined, hasKey: boolean, lastConnectedAt?: number) {
  if (!result) return "Checking…";
  if (result.state === "starting") return "Starting · checks again on its own";
  if (result.state === "ended") return lastConnectedAt ? `Ended · last connected ${ago(lastConnectedAt)}` : "Ended";
  if (!result.error) {
    const models = result.models.length ? `${result.models.length} ${result.models.length === 1 ? "model" : "models"}` : "No models yet";
    return ["Connected", ollama?.version && `v${ollama.version}`, models].filter(Boolean).join(" · ");
  }
  // On this Mac, Ollama's install state tells more than the refused connection does.
  if (ollama && !ollama.running && result.reason === "refused") return ollama.installed ? "Not running" : "Not installed";
  return reasonText(result.reason, hasKey, undefined, result.detected);
}

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** What a successful test reports, in the order people check: speed, version, models, what is in memory. */
function probeText(connectionId: string, probe: RuntimeProbe) {
  const loaded = probe.loaded ?? [];
  const memory = loaded.reduce((total, item) => total + (item.bytes ?? 0), 0);
  // The display name from Models settings, else the model ID without its Hugging Face owner path.
  const first = loaded[0] ? getModel(modelIdFor(connectionId, loaded[0].name)).name.replace(/^hf\.co\/[^/]+\//, "") : undefined;
  return [
    probe.latencyMs !== undefined ? `${probe.latencyMs} ms` : undefined,
    probe.version ? (/^\d/.test(probe.version) ? `v${probe.version}` : probe.version) : undefined,
    probe.models !== undefined ? `${probe.models} ${probe.models === 1 ? "model" : "models"}` : undefined,
    probe.maxContext ? `${formatContext(probe.maxContext)} context` : undefined,
    probe.loaded ? (loaded.length === 0 ? "None loaded" : loaded.length === 1 ? `${first} loaded` : `${loaded.length} loaded`) : undefined,
    memory ? gigabytes(memory) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function OllamaAction({ status, onStatus }: { status: OllamaStatus; onStatus: (status: OllamaStatus) => void }) {
  const { refreshModels } = useStore();
  const [opening, setOpening] = useState(false);
  if (status.running || !status.installed) return null;
  return (
    <Button
      className="h-7 shrink-0 rounded-[6px] px-2.5 text-[12px]"
      disabled={opening}
      onClick={async () => {
        setOpening(true);
        try {
          onStatus(await window.enduranceWorkspace!.openOllama());
        } finally {
          setOpening(false);
          refreshModels();
        }
      }}
      variant="secondary"
    >
      {opening ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
      {opening ? "Starting…" : "Open Ollama"}
    </Button>
  );
}

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      )}
    >
      <div className="min-h-0 overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  );
}

function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-[8px] border bg-background/60 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] leading-[1.6] [scrollbar-width:none]">
        <span className="select-none text-muted-foreground">$ </span>
        {value}
      </code>
      <button
        aria-label={copied ? "Copied" : `Copy “${value}”`}
        className="shrink-0 rounded-[5px] p-1 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
        onClick={() =>
          (navigator.clipboard?.writeText(value) ?? Promise.reject()).then(
            () => setCopied(true),
            () => toast("Couldn't copy. Select the command and copy it instead.")
          )
        }
        type="button"
      >
        {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
      </button>
    </div>
  );
}

function SetupGuide({ runtimeId, onEditAddress }: { runtimeId: RuntimeId; onEditAddress: () => void }) {
  const guide = SETUP[runtimeId];
  if (!guide) return null;
  const { steps, docs } = guide;
  return (
    <div className="px-3 pt-1 pb-3">
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li className="flex gap-2.5" key={step.title}>
            <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px] text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-h-[18px] items-center justify-between gap-3">
                <span className="text-[12px] leading-[1.4]">{step.title}</span>
                {step.link && (
                  <Button className="h-6 shrink-0 rounded-[6px] px-2 text-[12px]" onClick={() => openExternal(step.link!.url)} size="sm" variant="secondary">
                    {step.link.label}
                    <ArrowUpRightIcon className="size-3" />
                  </Button>
                )}
                {step.editAddress && (
                  <Button className="h-6 shrink-0 rounded-[6px] px-2 text-[12px]" onClick={onEditAddress} size="sm" variant="secondary">
                    Edit address
                  </Button>
                )}
              </div>
              {step.detail && <div className="text-[12px] leading-[1.4] text-muted-foreground">{step.detail}</div>}
              {step.command && <Command value={step.command} />}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-2.5 text-[12px] leading-[1.4] text-muted-foreground">
        <span>Checks again when you return to this window.</span>
        <button className="inline-flex shrink-0 items-center gap-0.5 hover:text-foreground" onClick={() => openExternal(docs)} type="button">
          Docs
          <ArrowUpRightIcon className="size-3" />
        </button>
      </div>
    </div>
  );
}

const CONCURRENCY = [0, 1, 2, 4];
/** Unset, a server takes what it can. Ollama's is measured per model instead (src/harness/ollama-parallel), so it has no row. */
const concurrencyLabel = (value: number) => (value ? String(value) : "Server decides");

/** "Name: value" per line. Returns the headers, or the first line that is not a header. */
function parseHeaders(text: string): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9-]+)\s*:\s*(.+)$/.exec(line);
    if (!match) return { error: `Use “Name: value” on each line.` };
    headers[match[1]] = match[2];
  }
  return { headers };
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-[1.4]">{label}</div>
        {hint && <div className="mt-1 text-[12px] leading-[1.35] text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex w-40 shrink-0 justify-end">{children}</div>
    </div>
  );
}

/** A secondary action at the right of a field label; it keeps its place while hidden. */
function LabelAction({ visible, onClick, children }: { visible: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-hidden={!visible}
      className={cn(
        "text-[12px] leading-[1.35] text-muted-foreground outline-none transition-opacity hover:text-foreground focus-visible:text-foreground",
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
      type="button"
    >
      {children}
    </button>
  );
}

function Dot({ state }: { state: CatalogResult["state"] | "testing-ok" | "testing-bad" | undefined }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "connected" || state === "testing-ok"
          ? "bg-emerald-500"
          : state === "starting"
            ? "animate-pulse bg-amber-500 motion-reduce:animate-none"
            : state === "testing-bad"
              ? "bg-red-500/80"
              : "bg-muted-foreground/40"
      )}
    />
  );
}

/** Removing asks once: a server's saved key and headers go with it and cannot be restored. */
function RemoveConfirm({ label, onCancel, onRemove }: { label: string; onCancel: () => void; onRemove: () => void }) {
  return (
    <div aria-label={`Remove ${label}`} className="flex items-center justify-between gap-3" role="group">
      <p className="min-w-0 text-[12px] leading-[1.35] text-muted-foreground">Remove {label}? Its saved key and headers are deleted.</p>
      <div className="flex shrink-0 items-center gap-2">
        <Button className="h-7 rounded-[6px] text-[12px]" onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          autoFocus
          className="h-7 rounded-[6px] bg-destructive/15 text-[12px] text-destructive hover:bg-destructive/25 hover:text-destructive dark:not-aria-expanded:hover:bg-destructive/25"
          onClick={onRemove}
          type="button"
          variant="ghost"
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

const badge = "inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 font-normal text-[11px] leading-none text-muted-foreground";

/** Whether the person runs the server, which they can change here, and whether the runtime is fully supported. */
function ServerBadges({ connection }: { connection: ConnectionView }) {
  const [saving, setSaving] = useState(false);
  const experimental = !SUPPORTED_RUNTIMES.includes(connection.kind);
  const toggle = () => {
    if (!window.endurance || saving) return;
    setSaving(true);
    window.endurance
      .updateConnection(connection.id, { owner: connection.mine ? "external" : "mine" })
      .catch((error: Error) => toast.error("Couldn't change this server", { description: ipcMessage(error) }))
      .finally(() => setSaving(false));
  };
  return (
    <>
      <LocationBadge location={connection.location} />
      <button
        aria-label={`${connection.label}: ${connection.mine ? "my server" : "external server"}. Change`}
        className={cn(badge, "outline-none transition-colors hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40")}
        disabled={saving || !window.endurance}
        onClick={toggle}
        title={
          connection.mine
            ? "You run this server. Endurance may read its development endpoints for more detail. Click if someone else runs it."
            : "Someone else runs this server. Endurance only uses it and reads its public endpoints. Click if you run it."
        }
        type="button"
      >
        {connection.mine ? "My server" : "External"}
      </button>
      {experimental && (
        <span className={badge} title={`${runtimeName(connection.kind)} works through the shared OpenAI-compatible path. Ollama and vLLM are fully supported.`}>
          Experimental
        </span>
      )}
    </>
  );
}

const percentOf = (value: number) => `${Math.round(value * 100)}%`;

/** A vLLM server's load and cache, read when opened. Hidden until asked for: it rarely changes what to do. */
function ServerDetails({ connection }: { connection: ConnectionView }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ServerInfo | null | undefined>(undefined);
  useEffect(() => {
    if (!open || !window.endurance) return;
    let cancelled = false;
    window.endurance
      .serverInfo(connection.id)
      .then((value) => !cancelled && setInfo(value ?? null))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, [open, connection.id, connection.mine]);
  const rows: [string, string][] = info
    ? [
        ...(info.running !== undefined || info.waiting !== undefined ? [["Requests", `${info.running ?? 0} running · ${info.waiting ?? 0} waiting`] as [string, string]] : []),
        ...(info.kvTokens || info.kvUsage !== undefined
          ? [["KV cache", [info.kvUsage !== undefined ? `${percentOf(info.kvUsage)} in use` : undefined, info.kvTokens ? `holds ${formatContext(info.kvTokens)} tokens` : undefined].filter(Boolean).join(" · ")] as [string, string]]
          : []),
        ...(info.prefixCaching !== undefined ? [["Prefix caching", info.prefixCaching ? "On" : "Off"] as [string, string]] : []),
        ...(info.memoryUtilization !== undefined ? [["GPU memory", `${percentOf(info.memoryUtilization)} reserved`] as [string, string]] : []),
        ...(info.maxNumSeqs ? [["Requests at once", String(info.maxNumSeqs)] as [string, string]] : []),
        ...(info.maxModelLen ? [["Context length", formatContext(info.maxModelLen)] as [string, string]] : []),
      ]
    : [];
  return (
    <div className="px-3 pb-3 -mt-1">
      <button
        aria-expanded={open}
        className="flex items-center gap-1 text-[12px] leading-[1.35] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        Server info
        <ChevronDownIcon className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      <Collapse open={open}>
        <div className="space-y-1 pt-2 text-[12px] leading-[1.35]">
          {info === undefined && <p className="text-muted-foreground">Reading…</p>}
          {info !== undefined && rows.length === 0 && <p className="text-muted-foreground">The server did not report its metrics.</p>}
          {rows.map(([label, value]) => (
            <div className="flex items-baseline justify-between gap-4" key={label}>
              <span className="text-muted-foreground">{label}</span>
              <span className="truncate tabular-nums">{value}</span>
            </div>
          ))}
          {info && connection.mine && info.development === false && (
            <p className="pt-1 text-muted-foreground">
              Start the server with VLLM_SERVER_DEV_MODE=1 to see its scheduler settings. That also turns on development endpoints, so use it only on your own network.
            </p>
          )}
        </div>
      </Collapse>
    </div>
  );
}

function ConnectionRow({
  connection,
  panel,
  onPanelChange,
  ollama,
  onOllama,
  focusName,
}: {
  connection: ConnectionView;
  panel: Panel | null;
  onPanelChange: (panel: Panel | null) => void;
  ollama?: OllamaStatus | null;
  onOllama?: (status: OllamaStatus) => void;
  /** Just added: the name field takes focus so it can be renamed right away. */
  focusName?: boolean;
}) {
  const { runtimeCatalog, refreshModels, removeConnection } = useStore();
  const catalog = runtimeCatalog.find((item) => item.connectionId === connection.id);
  const connected = catalog?.state === "connected";
  const defaults = RUNTIMES.find((item) => item.id === connection.id);
  const saved = connection.secrets;
  const hasSaved = saved.hasKey || saved.headerNames.length > 0 || Boolean(saved.queryNames?.length);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [name, setName] = useState(connection.name ?? "");
  // null keeps the saved secret; a string replaces it; removing clears it on save.
  const [key, setKey] = useState<string | null>(null);
  const [keyRemoved, setKeyRemoved] = useState(false);
  const [headersText, setHeadersText] = useState<string | null>(null);
  const [headersRemoved, setHeadersRemoved] = useState(false);
  const [concurrency, setConcurrency] = useState(connection.concurrency ?? 0);
  const [moveSecrets, setMoveSecrets] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const formId = `runtime-settings-${connection.id}`;
  const setupId = `runtime-setup-${connection.id}`;
  const open = panel === "settings";
  const setupOpen = panel === "setup";
  const onOpenChange = (next: boolean) => onPanelChange(next ? "settings" : null);
  // Ollama that is installed but stopped gets a direct "Open Ollama" instead of install steps.
  const canStartOllama = connection.id === "ollama" && Boolean(ollama?.installed && !ollama.running);
  const showSetup = connection.builtin && Boolean(SETUP[connection.kind]) && Boolean(catalog) && !connected && catalog?.state !== "starting" && !canStartOllama;
  const parsed = headersText === null ? null : parseHeaders(headersText);
  const headersError = parsed && "error" in parsed ? parsed.error : "";
  const address = normalizeBaseUrl(baseUrl, defaults?.baseUrl || connection.baseUrl);
  // The main process refuses these too; checking here shows why before Test or Save is tried.
  const addressRefusal = plainHttpRefusal(address);
  const savedRefusal = plainHttpRefusal(connection.baseUrl);
  // Saved secrets are bound to the saved address; a new address gets them only when the person says so.
  const addressChanged = address.replace(/\/+$/, "") !== connection.baseUrl.replace(/\/+$/, "");
  const secretsUsable = hasSaved && (!saved.elsewhere || moveSecrets) && (!addressChanged || moveSecrets);
  const keyFor = () => (key !== null ? key.trim() : keyRemoved ? "" : null);
  const headersFor = () => (parsed && "headers" in parsed ? parsed.headers : headersRemoved ? {} : null);
  const hasKeyNow = key !== null ? Boolean(key.trim()) : saved.hasKey && !keyRemoved && secretsUsable;

  const [probe, setProbe] = useState<RuntimeProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const testRun = useRef(0);
  // A result describes the values it tested; editing them makes it stale.
  const edit = (update: () => void) => {
    update();
    testRun.current++;
    setProbe(null);
    setTesting(false);
    setSaveError("");
  };
  const test = async () => {
    if (!window.endurance || headersError || addressRefusal) return;
    const run = ++testRun.current;
    setTesting(true);
    setProbe(null);
    try {
      const value = await window.endurance.testConnection(connection.id, { baseUrl: address, apiKey: keyFor(), headers: headersFor(), moveSecrets });
      if (run === testRun.current) setProbe(value);
    } catch {
      if (run === testRun.current) setProbe({ ok: false, reason: "error" });
    } finally {
      if (run === testRun.current) setTesting(false);
    }
  };
  const result = probe ? (probe.ok ? probeText(connection.id, probe) : reasonText(probe.reason, hasKeyNow, probe.status, probe.detected)) : "";

  useEffect(() => {
    if (open) firstFieldRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Once the runtime answers, the install steps have done their job.
  useEffect(() => {
    if (connected && setupOpen) onPanelChange(null);
  }, [connected, setupOpen, onPanelChange]);

  const reset = () =>
    edit(() => {
      setBaseUrl(connection.baseUrl);
      setName(connection.name ?? "");
      setKey(null);
      setKeyRemoved(false);
      setHeadersText(null);
      setHeadersRemoved(false);
      setConcurrency(connection.concurrency ?? 0);
      setMoveSecrets(false);
      setConfirmRemove(false);
      setAdvanced(Boolean(saved.headerNames.length || connection.concurrency));
    });

  // A row opened from outside (just added) starts from the saved values.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (open && openedFor.current !== connection.id) {
      openedFor.current = connection.id;
      reset();
    }
    if (!open) openedFor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection.id]);

  const toggle = () => onOpenChange(!open);

  const save = async () => {
    if (headersError || addressRefusal || saving || !window.endurance) return;
    setSaving(true);
    try {
      const apiKey = keyFor();
      const headers = headersFor();
      await window.endurance.updateConnection(connection.id, {
        baseUrl: address,
        ...(connection.builtin ? {} : { name }),
        concurrency: concurrency || undefined,
        apiKey: apiKey === null ? { keep: true } : apiKey ? { replace: apiKey } : { remove: true },
        headers: headers === null ? { keep: true } : Object.keys(headers).length ? { replace: headers } : { remove: true },
        moveSecrets: (addressChanged || Boolean(saved.elsewhere)) && moveSecrets,
      });
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? ipcMessage(error) : "Couldn't save this connection.");
    } finally {
      setSaving(false);
    }
  };

  // A refused address is never checked, so its row says why from the first render.
  const status = savedRefusal ? reasonText("insecure", false) : statusLine(catalog, connection.id === "ollama" ? ollama : undefined, saved.hasKey, connection.lastConnectedAt);
  // Dragged by its heading; a row being edited stays put.
  const editing = open || setupOpen;
  const { setNode: setDrag, handle, dragging } = useReorderDrag({ kind: "server", id: connection.id, data: null }, editing);
  const { setNode: setDrop, placement } = useReorderDrop({ kind: "server", id: connection.id, data: null, accepts: ["server"] });
  return (
    <div className={cn("relative", dragging && "opacity-40")} ref={setDrop}>
      <DropIndicator placement={placement} />
      <div className="flex items-center gap-6 p-3" ref={setDrag} {...handle}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-[13px] leading-[1.4]">
            <span className="truncate">{connection.label}</span>
            <ServerBadges connection={connection} />
          </div>
          <div className="truncate font-mono text-[12px] leading-[1.35] text-muted-foreground">{endpointLabel(connection.baseUrl)}</div>
          <div className="flex items-center gap-1.5 text-[12px] leading-[1.35] text-muted-foreground">
            <Dot state={savedRefusal ? "unavailable" : catalog?.state} />
            <span className="truncate">{status}</span>
          </div>
          {savedRefusal && !open && <p className="text-[12px] leading-[1.35] text-destructive">{savedRefusal}</p>}
        </div>
        {connection.id === "ollama" && ollama && !connected && onOllama && <OllamaAction onStatus={onOllama} status={ollama} />}
        {showSetup && (
          <Button
            aria-controls={setupId}
            aria-expanded={setupOpen}
            className="h-7 shrink-0 gap-1 rounded-[6px] pr-2 pl-2.5 text-[12px]"
            onClick={() => onPanelChange(setupOpen ? null : "setup")}
            variant="secondary"
          >
            Set up
            <ChevronDownIcon className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", setupOpen && "rotate-180")} />
          </Button>
        )}
        {window.endurance && (
          <button
            aria-label={catalog?.state === "starting" ? `Check ${connection.label} now` : `Refresh ${connection.label} models`}
            className="-m-1 shrink-0 p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            onClick={() => refreshModels(connection.id)}
            type="button"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        )}
        <button
          aria-controls={formId}
          aria-expanded={open}
          aria-label={`${connection.label} settings`}
          className={cn(
            "-m-1 shrink-0 p-1 outline-none transition-colors hover:text-foreground focus-visible:text-foreground",
            open ? "text-foreground" : "text-muted-foreground"
          )}
          onClick={toggle}
          type="button"
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </div>
      {connection.kind === "vllm" && connected && <ServerDetails connection={connection} />}
      {connection.builtin && (
        <Collapse open={setupOpen}>
          <div id={setupId}>
            <SetupGuide onEditAddress={() => onPanelChange("settings")} runtimeId={connection.kind} />
          </div>
        </Collapse>
      )}
      <Collapse open={open}>
        <form
          className="space-y-4 px-3 pt-1 pb-3"
          id={formId}
          onKeyDown={(event) => {
            if (event.key === "Escape") onOpenChange(false);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {!connection.builtin && (
            <div className="space-y-1.5">
              <label className="text-[12px] leading-[1.35] text-muted-foreground" htmlFor={`${formId}-name`}>
                Name
              </label>
              <Input
                autoFocus={focusName}
                className="text-[13px]"
                id={`${formId}-name`}
                maxLength={80}
                onChange={(event) => edit(() => setName(event.target.value))}
                placeholder={connection.host}
                ref={firstFieldRef}
                value={name}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[12px] leading-[1.35] text-muted-foreground" htmlFor={`${formId}-address`}>
                API address
              </label>
              {defaults?.baseUrl && (
                <LabelAction onClick={() => edit(() => setBaseUrl(defaults.baseUrl))} visible={baseUrl !== defaults.baseUrl}>
                  Reset to default
                </LabelAction>
              )}
            </div>
            <Input
              aria-describedby={addressRefusal ? `${formId}-address-error` : undefined}
              aria-invalid={Boolean(addressRefusal)}
              autoCapitalize="off"
              className="font-mono text-[13px]"
              id={`${formId}-address`}
              onChange={(event) => edit(() => setBaseUrl(event.target.value))}
              ref={connection.builtin ? firstFieldRef : undefined}
              spellCheck={false}
              value={baseUrl}
            />
            {addressRefusal && (
              <p className="!mt-1 text-[12px] leading-[1.35] text-destructive" id={`${formId}-address-error`}>
                {addressRefusal}
              </p>
            )}
            {hasSaved && (addressChanged || saved.elsewhere) && (
              <label className="!mt-2 flex items-start gap-2 text-[12px] leading-[1.35] text-muted-foreground">
                <input
                  checked={moveSecrets}
                  className="mt-[2px] accent-foreground"
                  onChange={(event) => edit(() => setMoveSecrets(event.target.checked))}
                  type="checkbox"
                />
                <span>
                  Send the saved key and headers to {addressChanged ? "the new address" : "this address"}. They were saved for{" "}
                  {saved.elsewhere ? "a previous address" : endpointLabel(connection.baseUrl)}.
                </span>
              </label>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[12px] leading-[1.35] text-muted-foreground" htmlFor={`${formId}-key`}>
                API key
              </label>
              <LabelAction onClick={() => edit(() => setKeyRemoved((value) => !value))} visible={saved.hasKey && key === null}>
                {keyRemoved ? "Undo" : "Remove"}
              </LabelAction>
            </div>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              className="font-mono text-[13px]"
              id={`${formId}-key`}
              onChange={(event) => edit(() => setKey(event.target.value || null))}
              placeholder={saved.hasKey && !keyRemoved ? (secretsUsable ? "Saved in Keychain" : "Saved for another address") : "Leave empty unless the server asks for one"}
              spellCheck={false}
              type="password"
              value={key ?? ""}
            />
          </div>
          {window.endurance && (
            <div>
              <div className="flex items-center justify-between">
                <button
                  aria-expanded={advanced}
                  className="flex items-center gap-1 text-[12px] leading-[1.35] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                  onClick={() => setAdvanced((value) => !value)}
                  type="button"
                >
                  Advanced
                  <ChevronDownIcon className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", advanced && "rotate-180")} />
                </button>
                {!connection.primary && (
                  <LabelAction onClick={() => setConfirmRemove(true)} visible={!confirmRemove}>
                    Remove from list
                  </LabelAction>
                )}
              </div>
              <Collapse open={advanced}>
                <div className="space-y-4 pt-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[12px] leading-[1.35] text-muted-foreground" htmlFor={`${formId}-headers`}>
                        Extra headers
                      </label>
                      <LabelAction
                        onClick={() => edit(() => setHeadersRemoved((value) => !value))}
                        visible={saved.headerNames.length > 0 && headersText === null}
                      >
                        {headersRemoved ? "Undo" : "Remove"}
                      </LabelAction>
                    </div>
                    <textarea
                      aria-invalid={Boolean(headersError)}
                      className="block min-h-16 w-full resize-y rounded-[6px] border border-input bg-transparent px-2.5 py-2 font-mono text-[12px] leading-[1.5] outline-none placeholder:text-muted-foreground focus-visible:border-ring/70 aria-invalid:border-destructive dark:bg-input/30"
                      id={`${formId}-headers`}
                      onChange={(event) => edit(() => setHeadersText(event.target.value || null))}
                      placeholder={
                        saved.headerNames.length && !headersRemoved ? `${saved.headerNames.join(", ")} saved in Keychain` : "Name: value"
                      }
                      rows={2}
                      spellCheck={false}
                      value={headersText ?? ""}
                    />
                    {/* The format error takes the hint's place, so the form does not grow. */}
                    <p className={cn("!mt-1 text-[12px] leading-[1.35]", headersError ? "text-destructive" : "text-muted-foreground")}>
                      {headersError || "Only for hosts that require one, such as a preview access token. One per line."}
                    </p>
                  </div>
                  {Boolean(saved.queryNames?.length) && (
                    <p className="text-[12px] leading-[1.35] text-muted-foreground">
                      Signed address: {saved.queryNames!.join(", ")} saved in Keychain and added to each request to this server.
                    </p>
                  )}
                  {connection.kind !== "ollama" && (
                    <Row
                      hint="Set a number if this server handles only a few at a time. Extra replies then wait here, and the chat you're viewing goes first."
                      label="Replies at once"
                    >
                      <Select onValueChange={(value) => value !== null && edit(() => setConcurrency(Number(value)))} value={String(concurrency)}>
                        <SelectTrigger aria-label="Replies at once" className="h-7 w-full rounded-[6px] text-[13px]" size="sm">
                          <SelectValue>{concurrencyLabel(concurrency)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {CONCURRENCY.map((value) => (
                            <SelectItem key={value} value={String(value)}>
                              {concurrencyLabel(value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                  )}
                </div>
              </Collapse>
            </div>
          )}
          {saveError && (
            <p className="text-[12px] leading-[1.35] text-destructive" role="alert">
              {saveError}
            </p>
          )}
          {confirmRemove ? (
            <RemoveConfirm
              label={connection.label}
              onCancel={() => setConfirmRemove(false)}
              onRemove={() => {
                onPanelChange(null);
                removeConnection(connection.id).catch((error: Error) => setSaveError(ipcMessage(error)));
              }}
            />
          ) : (
            <div className="flex items-center gap-3">
              {window.endurance && (
                <Button
                  aria-label={`Test ${connection.label} connection`}
                  className="h-7 shrink-0 gap-1.5 rounded-[6px] px-2.5 text-[12px]"
                  disabled={testing || Boolean(headersError) || Boolean(addressRefusal)}
                  onClick={() => void test()}
                  type="button"
                  variant="secondary"
                >
                  {testing && <LoaderCircleIcon className="size-3.5 animate-spin" />}
                  Test
                </Button>
              )}
              <p
                aria-live="polite"
                className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-[12px] leading-[1.35] text-muted-foreground transition-opacity duration-150", probe ? "opacity-100" : "opacity-0")}
                role="status"
                title={result}
              >
                {probe && <Dot state={probe.ok ? "testing-ok" : probe.reason === "starting" ? "starting" : "testing-bad"} />}
                <span className="truncate tabular-nums">{result}</span>
              </p>
              <Button className="h-7 shrink-0 rounded-[6px] text-[12px]" onClick={() => onOpenChange(false)} type="button" variant="ghost">
                Cancel
              </Button>
              <Button className="h-7 shrink-0 rounded-[6px] text-[12px]" disabled={saving || Boolean(headersError) || Boolean(addressRefusal)} type="submit">
                Save
              </Button>
            </div>
          )}
        </form>
      </Collapse>
    </div>
  );
}

/** What was read from the pasted text, shown before anything is sent. Secret values stay masked. */
function ParsedChips({ parsed }: { parsed: ParsedServer }) {
  let host = "";
  let path = "";
  try {
    const url = new URL(parsed.baseUrl);
    host = url.host;
    path = url.pathname === "/" ? "" : url.pathname;
  } catch {
    return null;
  }
  const chips = [
    host + path,
    locationLabel(classifyHost(new URL(parsed.baseUrl).hostname)),
    parsed.apiKey ? `Key ••••${parsed.apiKey.slice(-4)}` : undefined,
    Object.keys(parsed.headers).length ? `${Object.keys(parsed.headers).length} ${Object.keys(parsed.headers).length === 1 ? "header" : "headers"}` : undefined,
    parsed.query ? "Signed address" : undefined,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span className="inline-flex h-5 max-w-full items-center truncate rounded-full bg-muted px-2 font-mono text-[11.5px] text-foreground/85" key={chip}>
          {chip}
        </span>
      ))}
    </div>
  );
}

/**
 * One field for any server: paste a URL or a curl command, then Connect. The main process reads it again,
 * finds the API base and the runtime, and saves it when it answers or is starting. A key field appears
 * only when the server asks for one.
 */
function AddServerForm({ onDone, onCancel }: { onDone: (connection: ConnectionView) => void; onCancel: () => void }) {
  const [input, setInput] = useState("");
  const [key, setKey] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  let parsed: ParsedServer | null = null;
  let parseError = "";
  if (input.trim()) {
    try {
      parsed = parseServerInput(input);
    } catch (cause) {
      parseError = cause instanceof Error ? cause.message : "Couldn't read this.";
    }
  }
  const headers = headersText.trim() ? parseHeaders(headersText) : { headers: {} };
  const headersError = "error" in headers ? headers.error : "";
  const unresolved = parsed?.unresolved ?? [];
  const showKey = needsKey || unresolved.length > 0;
  const keyId = "add-server-key";

  const connect = async () => {
    if (!window.endurance || !parsed || headersError || busy) return;
    setBusy(true);
    setError("");
    setCheck(null);
    try {
      const result = await window.endurance.addServer({
        input,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        ...("headers" in headers && Object.keys(headers.headers).length ? { headers: headers.headers } : {}),
      });
      setCheck(result);
      if (result.connection) onDone(result.connection);
      else if (result.probe.reason === "auth") setNeedsKey(true);
    } catch (cause) {
      setError(cause instanceof Error ? ipcMessage(cause) : "Couldn't add this server.");
    } finally {
      setBusy(false);
    }
  };

  const outcome = check?.duplicate
    ? `Already listed as ${check.duplicate}.`
    : check && !check.connection
      ? check.probe.reason === "auth"
        ? key.trim() || parsed?.apiKey
          ? "The server rejected this API key."
          : "This server needs an API key."
        : `${reasonText(check.probe.reason, Boolean(key.trim()), check.probe.status, check.probe.detected)}. Check the address and try again.`
      : "";

  return (
    <form
      aria-label="Add a server by address"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
    >
      {/* Opens in place of the "Add server" row, so the title stays where it was clicked. */}
      <div className="flex items-center gap-2 p-3 text-[13px] leading-[1.4]">
        <PlusIcon className="size-3.5 text-muted-foreground" />
        Add server
      </div>
      <div className="space-y-4 px-3 pt-1 pb-3">
        <div className="space-y-1.5">
          <label className="text-[12px] leading-[1.35] text-muted-foreground" htmlFor="add-server-input">
            Server address or curl command
          </label>
          <textarea
            autoCapitalize="off"
            className="block min-h-[52px] w-full resize-y rounded-[6px] border border-input bg-transparent px-2.5 py-2 font-mono text-[12.5px] leading-[1.5] outline-none placeholder:text-muted-foreground focus-visible:border-ring/70 dark:bg-input/30"
            id="add-server-input"
            onChange={(event) => {
              setInput(event.target.value);
              setCheck(null);
              setError("");
            }}
            onKeyDown={(event) => {
              // Enter connects; Shift+Enter keeps a multi-line curl command.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void connect();
              }
            }}
            placeholder={"https://gpu.example.com/v1\ncurl https://… -H \"Authorization: Bearer …\""}
            ref={inputRef}
            rows={2}
            spellCheck={false}
            value={input}
          />
          {parsed && <ParsedChips parsed={parsed} />}
          {parseError && <p className="text-[12px] leading-[1.35] text-destructive">{parseError}</p>}
        </div>
        {showKey && (
          <div className="space-y-1.5">
            <label className="text-[12px] leading-[1.35] text-muted-foreground" htmlFor={keyId}>
              API key
            </label>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              autoFocus={needsKey}
              className="font-mono text-[13px]"
              id={keyId}
              onChange={(event) => setKey(event.target.value)}
              spellCheck={false}
              type="password"
              value={key}
            />
            {unresolved.length > 0 && (
              <p className="!mt-1 text-[12px] leading-[1.35] text-muted-foreground">
                The command uses {unresolved.map((name) => `$${name}`).join(", ")}. Paste the key here, or replace the variable in the command with its value.
              </p>
            )}
          </div>
        )}
        <div>
          <button
            aria-expanded={advanced}
            className="flex items-center gap-1 text-[12px] leading-[1.35] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            onClick={() => setAdvanced((value) => !value)}
            type="button"
          >
            Advanced
            <ChevronDownIcon className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", advanced && "rotate-180")} />
          </button>
          <Collapse open={advanced}>
            <div className="space-y-1.5 pt-3">
              <label className="text-[12px] leading-[1.35] text-muted-foreground" htmlFor="add-server-headers">
                Extra headers
              </label>
              <textarea
                aria-invalid={Boolean(headersError)}
                className="block min-h-14 w-full resize-y rounded-[6px] border border-input bg-transparent px-2.5 py-2 font-mono text-[12px] leading-[1.5] outline-none placeholder:text-muted-foreground focus-visible:border-ring/70 aria-invalid:border-destructive dark:bg-input/30"
                id="add-server-headers"
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder="Name: value"
                rows={2}
                spellCheck={false}
                value={headersText}
              />
              <p className={cn("!mt-1 text-[12px] leading-[1.35]", headersError ? "text-destructive" : "text-muted-foreground")}>
                {headersError || "Headers in a pasted curl command are read automatically."}
              </p>
            </div>
          </Collapse>
        </div>
        {(outcome || error) && (
          <p aria-live="polite" className="text-[12px] leading-[1.35] text-destructive" role="alert">
            {error || outcome}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button className="h-7 rounded-[6px] text-[12px]" onClick={onCancel} type="button" variant="ghost">
            Cancel
          </Button>
          <Button className="h-7 gap-1.5 rounded-[6px] text-[12px]" disabled={!parsed || busy || Boolean(headersError)} type="submit">
            {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function ConnectionsSettings() {
  const { connections, runtimeCatalog, refreshModels, addRuntime, detectRuntimes } = useStore();
  const more = RUNTIMES.filter((item) => item.baseUrl && !connections.some((connection) => connection.id === item.id));
  const [panel, setPanel] = useState<{ id: string; kind: Panel } | null>(null);
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  // The order just dragged, shown until the saved list comes back in it.
  const [order, setOrder] = useState<string[] | null>(null);
  const shown = order ? [...connections].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : connections;
  const [seen, setSeen] = useState(connections);
  if (seen !== connections) {
    setSeen(connections);
    setOrder(null);
  }
  const ollamaResult = runtimeCatalog.find((item) => item.connectionId === "ollama");
  const ollamaAddress = connections.find((item) => item.id === "ollama")?.baseUrl;

  useEffect(() => {
    if (!window.enduranceWorkspace) return;
    let cancelled = false;
    window.enduranceWorkspace.ollamaStatus().then((value) => !cancelled && setOllama(value)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ollamaResult, ollamaAddress]);

  // Coming back from starting a runtime elsewhere should show its state without a manual refresh.
  useEffect(() => {
    const refresh = () => {
      refreshModels();
      detectRuntimes();
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshModels, detectRuntimes]);

  return (
    <PageScroll>
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <h1 className="mb-6 pl-2 font-medium text-[15px] leading-[1.6]">Connections</h1>
        <section className="divide-y overflow-hidden rounded-[12px] border bg-card">
          <Reorderable
            canDrop={(item, target) => item.id !== target.id}
            label={(item) => connections.find((connection) => connection.id === item.id)?.label ?? "Server"}
            onDrop={(item, target) => {
              const ids = moveId(shown.map((connection) => connection.id), item.id, target.id, target.placement as DropPosition);
              setOrder(ids);
              window.endurance?.reorderConnections(ids).catch((error: Error) => {
                setOrder(null);
                toast.error("Couldn't save the order", { description: ipcMessage(error) });
              });
            }}
            overlay={(item) => <DragCard>{connections.find((connection) => connection.id === item.id)?.label}</DragCard>}
          >
          {shown.map((connection) => (
            <ConnectionRow
              connection={connection}
              focusName={justAdded === connection.id}
              key={connection.id}
              ollama={ollama}
              onOllama={setOllama}
              onPanelChange={(kind) => {
                setPanel(kind ? { id: connection.id, kind } : null);
                if (!kind) setJustAdded(null);
              }}
              panel={panel?.id === connection.id ? panel.kind : null}
            />
          ))}
          </Reorderable>
          {adding && (
            <AddServerForm
              onCancel={() => setAdding(false)}
              onDone={(connection) => {
                setAdding(false);
                setJustAdded(connection.id);
                setPanel({ id: connection.id, kind: "settings" });
              }}
            />
          )}
          {!adding && window.endurance && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="flex w-full items-center gap-2 p-3 text-left text-[13px] leading-[1.4] text-muted-foreground outline-none hover:bg-muted/30 hover:text-foreground focus-visible:bg-muted/30 data-popup-open:bg-muted/30 data-popup-open:text-foreground"
                    type="button"
                  />
                }
              >
                <PlusIcon className="size-3.5" />
                Add server
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72 p-1" sideOffset={4}>
                {more.map((item) => (
                  <DropdownMenuItem
                    className="h-[26px] justify-between gap-4 rounded-md py-0 text-[13px] font-normal"
                    key={item.id}
                    onClick={() => {
                      addRuntime(item.id);
                      setPanel({ id: item.id, kind: "setup" });
                    }}
                  >
                    <span className="truncate">{item.name}</span>
                    <span className="shrink-0 font-mono text-[12px] text-muted-foreground tabular-nums">:{new URL(item.baseUrl).port}</span>
                  </DropdownMenuItem>
                ))}
                {more.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem className="h-[26px] gap-4 rounded-md py-0 text-[13px] font-normal" onClick={() => setAdding(true)}>
                  <span className="truncate">Server URL…</span>
                  <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">URL or curl</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </section>
      </div>
    </PageScroll>
  );
}
