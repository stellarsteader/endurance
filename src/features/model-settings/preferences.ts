import { MODEL_KINDS, type ModelCapability, type ModelInfo, type ModelKind } from "../../lib/models";
import type { Effort } from "../../lib/types";
import type { ModelPreferences } from "./types";
import { isThinkingSwitchChoice } from "../../lib/thinking-switch";
import { addMeasurement, type MemoryMeasurement } from "../../lib/memory-estimate";
import { resolveWindow, type ResolvedWindow } from "../../lib/context-window";
import { cleanSamplingSets } from "../../lib/sampling";

/** A connection as preferences need it. Builtin IDs are runtime IDs, so older keys still match. */
export interface PreferenceTarget {
  id: string;
  baseUrl: string;
}
const KEY = "endurance:model-preferences:v1";
let currentConnections = new Map<string, PreferenceTarget>();
let cachedRaw: string | null = null;
let cached: Record<string, ModelPreferences> = {};
let revision = 0;
const listeners = new Set<() => void>();
export function connectionKey(connection: PreferenceTarget, modelId: string) {
  // A connection edit can render once before its failed catalog probe completes.
  if (!URL.canParse(connection.baseUrl))
    return JSON.stringify([connection.id, "invalid", modelId]);
  const url = new URL(connection.baseUrl);
  return JSON.stringify([
    connection.id,
    url.origin,
    url.pathname.replace(/\/+$/, ""),
    modelId,
  ]);
}
function read() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === cachedRaw) return cached;
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cached =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, ModelPreferences>)
        : {};
    cachedRaw = raw;
  } catch {
    cached = {};
  }
  return cached;
}
const isKind = (value: unknown): value is ModelKind => MODEL_KINDS.some((kind) => kind.value === value);
const MEASUREMENTS = 4;
/** Valid measurements only, the last few kept. */
function measurementsOf(value: unknown): MemoryMeasurement[] {
  if (!Array.isArray(value)) return [];
  const whole = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item > 0;
  return value
    .filter((item): item is MemoryMeasurement => Boolean(item) && typeof item === "object" && whole(item.context) && whole(item.bytes))
    .map(({ context, bytes }) => ({ context, bytes }))
    .slice(-MEASUREMENTS);
}
export function preferencesFor(connection: PreferenceTarget, modelId: string): ModelPreferences {
  const value = read()[connectionKey(connection, modelId)];
  if (!value || typeof value !== "object") return {};
  return {
    ...(typeof value.displayName === "string" && value.displayName.trim()
      ? { displayName: value.displayName.trim().slice(0, 160) }
      : {}),
    ...(value.visible === false ? { visible: false } : {}),
    ...(value.thinking === false ? { thinking: false } : {}),
    ...(value.vision === true ? { vision: true } : {}),
    ...(value.reasoning === true ? { reasoning: true } : {}),
    ...(isThinkingSwitchChoice(value.thinkingSwitch) && value.thinkingSwitch !== "auto" ? { thinkingSwitch: value.thinkingSwitch } : {}),
    ...(measurementsOf(value.measurements).length ? { measurements: measurementsOf(value.measurements) } : {}),
    ...(cleanSamplingSets(value.sampling) ? { sampling: cleanSamplingSets(value.sampling) } : {}),
    ...(isKind(value.kind) ? { kind: value.kind } : {}),
    ...(typeof value.contextLimit === "number" &&
    Number.isSafeInteger(value.contextLimit) &&
    value.contextLimit >= 512 &&
    value.contextLimit <= 1048576
      ? { contextLimit: value.contextLimit }
      : {}),
  };
}
export function savePreferences(connection: PreferenceTarget, modelId: string, value: ModelPreferences) {
  const next = { ...read() };
  const key = connectionKey(connection, modelId);
  const clean: ModelPreferences = {};
  if (value.displayName?.trim())
    clean.displayName = value.displayName.trim().slice(0, 160);
  if (value.visible === false) clean.visible = false;
  if (value.thinking === false) clean.thinking = false;
  if (value.vision === true) clean.vision = true;
  if (value.reasoning === true) clean.reasoning = true;
  if (isThinkingSwitchChoice(value.thinkingSwitch) && value.thinkingSwitch !== "auto") clean.thinkingSwitch = value.thinkingSwitch;
  const measurements = measurementsOf(value.measurements);
  if (measurements.length) clean.measurements = measurements;
  const sampling = cleanSamplingSets(value.sampling);
  if (sampling) clean.sampling = sampling;
  if (isKind(value.kind)) clean.kind = value.kind;
  if (
    Number.isSafeInteger(value.contextLimit) &&
    value.contextLimit! >= 512 &&
    value.contextLimit! <= 1048576
  )
    clean.contextLimit = value.contextLimit;
  if (Object.keys(clean).length) next[key] = clean;
  else delete next[key];
  window.localStorage.setItem(KEY, JSON.stringify(next));
  cachedRaw = null;
  notifyPreferences();
}
/**
 * Remembers the memory a loaded model used at its window, so later estimates for this model follow this machine.
 * Writes only when the figure is new.
 */
