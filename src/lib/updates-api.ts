/**
 * App updates. The main process asks GitHub Releases for a newer version (electron-updater reads the release's
 * latest*.yml). Where the app can replace itself it downloads the new build and offers a restart: the Windows
 * installer and the Linux AppImage. Everywhere else it only says a version is out and opens its release page:
 * macOS until releases are signed with a Developer ID, because macOS refuses to install an unsigned update.
 * Pure, shared by the renderer and the main process.
 */

/** "install": the app downloads the update and restarts into it. "notice": the person downloads it from the release page. */
export type UpdateMode = "install" | "notice";

export type UpdateState =
  /** A development build. Only installed copies check for updates. */
  | { status: "off" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current"; checkedAt: number }
  | { status: "available"; version: string; mode: UpdateMode }
  | { status: "downloading"; version: string; percent: number }
  /** Downloaded. It installs on the next restart or quit. */
  | { status: "ready"; version: string }
  | { status: "error"; message: string; version?: string };

export interface UpdatesAPI {
  /** The running app's version. */
  version(): Promise<string>;
  state(): Promise<UpdateState>;
  onState(listener: (state: UpdateState) => void): () => void;
  /** Asks GitHub now. Resolves once the answer is in the state. */
  check(): Promise<void>;
  /** Starts the download ("install" mode only). Progress arrives through onState. */
  download(): Promise<void>;
  /** Quits and installs the downloaded update, then opens the new version. */
  install(): void;
  /** Opens the newest release's page in the browser. */
  openRelease(): void;
}
declare global {
  interface Window {
    enduranceUpdates?: UpdatesAPI;
  }
}
