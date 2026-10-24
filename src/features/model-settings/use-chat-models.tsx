import { useEffect, useSyncExternalStore } from "react";
import { MODELS } from "../../lib/models";
import { useStore } from "../../lib/store";
import {
  decorateModel,
  modelKind,
  modelPreferences,
  notifyPreferences,
  preferenceRevision,
  setPreferenceConnections,
  subscribePreferences,
} from "./preferences";

export const usePreferenceRevision = () =>
  useSyncExternalStore(subscribePreferences, preferenceRevision, () => 0);
export function useChatModels() {
  usePreferenceRevision();
  // Only chat models answer in a chat; the others stay in Models settings.
  return MODELS.filter(
    (model) => modelPreferences(model).visible !== false && modelKind(model) === "chat",
  ).map(decorateModel);
}
export function ModelSettingsSync() {
  const { connections, setSettings } = useStore();
  const version = usePreferenceRevision();
  useEffect(() => {
    setPreferenceConnections(connections);
    notifyPreferences();
  }, [connections]);
  useEffect(() => {
    if (version > 0) setSettings({});
  }, [version, setSettings]);
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === "endurance:model-preferences:v1") notifyPreferences();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);
  return null;
}
