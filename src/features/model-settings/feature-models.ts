/**
 * Models chosen for features rather than chats: the model that reads scanned documents and photos of pages (a
 * model that takes images; unset, a chat's own model reads them when it takes images), and the speech-to-text
 * model for voice input with its language (unset, voice input is off). Kept in this window's storage beside the
 * model preferences, by model ID.
 */
import { MODELS, type ModelInfo } from "../../lib/models";
import { effectiveCapabilities, modelKind, modelPreferences, notifyPreferences } from "./preferences";

const KEY = "endurance:feature-models:v1";

export interface FeatureModels {
  /** The model ID that reads scanned documents and photos of pages. */
  reading?: string;
  /** The speech-to-text model ID for voice input. */
  voice?: string;
  /** The language voice input is recognized in (ISO 639-1); unset lets the model detect it. */
  voiceLanguage?: string;
}

const KEYS = ["reading", "voice", "voiceLanguage"] as const;
/** Only the fields set to a non-empty string. */
function clean(value: unknown): FeatureModels {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result: FeatureModels = {};
  for (const key of KEYS) {
    const field = record[key];
    if (typeof field === "string" && field) result[key] = field;
  }
  return result;
}

export function featureModels(): FeatureModels {
  try {
    return clean(JSON.parse(window.localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return {};
  }
}

/** Changes the fields named in `value`; a field given as undefined is cleared, the others stay. */
export function saveFeatureModels(value: FeatureModels) {
  window.localStorage.setItem(KEY, JSON.stringify(clean({ ...featureModels(), ...value })));
  notifyPreferences();
}

/** Models that can read pages: chat models that take images, shown in the picker. */
export const readingModels = (): ModelInfo[] =>
  MODELS.filter((model) => model.runtime && modelKind(model) === "chat" && modelPreferences(model).visible !== false && effectiveCapabilities(model).includes("vision"));

/** The model that reads pages for a chat on `chatModel`: the chosen one while it is listed, else the chat's own when it takes images. */
export function readingModelFor(chatModel: ModelInfo): ModelInfo | undefined {
  const chosen = featureModels().reading;
  const listed = chosen ? readingModels().find((model) => model.id === chosen) : undefined;
  if (listed) return listed;
  return effectiveCapabilities(chatModel).includes("vision") ? chatModel : undefined;
}

/** Models that turn speech into text: from connected runtimes, of the kind Speech to text. */
export const voiceModels = (): ModelInfo[] => MODELS.filter((model) => model.runtime && modelKind(model) === "speech");

/** The model for voice input while it is listed. There is no automatic choice: unset, voice input is off. */
export function voiceModel(): ModelInfo | undefined {
  const chosen = featureModels().voice;
  return chosen ? voiceModels().find((model) => model.id === chosen) : undefined;
}
