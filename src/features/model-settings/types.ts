import type { ModelKind, RuntimeConnection, RuntimeId } from "../../lib/models";
import type { ThinkingSwitchChoice } from "../../lib/thinking-switch";
import type { MemoryFacts, ReportedMemory } from "../../lib/memory-estimate";
import type { Sampling, SamplingField, SamplingSets } from "../../lib/sampling";
import type { ManagedModel, ManagerDownload, ManagerInfo, ManagerPlan } from "./manager-client";

/** A saved connection with its secrets, resolved by the main process. Never built by the renderer. */
export interface RuntimeTarget {
  runtime: RuntimeId;
  connection: RuntimeConnection;
}
/** How the renderer names where a model operation goes. */
export interface ConnectionTarget {
  connectionId: string;
}
export type HFDownloadRequest = ConnectionTarget & { repository: string; filename: string };
export type OllamaPullRequest = ConnectionTarget & { model: string };
export interface ModelPreferences {
  displayName?: string;
  visible?: boolean;
  /**
   * The window for a runtime that stores none itself but takes one at load (LM Studio). Ollama keeps its own
   * setting in the Modelfile, so this is ignored there.
   */
  contextLimit?: number;
  /** False turns reasoning off for models that report thinking. */
  thinking?: boolean;
  /** Set by the person for a runtime that does not report capabilities. */
  vision?: boolean;
  reasoning?: boolean;
  /** For a runtime that switches thinking through the chat template: which variable it reads. Unset is automatic. */
  thinkingSwitch?: ThinkingSwitchChoice;
  /** Memory the runtime reported for this model loaded here, by window; the last few, newest last. */
  reportedMemory?: ReportedMemory[];
  /** Sampling the person set, sent with every request for the model (lib/sampling). Unset is the model's own. */
  sampling?: SamplingSets;
  /**
   * What the model is for, when the person set it or a chat request showed it is not a chat model. Unset
   * follows the runtime, and chat when the runtime does not say.
   */
  kind?: ModelKind;
}
export interface RuntimeModelDetails extends MemoryFacts {
  modelId: string;
  /** The window in effect: the loaded one, else the one the runtime will load with. */
  context?: number;
  /** The window the loaded model runs with. */
  loadedContext?: number;
  /** The window the runtime stores for the model and loads it with (Ollama's Modelfile num_ctx). */
  configured?: number;
  maxContext?: number;
  loaded?: boolean;
  /** LM Studio's loaded instance, which a new window replaces. */
  loadId?: string;
  quantization?: string;
  /** A loaded model's size and how much of it sits in GPU memory, in bytes, where the runtime reports it. */
  memory?: { total: number; gpu: number };
  /** This computer's memory in bytes, set only when the runtime runs here; windows that fit it are suggested. */
  hostMemory?: number;
  capabilities: string[];
  /** The runtime takes a window for the model (Ollama's Modelfile, LM Studio's load). */
  canSetContext: boolean;
  /** The runtime API can remove the model and its files. */
  canDelete?: boolean;
  /**
   * The sampling the runtime uses for the model when nothing is sent, and which of those values the model sets
   * itself (Ollama's Modelfile); the others are the runtime's defaults. Undefined when the runtime does not say
   * (vLLM applies the model's generation_config without reporting it).
   */
  sampling?: { values: Sampling; own: SamplingField[] };
}
export interface HFFile {
  name: string;
  bytes?: number;
  quantization?: string;
  shard?: boolean;
  projector?: boolean;
}
export type Modality = "text" | "image";
export interface HFModel {
  id: string;
  downloads?: number;
  gated?: boolean;
  files: HFFile[];
  /** Hub pipeline tag, such as image-text-to-text. */
  pipeline?: string;
  /** The repository the person pasted, shown first. */
  requested?: boolean;
}
export interface HFDownloadInput extends RuntimeTarget {
  repository: string;
  filename: string;
}
export interface HFProgress {
  status: string;
  completed?: number;
  total?: number;
  done?: boolean;
  error?: string;
  /** Runtime model ID once installed, when the runtime reports it. */
  model?: string;
}
/** Where the connected Ollama runs, as far as the main process can tell. */
export interface OllamaHost {
  /** The connection is loopback, so this machine's hardware is Ollama's hardware. */
  local: boolean;
  platform: string;
  appleSilicon: boolean;
  memory?: number;
}
/** An Ollama library tag as the Ollama registry describes it before any download. */
export interface OllamaLibraryModel {
  /** The reference Ollama pulls and lists, such as qwen3.5:4b-mlx. */
  id: string;
  namespace: string;
  name: string;
  tag: string;
  /** The registry has no such model or tag. */
  missing?: boolean;
  bytes?: number;
  format?: string;
  quantization?: string;
  /** Capabilities the registry declares; empty when it does not say. */
  capabilities: string[];
  /** Minimum Ollama version the registry declares for this tag. */
  requires?: string;
  mlx: boolean;
  /** Version reported by the connected Ollama, when one was checked. */
  serverVersion?: string;
  host?: OllamaHost;
}
export interface OllamaPullInput extends RuntimeTarget {
  model: string;
}
/** What the person sees for a download; the renderer names it, the main process owns it. */
export interface DownloadDisplay {
  /** HF repository or Ollama tag; one active download per key. */
  key: string;
  label: string;
  /** Suggested display name once installed. */
  name: string;
  /** Bytes expected before the runtime reports a total. */
  expected: number;
}
export interface ModelDownload extends DownloadDisplay {
  id: string;
  runtime: RuntimeId;
  connectionId: string;
  connectionLabel: string;
  state: "active" | "completed" | "failed" | "cancelled";
  progress: HFProgress;
  startedAt: number;
  /** Runtime model ID once installed. */
  model?: string;
  error?: string;
}
export interface ModelSettingsAPI {
  details(target: ConnectionTarget, modelId: string): Promise<RuntimeModelDetails>;
  mutate(
    target: ConnectionTarget,
    modelId: string,
    action: "context" | "delete",
    context?: number,
  ): Promise<void>;
  searchHuggingFace(id: string, query: string): Promise<HFModel[]>;
  /** Starts a download owned by the main process; its outcome arrives through onDownloads. */
  downloadHuggingFace(id: string, input: HFDownloadRequest, display: DownloadDisplay): Promise<void>;
  lookupOllama(id: string, query: string, target?: ConnectionTarget): Promise<OllamaLibraryModel>;
  pullOllama(id: string, input: OllamaPullRequest, display: DownloadDisplay): Promise<void>;
  cancel(id: string): void;
  /** Downloads this window started, including finished ones not yet dismissed. */
  downloads(): Promise<ModelDownload[]>;
  dismissDownload(id: string): void;
  onDownloads(listener: (downloads: ModelDownload[]) => void): () => void;
  /** The vLLM manager on a server the person runs (server/); see manager-client. */
  manager: {
    info(target: ConnectionTarget): Promise<ManagerInfo | undefined>;
    models(target: ConnectionTarget): Promise<ManagedModel[]>;
    plan(target: ConnectionTarget, model: string, window?: number): Promise<ManagerPlan>;
    start(target: ConnectionTarget, model: string, options: { window?: number; image?: string }): Promise<{ status: string; window: number; share: number }>;
    stop(target: ConnectionTarget, model: string): Promise<{ stopped: boolean }>;
    remove(target: ConnectionTarget, model: string): Promise<{ deleted: boolean }>;
    logs(target: ConnectionTarget, model: string): Promise<string>;
    download(target: ConnectionTarget, model: string): Promise<{ state: string; totalBytes: number }>;
    downloads(target: ConnectionTarget): Promise<ManagerDownload[]>;
  };
  /** The Hugging Face token for gated models, kept encrypted by the main process; only whether it is set comes back. */
  hfToken: {
    status(): Promise<{ set: boolean }>;
    save(value: string | null): Promise<{ set: boolean }>;
  };
}
declare global {
  interface Window {
    enduranceModels?: ModelSettingsAPI;
  }
}
