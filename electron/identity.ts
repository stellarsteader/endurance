import type { App } from "electron";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

export const PACKAGED = { name: "Endurance", id: "dev.stellarsteader.endurance" } as const;
export const DEVELOPMENT = { name: "Endurance Dev", id: "dev.stellarsteader.endurance-dev" } as const;
/** The packaged app's earlier name; its profile moves to the new name once. */
const LEGACY_PACKAGED = "Endurance Demo";

/**
 * Moves the packaged profile from its earlier name when only the old folder exists. Never merges: if both
 * exist, both are left as they are. Returns the profile path.
 */
export function moveLegacyProfile(appData: string, name: string = PACKAGED.name, legacy: string = LEGACY_PACKAGED) {
  const profile = join(appData, name);
  const previous = join(appData, legacy);
  if (!existsSync(profile) && existsSync(previous)) renameSync(previous, profile);
  return profile;
}

// Development and the packaged app use separate profiles.
export function configureIdentity(app: App) {
  const { name, id } = app.isPackaged ? PACKAGED : DEVELOPMENT;
  const override = app.commandLine.getSwitchValue("user-data-dir");
  const profile = override
    ? resolve(override)
    : app.isPackaged
      ? moveLegacyProfile(app.getPath("appData"))
      : join(app.getPath("appData"), name);
  mkdirSync(profile, { recursive: true });
  app.setName(name);
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setAppUserModelId(id);
  return { name, id, profile };
}
