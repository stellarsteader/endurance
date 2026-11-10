import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import electronUpdater from "electron-updater";
import { version as builtVersion } from "../package.json";
import type { UpdateMode, UpdateState } from "../src/lib/updates-api";

type Trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => void;

/** Must name the same repository as `publish` in electron-builder.yml. */
const RELEASES = "https://github.com/stellarsteader/endurance/releases";
/**
 * How often an open app asks again. A guess: Electron's own update-electron-app asks every 10 minutes, and
 * Endurance releases far less often than that, so once an hour.
 */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Only an installed copy checks: a development build has no app-update.yml. On Linux only the AppImage can
 * replace itself, and an unpacked copy has no APPIMAGE variable, so it does not check either.
 */
const active = app.isPackaged && (process.platform !== "linux" || Boolean(process.env.APPIMAGE));
/** macOS installs an update only when it is signed by the same Developer ID as the running app. Releases are unsigned for now. */
const mode: UpdateMode = process.platform === "darwin" ? "notice" : "install";

let state: UpdateState = active ? { status: "idle" } : { status: "off" };
let manual = false;

function publish(next: UpdateState) {
  state = next;
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("updates:state", state);
}

/** electron-updater's lazy instance; reading it on a development build would only log warnings. */
const updater = () => electronUpdater.autoUpdater;

async function check(byPerson: boolean) {
  if (!active || ["checking", "downloading", "ready"].includes(state.status)) return;
  // A found update stays on screen between background checks; asking again by hand refreshes it.
  if (state.status === "available" && !byPerson) return;
  manual = byPerson;
  publish({ status: "checking" });
  try {
    await updater().checkForUpdates();
  } catch {
    // The error event has already set the state.
  }
}

function listen() {
  const u = updater();
  // The person chooses when to download, and an update downloaded but not restarted into installs at quit.
  u.autoDownload = false;
  u.autoInstallOnAppQuit = true;
  u.on("update-available", (info) => publish({ status: "available", version: info.version, mode }));
  u.on("update-not-available", () => publish({ status: "current", checkedAt: Date.now() }));
  let shown = -1;
  u.on("download-progress", (progress) => {
    if (state.status !== "downloading") return;
    const percent = Math.floor(progress.percent);
    if (percent === shown) return;
    shown = percent;
    publish({ ...state, percent });
  });
  u.on("update-downloaded", (info) => publish({ status: "ready", version: info.version }));
  u.on("error", (error) => {
    console.error("Update failed:", error);
    // The repository has no release yet, so there is nothing newer than this copy.
    if (state.status === "checking" && /No published versions/.test(error.message)) publish({ status: "current", checkedAt: Date.now() });
    else if (state.status === "downloading") publish({ status: "error", message: "The update did not download. Try again.", version: state.version });
    else if (state.status === "checking") {
      // A background check that fails (offline, GitHub down) says nothing. One the person asked for says why.
      if (manual) publish({ status: "error", message: "Could not reach GitHub to check for updates. Try again later." });
      else publish({ status: "idle" });
    }
  });
}

export function registerUpdatesIPC(trusted: Trusted) {
  ipcMain.handle("updates:version", (event) => {
    trusted(event);
    // `npm run dev` starts Electron from out-dev/main, which has no package.json, so app.getVersion() there is
    // Electron's own version. The version built in from package.json is the app's.
    return app.isPackaged ? app.getVersion() : builtVersion;
  });
  ipcMain.handle("updates:state", (event) => {
    trusted(event);
    return state;
  });
  ipcMain.handle("updates:check", async (event) => {
    trusted(event);
    await check(true);
  });
  ipcMain.handle("updates:download", async (event) => {
    trusted(event);
    const version = state.status === "available" || state.status === "error" ? state.version : undefined;
    if (!active || mode !== "install" || !version) return;
    publish({ status: "downloading", version, percent: 0 });
    try {
      await updater().downloadUpdate();
    } catch {
      // The error event has already set the state.
    }
  });
  ipcMain.on("updates:install", (event) => {
    trusted(event);
    // Silent so the Windows installer shows no wizard, and the new version opens when it is done.
    if (state.status === "ready") updater().quitAndInstall(true, true);
  });
  ipcMain.on("updates:open-release", (event) => {
    trusted(event);
    const version = "version" in state ? state.version : undefined;
    void shell.openExternal(version ? `${RELEASES}/tag/v${version}` : `${RELEASES}/latest`);
  });
  if (!active) return;
  listen();
  void check(false);
  setInterval(() => void check(false), CHECK_EVERY_MS).unref();
}
