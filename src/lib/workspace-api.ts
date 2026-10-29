import type { AllowRule } from "./permissions";
import type { WorkspacePolicy } from "./workspace-policy";

export interface PickedFolder {
  path: string;
  name: string;
}
export interface FolderEntry {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
}
export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
}
export interface SkillFolder {
  path: string;
  name: string;
  skills: SkillSummary[];
  error?: string;
}
export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version?: string;
}
/** The longest project instructions kept: enough for large windows; longer belongs in a document or a skill. */
export const MAX_INSTRUCTIONS = 200_000;

/** A project as the main process stores it. The main process is the only copy; the renderer shows what it returns. */
export interface StoredProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt?: number;
  pinned?: boolean;
  collapsed?: boolean;
  instructions?: string;
  access?: WorkspacePolicy;
  /** What runs without asking in every chat of the project (lib/permissions); removed in Project settings. */
  alwaysAllowed?: AllowRule[];
}
export interface WorkspaceAPI {
  pickFolders(multiple: boolean): Promise<PickedFolder[]>;
  listFolder(root: string, directory: string): Promise<{ entries: FolderEntry[]; more: boolean }>;
  /** Project files whose path contains `query`, shown as "folder/relative/path", for @ mentions. */
  mentionFiles(projectId: string, query: string): Promise<{ files: string[]; more: boolean }>;
  /** Saved projects. `legacy` is imported once, the first time the database has no projects record. */
  projects(legacy?: StoredProject[]): Promise<StoredProject[]>;
  /** Saves and returns the stored project; rejects folders not chosen with Add folder. */
  saveProject(project: StoredProject): Promise<StoredProject>;
  removeProject(projectId: string): Promise<void>;
  revealFolder(path: string): Promise<void>;
  skills(): Promise<SkillFolder[]>;
  addSkillFolder(): Promise<SkillFolder[]>;
  removeSkillFolder(path: string): Promise<SkillFolder[]>;
  setSkillEnabled(path: string, enabled: boolean): Promise<SkillFolder[]>;
  readSkill(path: string): Promise<string>;
  ollamaStatus(): Promise<OllamaStatus>;
  openOllama(): Promise<OllamaStatus>;
}
declare global {
  interface Window {
    enduranceWorkspace?: WorkspaceAPI;
  }
}
