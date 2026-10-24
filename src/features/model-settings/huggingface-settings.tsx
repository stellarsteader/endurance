import { useEffect, useRef, useState } from "react";
import { ArrowDownToLineIcon, CheckIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { DOWNLOAD_RUNTIMES, type RuntimeId } from "../../lib/models";
import { useStore } from "../../lib/store";
import { cn } from "../../lib/utils";
import { installable, modalities, projectorBytes } from "./huggingface";
import {
  ggufAlternative,
  ollamaDisplayName,
  ollamaPage,
  ollamaPreflight,
  parseOllamaReference,
  relatedBuilds,
  sameOllamaModel,
} from "./ollama-library";
import { ActiveDownloads, DownloadProgress, startDownload, useDownloads } from "./downloads";
import type { DownloadEntry } from "./download-progress";
import type { HFFile, HFModel, OllamaLibraryModel } from "./types";
import { ipcMessage } from "../../lib/desktop";

const gigabytes = (bytes?: number) => (bytes === undefined ? "Size unknown" : `${(bytes / 1024 ** 3).toFixed(1)} GB`);
const count = (value?: number) =>
  value === undefined ? undefined : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}K` : String(value);

/** "unsloth/Qwen3-VL-4B-Instruct-GGUF" → "Qwen3 VL 4B Instruct" */
export const suggestedName = (repository: string) =>
  (repository.split("/").at(-1) ?? repository)
    .replace(/[-_.]?gguf$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();

function compatibility(model: HFModel, runtime: RuntimeId, choices: HFFile[]) {
  if (model.gated) return "Requires access approval";
  if (!choices.length) return "No single-file GGUF";
  if (runtime === "ollama" && !choices.some((file) => !file.name.includes("/"))) return "Files are in subfolders";
  if (runtime !== "ollama" && !choices.some((file) => file.quantization && choices.filter((other) => other.quantization === file.quantization).length === 1))
    return "No unique quantization";
  return null;
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: "ok" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[12px] leading-[1.35]",
        tone === "muted" ? "bg-muted/60 text-muted-foreground" : "bg-muted text-foreground/85"
      )}
    >
      {tone === "ok" && <CheckIcon className="size-3 text-emerald-500" />}
      {children}
    </span>
  );
}

function Installed() {
  return (
    <span className="flex h-7 shrink-0 items-center gap-1 px-2 text-[12px] text-muted-foreground">
      <CheckIcon className="size-3.5 text-emerald-500" />
      Installed
    </span>
  );
}

// The last search survives leaving the page, so coming back shows what was there.
let lastSearch: { query: string; results: HFModel[]; library: OllamaLibraryModel | null; files: Record<string, string> } = {
  query: "",
  results: [],
  library: null,
  files: {},
};

/** One Ollama library tag, with the checks that apply before its download. */
function LibraryResult({
  model,
  connected,
  installedModels,
  downloading,
  busy,
  onCheck,
  onDownload,
}: {
  model: OllamaLibraryModel;
  connected: boolean;
  installedModels: string[];
  downloading?: DownloadEntry;
  busy: boolean;
  onCheck: (tag: string) => void;
  onDownload: (model: OllamaLibraryModel) => void;
}) {
  const check = ollamaPreflight(model);
  const blocked = model.missing ? null : !connected ? "Connect Ollama to install" : check.blocked;
  const installed = installedModels.some((id) => sameOllamaModel(id, model.id));
  const related = installed ? [] : relatedBuilds(model, installedModels);
  const alternative = check.alternative ?? (model.missing ? ggufAlternative(model) : undefined);
  const page = ollamaPage(model);
  return (
    <div className="space-y-2.5 p-3">
      <div className="flex items-center gap-3">
        <a className="min-w-0 flex-1 truncate text-[13px] leading-[1.4] outline-none hover:underline focus-visible:underline" href={page} rel="noreferrer" target="_blank">
          {model.id}
        </a>
        <span className="shrink-0 text-[12px] leading-[1.35] text-muted-foreground">Ollama library</span>
      </div>
      {model.missing ? (
        <p className="text-[12px] leading-[1.35] text-muted-foreground">
          The Ollama library has no {model.id}.{" "}
          <a className="text-foreground/85 underline-offset-2 hover:underline" href={`${page}/tags`} rel="noreferrer" target="_blank">
            See {model.name} tags
          </a>
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {blocked ? <Pill tone="muted">{blocked}</Pill> : <Pill tone="ok">Ollama</Pill>}
            <Pill>Text</Pill>
            {model.capabilities.includes("vision") && <Pill>Image</Pill>}
            {model.mlx && <Pill>MLX</Pill>}
            {model.quantization && <Pill>{model.quantization.toUpperCase()}</Pill>}
          </div>
          {check.notes.map((note) => (
            <p className="text-[12px] leading-[1.35] text-muted-foreground" key={note}>
              {note}
            </p>
          ))}
          {related.length > 0 && <p className="truncate text-[12px] leading-[1.35] text-muted-foreground">Also installed: {related.join(", ")}</p>}
        </>
      )}
      {alternative && (
        <Button
          className="h-7 rounded-[6px] px-2.5 text-[12px]"
          disabled={busy}
          onClick={() => onCheck(alternative)}
          type="button"
          variant="secondary"
        >
          Check {alternative}
        </Button>
      )}
      {downloading && <DownloadProgress entry={downloading} />}
      {!downloading && !model.missing && !blocked && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] leading-[1.35] text-muted-foreground tabular-nums">{gigabytes(model.bytes)}</span>
          {installed ? (
            <Installed />
          ) : (
            <Button
              aria-label={`Download ${model.id}`}
              className="h-7 shrink-0 rounded-[6px] px-2.5 text-[12px]"
              onClick={() => onDownload(model)}
              type="button"
              variant="secondary"
            >
              Download
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Adds models from Hugging Face (GGUF search) or the Ollama library (by tag) to a connected runtime. */
export function HuggingFaceSettings() {
  const { runtimeCatalog, connections } = useStore();
  const [query, setQuery] = useState(lastSearch.query);
  const [results, setResults] = useState<HFModel[]>(lastSearch.results);
  const [library, setLibrary] = useState<OllamaLibraryModel | null>(lastSearch.library);
  const [files, setFiles] = useState<Record<string, string>>(lastSearch.files);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(Boolean(lastSearch.library || lastSearch.results.length));
  const [error, setError] = useState("");
  const [targetId, setTargetId] = useState("ollama");
  const activeSearch = useRef<string | null>(null);
  const downloads = useDownloads();
  const downloading = (key: string) => downloads.find((entry) => entry.key === key);
  const shown = library ? [library.id] : results.map((model) => model.id);
  // Any connected server whose own API installs models, wherever it runs.
  const targets = connections.filter((item) => DOWNLOAD_RUNTIMES.includes(item.kind) && runtimeCatalog.some((entry) => entry.connectionId === item.id && !entry.error));
  const destination = targets.find((item) => item.id === targetId) ?? targets[0];
  // Ollama tags go to the chosen server when it is Ollama, else to the first Ollama listed.
  const ollama = destination?.kind === "ollama" ? destination : targets.find((item) => item.kind === "ollama");
  const modelsOf = (id?: string) => runtimeCatalog.find((entry) => entry.connectionId === id)?.models.map((item) => item.runtimeModelId ?? item.name) ?? [];
  const ollamaModels = modelsOf(ollama?.id);
  // Decided as the person types, so the note below says where the query goes before it is sent.
  const tagQuery = Boolean(parseOllamaReference(query));
  // Installed means the runtime lists it now, so a deleted model can be downloaded again.
  const installedIn = (repository: string) =>
    destination?.kind === "ollama" && modelsOf(destination.id).some((id) => id.toLowerCase().startsWith(`hf.co/${repository.toLowerCase()}:`));

  useEffect(() => {
    lastSearch = { query, results, library, files };
  }, [query, results, library, files]);

  // Leaving the page stops only a search in flight; downloads belong to the main process.
  useEffect(
    () => () => {
      if (activeSearch.current) window.enduranceModels?.cancel(activeSearch.current);
      activeSearch.current = null;
    },
    []
  );

  const search = async (value = query) => {
    const text = value.trim();
    const api = window.enduranceModels;
    if (!api || text.length < 2) return;
    if (activeSearch.current) api.cancel(activeSearch.current);
    const id = crypto.randomUUID();
    activeSearch.current = id;
    setSearching(true);
    setError("");
    setSearched(false);
    try {
      // An Ollama tag is looked up on the Ollama registry only; it is never sent to Hugging Face.
      if (parseOllamaReference(text)) {
        const found = await api.lookupOllama(id, text, ollama ? { connectionId: ollama.id } : undefined);
        if (activeSearch.current !== id) return;
        setLibrary(found);
        setResults([]);
      } else {
        const found = await api.searchHuggingFace(id, text);
        if (activeSearch.current !== id) return;
        setResults(found);
        setLibrary(null);
      }
      setFiles({});
      setSearched(true);
    } catch (cause) {
      if (activeSearch.current === id) setError(cause instanceof Error ? ipcMessage(cause) : "Search failed");
    } finally {
      if (activeSearch.current === id) {
        activeSearch.current = null;
        setSearching(false);
      }
    }
  };

  const download = (model: HFModel, file: HFFile) => {
    if (!destination) return;
    const vision = modalities(model).includes("image") && destination.kind === "ollama";
    void startDownload({
      kind: "huggingface",
      input: { connectionId: destination.id, repository: model.id, filename: file.name },
      display: {
        key: model.id,
        label: `${model.id.split("/").at(-1) ?? model.id} · ${file.quantization ?? file.name}`,
        name: suggestedName(model.id),
        expected: (file.bytes ?? 0) + (vision ? projectorBytes(model) : 0),
      },
    });
  };

  const pull = (model: OllamaLibraryModel) => {
    if (!ollama) return;
    void startDownload({
      kind: "ollama",
      input: { connectionId: ollama.id, model: model.id },
      display: { key: model.id, label: model.id, name: ollamaDisplayName(model), expected: model.bytes ?? 0 },
    });
  };

  return (
    <section aria-label="Add model" className="mt-7">
      <h2 className="mb-2 px-2 text-[12px] leading-[1.35] text-muted-foreground">Add model</h2>
      <div className="divide-y overflow-hidden rounded-[12px] border bg-card">
        <form
          className="space-y-3 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search models"
                className="h-7 rounded-[6px] pl-7 text-[13px]"
                maxLength={120}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={ollama ? "Search Hugging Face or enter an Ollama tag" : destination ? `Search models for ${destination.label}` : "Search models"}
                value={query}
              />
            </div>
            {/* Ollama tags install only into Ollama, so a tag offers only Ollama servers. */}
            {(tagQuery ? targets.filter((item) => item.kind === "ollama") : targets).length > 1 && (
              <Select onValueChange={(value) => value && setTargetId(value)} value={tagQuery ? ollama?.id : destination?.id}>
                <SelectTrigger aria-label="Download runtime" className="h-7 w-36 rounded-[6px] text-[13px]" size="sm">
                  <SelectValue>{(tagQuery ? ollama : destination)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(tagQuery ? targets.filter((item) => item.kind === "ollama") : targets).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {searching ? (
              <Button
                className="h-7 rounded-[6px] text-[12px]"
                onClick={() => {
                  if (activeSearch.current) window.enduranceModels?.cancel(activeSearch.current);
                  activeSearch.current = null;
                  setSearching(false);
                }}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            ) : (
              <Button className="h-7 rounded-[6px] text-[12px]" disabled={!window.enduranceModels || query.trim().length < 2} type="submit" variant="secondary">
                {tagQuery ? "Check" : "Search"}
              </Button>
            )}
          </div>
          <p className="text-[12px] leading-[1.35] text-muted-foreground">
            {tagQuery ? "Looked up on the Ollama registry. Ollama downloads it; nothing is sent to Hugging Face." : "Search terms are sent to Hugging Face."}
          </p>
          {error && (
            <p className="text-[12px] leading-[1.4] text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
        <ActiveDownloads shown={searching ? [] : shown} />
        {searching && (
          <p className="flex items-center gap-2 p-3 text-[12px] text-muted-foreground" role="status">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {tagQuery ? "Checking…" : "Searching…"}
          </p>
        )}
        {!searching && library && (
          <LibraryResult
            busy={searching}
            connected={Boolean(ollama)}
            downloading={downloading(library.id)}
            installedModels={ollamaModels}
            model={library}
            onCheck={(tag) => {
              setQuery(tag);
              void search(tag);
            }}
            onDownload={pull}
          />
        )}
        {searched && !library && results.length === 0 && (
          <p className="p-3 text-[12px] leading-[1.35] text-muted-foreground">
            No matching GGUF models.
            {ollama && " MLX and other Ollama library builds aren't listed here. Enter the Ollama tag instead, such as name:tag."}
          </p>
        )}
        {!searching &&
          destination &&
          results.map((model) => {
            const choices = installable(model);
            const choice = choices.find((file) => file.name === files[model.id]) ?? choices.find((file) => file.quantization === "Q4_K_M") ?? choices[0];
            const blocked = compatibility(model, destination.kind, choices);
            const kinds = modalities(model);
            const extra = kinds.includes("image") && destination.kind === "ollama" ? projectorBytes(model) : 0;
            const active = downloading(model.id);
            return (
              <div className="space-y-2.5 p-3" key={model.id}>
                <div className="flex items-center gap-3">
                  <a
                    className="min-w-0 flex-1 truncate text-[13px] leading-[1.4] outline-none hover:underline focus-visible:underline"
                    href={`https://huggingface.co/${model.id}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {model.id}
                  </a>
                  {model.downloads !== undefined && (
                    <span className="flex shrink-0 items-center gap-1 text-[12px] leading-[1.35] text-muted-foreground tabular-nums">
                      <ArrowDownToLineIcon className="size-3" />
                      {count(model.downloads)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {blocked ? <Pill tone="muted">{blocked}</Pill> : <Pill tone="ok">{destination.label}</Pill>}
                  <Pill>Text</Pill>
                  {kinds.includes("image") && <Pill>Image</Pill>}
                </div>
                {blocked && model.requested && results.length > 1 && (
                  <p className="text-[12px] leading-[1.35] text-muted-foreground">Install a GGUF conversion listed below.</p>
                )}
                {active && <DownloadProgress entry={active} />}
                {!blocked && choice && !active && (
                  <div className="flex items-center gap-2">
                    <Select
                      onValueChange={(value) => value && setFiles((previous) => ({ ...previous, [model.id]: value }))}
                      value={choice.name}
                    >
                      <SelectTrigger aria-label={`File for ${model.id}`} className="h-7 min-w-0 flex-1 rounded-[6px] text-[12px]" size="sm">
                        <SelectValue>
                          {choice.quantization ?? choice.name} · {gigabytes(choice.bytes === undefined ? undefined : choice.bytes + extra)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {choices.map((file) => (
                          <SelectItem key={file.name} value={file.name}>
                            {file.quantization ?? file.name} · {gigabytes(file.bytes === undefined ? undefined : file.bytes + extra)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {installedIn(model.id) ? (
                      <Installed />
                    ) : (
                      <Button
                        aria-label={`Download ${model.id}`}
                        className="h-7 shrink-0 rounded-[6px] px-2.5 text-[12px]"
                        onClick={() => download(model, choice)}
                        type="button"
                        variant="secondary"
                      >
                        Download
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
}