export function recordMeasurement(connection: PreferenceTarget, modelId: string, measurement: MemoryMeasurement) {
  const current = preferencesFor(connection, modelId);
  const known = current.measurements ?? [];
  if (known.some((item) => item.context === measurement.context && item.bytes === measurement.bytes)) return;
  savePreferences(connection, modelId, { ...current, measurements: addMeasurement(known, measurement, MEASUREMENTS) });
}
export function setPreferenceConnections(value: PreferenceTarget[]) {
  currentConnections = new Map(value.map((item) => [item.id, item]));
}
export function modelPreferences(model: ModelInfo): ModelPreferences {
  if (!model.runtime || !model.runtimeModelId) return {};
  const connection = currentConnections.get(model.connectionId ?? model.runtime);
  return connection ? preferencesFor(connection, model.runtimeModelId) : {};
}
/** The window a runtime model's requests run with, from what its runtime reported and the person's cap. */
export function runtimeContext(model: ModelInfo): ResolvedWindow {
  if (!model.runtime) return {};
  const ollama = model.runtime === "ollama";
  return resolveWindow(
    model.runtime,
    {
      // Ollama reports what is loaded and what is stored separately; other runtimes report the window they serve.
      loaded: ollama ? model.loadedContext : model.context,
      configured: model.configuredContext,
      max: model.maxContext,
      runtimeDefault: model.runtimeDefaultContext,
    },
    { limit: ollama ? undefined : modelPreferences(model).contextLimit }
  );
}
/**
 * What the model can take: as reported when the runtime reports it, else the reported list plus what the
 * person turned on. Unknown stays off.
 */
export function effectiveCapabilities(model: ModelInfo, preference = modelPreferences(model)): ModelCapability[] {
  if (model.capabilitiesReported || !model.runtime) return model.capabilities;
  const added: ModelCapability[] = [...(preference.vision ? (["vision"] as const) : []), ...(preference.reasoning ? (["reasoning"] as const) : [])];
  return [...new Set([...model.capabilities, ...added])];
}
export function decorateModel(model: ModelInfo): ModelInfo {
  const preference = modelPreferences(model);
  if (!preference.displayName && !preference.vision && !preference.reasoning) return model;
  return { ...model, name: preference.displayName ?? model.name, capabilities: effectiveCapabilities(model, preference) };
}
/** What the model is for: the person's setting, else what the runtime said, else chat. */
export const modelKind = (model: ModelInfo, preference = modelPreferences(model)): ModelKind => preference.kind ?? model.kind ?? "chat";

/** A chat request showed this model does not chat: it leaves the chat models, unless the person said it is one. */
export function markNotChat(model: ModelInfo) {
  const connection = model.runtime && model.runtimeModelId ? currentConnections.get(model.connectionId ?? model.runtime) : undefined;
  if (!connection) return;
  const current = preferencesFor(connection, model.runtimeModelId!);
  if (current.kind) return;
  savePreferences(connection, model.runtimeModelId!, { ...current, kind: "other" });
}

/**
 * The effort a chat starts with on this model: Off when thinking is off by default in Models settings, else
 * nothing, so the model's own levels decide. A chat can still turn thinking on.
 */
export const defaultEffort = (model: ModelInfo): Effort | undefined => (modelPreferences(model).thinking === false ? "none" : undefined);
export function notifyPreferences() {
  revision++;
  for (const listener of listeners) listener();
}
export function subscribePreferences(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function preferenceRevision() {
  return revision;
}
