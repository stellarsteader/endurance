/**
 * The person's own terminal in a project. The renderer names a project and sends keystrokes;
 * the main process picks the shell, folder, sandbox and environment, and a separate process runs the PTY.
 */

/** How a terminal runs: in the project's sandbox, or with everything the person's account can do. */
export type TerminalMode = "sandboxed" | "full";

/** Terminals open at once in one project. */
export const MAX_TERMINALS = 4;
/** The most text one write may carry; a longer paste is sent in pieces. */
export const MAX_WRITE = 64 * 1024;

export interface TerminalInfo {
  id: string;
  projectId: string;
  /** The shell's name, such as zsh. */
  title: string;
  /** The folder it started in. */
  cwd: string;
  mode: TerminalMode;
  /** Sandboxed terminals reach the network only when Internet Access was on as they opened. */
  network: boolean;
  /** Set once the shell has ended; the tab stays until it is closed. */
  exitCode?: number | null;
}

export type TerminalEvent =
  /** Output, with its size in bytes; the renderer acknowledges those bytes once they are drawn. */
  | { id: string; type: "data"; data: string; bytes: number }
  | { id: string; type: "exit"; exitCode: number | null };

export interface TerminalAttach {
  /** The output kept for this terminal (its last megabyte), to draw before new output. */
  replay: string;
  exitCode?: number | null;
}

export interface TerminalAPI {
  /** How new terminals in the project run. */
  access(projectId: string): Promise<TerminalMode>;
  /** Asks the person in a macOS dialog to let new terminals run with their full permissions; resolves to the mode after. */
  requestFullAccess(projectId: string): Promise<TerminalMode>;
  /** New terminals run sandboxed again. Terminals already open keep how they started. */
  useSandbox(projectId: string): Promise<TerminalMode>;
  /** This window's terminals in the project. */
  list(projectId: string): Promise<TerminalInfo[]>;
  /** Starts the person's login shell in the project's first Read & write folder (else its first readable one). */
  open(projectId: string, options: { network: boolean; cols: number; rows: number }): Promise<TerminalInfo>;
  /** Starts delivering output to this window, after the kept output. */
  attach(id: string): Promise<TerminalAttach>;
  detach(id: string): void;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Output bytes drawn; the shell is paused while too many are waiting. */
  ack(id: string, bytes: number): void;
  /** Ends the shell and everything it started. */
  close(id: string): Promise<void>;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
}
declare global {
  interface Window {
    /** Only on macOS, where the terminal's sandbox is available. */
    enduranceTerminal?: TerminalAPI;
  }
}
