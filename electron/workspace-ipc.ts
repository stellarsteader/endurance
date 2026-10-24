import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { mentionedSkills, readSkill, scanSkills } from "../src/harness/skills";
import { Workspace } from "../src/harness/workspace-tools";
import { folderName, sanitizePolicy, within, type WorkspacePolicy } from "../src/lib/workspace-policy";
import type { OllamaStatus, SkillFolder, StoredProject } from "../src/lib/workspace-api";
import { history } from "./history-ipc";
import type { RuntimeConnection } from "../src/lib/models";

interface Saved {
  /** Folders the person chose in a native dialog. Nothing else can become a project or skill folder. */
  grants: string[];
  /** Only read to import into the history database; projects are no longer saved here. */
  projects: Record<string, WorkspacePolicy>;
  skillFolders: string[];
  disabledSkills: string[];
}

const file = () => path.join(app.getPath("userData"), "workspace.json");
let saved: Saved | undefined;
async function load(): Promise<Saved> {
  if (saved) return saved;
  try {
    const value = JSON.parse(await fs.readFile(file(), "utf8")) as Partial<Saved>;
    saved = {
      grants: Array.isArray(value.grants) ? value.grants.filter((item) => typeof item === "string") : [],
      projects: Object.fromEntries(Object.entries(value.projects ?? {}).map(([id, policy]) => [id, sanitizePolicy(policy)])),
      skillFolders: Array.isArray(value.skillFolders) ? value.skillFolders.filter((item) => typeof item === "string") : [],
      disabledSkills: Array.isArray(value.disabledSkills) ? value.disabledSkills.filter((item) => typeof item === "string") : [],
    };
  } catch {
    saved = { grants: [], projects: {}, skillFolders: [], disabledSkills: [] };
  }
  return saved;
}
async function persist() {
  if (!saved) return;
  await fs.writeFile(file(), JSON.stringify(saved, null, 2), { mode: 0o600 });
}

const granted = (state: Saved, target: string) => state.grants.some((grant) => within(grant, target));
const projectId = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid project");
  return value;
};

async function pick(event: IpcMainInvokeEvent, multiple: boolean, title: string) {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options: Electron.OpenDialogOptions = {
    title,
    properties: ["openDirectory", "createDirectory", ...(multiple ? (["multiSelections"] as const) : [])],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map((item) => fs.realpath(item)));
}

async function skillFolders(): Promise<SkillFolder[]> {
  const state = await load();
  return Promise.all(
    state.skillFolders.map(async (folder) => {
      try {
        const skills = await scanSkills(folder);
        return {
          path: folder,
          name: path.basename(folder),
          skills: skills.map((skill) => ({ ...skill, enabled: !state.disabledSkills.includes(skill.path) })),
        };
      } catch {
        return { path: folder, name: path.basename(folder), skills: [], error: "This folder is unavailable." };
      }
    })
  );
}

const ollamaApps = ["/Applications/Ollama.app", path.join(homedir(), "Applications/Ollama.app")];
const ollamaCommands = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/usr/bin/ollama"];
async function ollamaStatus(connection?: RuntimeConnection): Promise<OllamaStatus> {
  const installed = [...ollamaApps, ...ollamaCommands].some((item) => existsSync(item));
  try {
    const base = new URL(connection?.baseUrl ?? "http://127.0.0.1:11434/v1");
    base.pathname = base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    const response = await fetch(`${base.href.replace(/\/+$/, "")}/api/version`, { redirect: "error", signal: AbortSignal.timeout(1500) });
    const value = (await response.json()) as { version?: unknown };
    return { installed: true, running: response.ok, version: typeof value.version === "string" ? value.version : undefined };
  } catch {
    return { installed, running: false };
  }
}

/**
 * Projects from before the database: names and order from the renderer's localStorage, folder access from
 * workspace.json, which was the copy enforced here and so the newer one. Folders never granted are dropped.
 */
async function legacyProjects(renderer: StoredProject[]): Promise<StoredProject[]> {
  const state = await load();
  const keep = (policy: WorkspacePolicy | undefined) => {
    if (!policy) return undefined;
    const clean = sanitizePolicy(policy);
    const folders = clean.folders.filter((folder) => granted(state, folder.path));
    return folders.length ? { folders, rules: clean.rules.filter((rule) => folders.some((folder) => within(folder.path, rule.path))) } : undefined;
  };
  const projects = renderer
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({ ...item, access: keep(state.projects[item.id] ?? item.access) }));
  // A project the renderer lost still has its folders here; it comes back named after its first folder.
  for (const [id, policy] of Object.entries(state.projects)) {
    const access = keep(policy);
    if (access && !projects.some((item) => item.id === id)) projects.push({ id, name: folderName(access.folders[0].path), createdAt: Date.now(), access });
  }
  return projects;
}

/** A project's saved folder access, limited to folders the person chose in the native dialog. */
export async function projectPolicy(id: unknown): Promise<WorkspacePolicy | undefined> {
  const policy = typeof id === "string" ? (await history("project", id))?.access : undefined;
  if (!policy) return undefined;
  const state = await load();
  const folders = policy.folders.filter((folder) => granted(state, folder.path));
  return { folders, rules: policy.rules.filter((rule) => folders.some((folder) => within(folder.path, rule.path))) };
}

/**
 * Fills in folder access and skills from what is saved here. The renderer sends only a project ID; these
 * fields are removed first anyway, so a compromised renderer cannot grant itself folders or point the
 * worker at files to read as skills.
 */
export async function attachWorkspace(body: Record<string, unknown>) {
  delete body.workspace;
  delete body.skills;
  delete body.skillCatalog;
  delete body.projectInstructions;
  const policy = await projectPolicy(body.projectId);
  if (policy) body.workspace = policy;
  // What the person wrote for the project; the worker fits it to the model's window (harness/instructions).
  const instructions = typeof body.projectId === "string" ? (await history("project", body.projectId))?.instructions : undefined;
  if (instructions) body.projectInstructions = instructions;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = [...messages].reverse().find((message) => message?.role === "user");
  const text = Array.isArray(last?.parts)
    ? last.parts.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("\n")
    : "";
  const enabled = (await skillFolders()).flatMap((folder) => folder.skills.filter((skill) => skill.enabled));
  // Every request lists what is installed; named skills also come with their instructions.
  if (enabled.length) body.skillCatalog = enabled.map(({ name, description, path }) => ({ name, description, path }));
  const used = await Promise.all(mentionedSkills(text, enabled).slice(0, 3).map((skill) => readSkill(skill.path)));
  if (used.length) body.skills = used.map(({ name, description, content }) => ({ name, description, content }));
}

export function registerWorkspaceIPC(
  trusted: (event: IpcMainInvokeEvent | IpcMainEvent) => void,
  ollamaConnection: () => RuntimeConnection | undefined
) {
  ipcMain.handle("workspace:pick-folders", async (event, multiple: boolean) => {
    trusted(event);
    const paths = await pick(event, Boolean(multiple), "Add folders to project");
    if (!paths.length) return [];
    const state = await load();
    state.grants = [...new Set([...state.grants, ...paths])];
    await persist();
    return paths.map((item) => ({ path: item, name: path.basename(item) }));
  });
  ipcMain.handle("workspace:list", async (event, root: string, directory: string) => {
    trusted(event);
    const state = await load();
    if (typeof root !== "string" || typeof directory !== "string" || !state.grants.includes(root) || !within(root, directory))
      throw new Error("This folder is not part of a project.");
    // Settings show the real tree: access rules are applied by the tree, not by hiding rows here.
    const tools = new Workspace({ folders: [{ path: root, access: "read" }], rules: [] });
    const listed = await tools.list(directory);
    return { more: listed.more, entries: listed.entries.map((entry) => ({ ...entry, path: path.join(directory, entry.name) })) };
  });
  // @ mentions: names of files the agent could open in this project, as it accepts them (folder label/path).
  ipcMain.handle("workspace:mention-files", async (event, id: string, query: string) => {
    trusted(event);
    if (typeof query !== "string" || query.length > 200) throw new Error("Invalid search");
    const policy = await projectPolicy(projectId(id));
    if (!policy?.folders.length) return { files: [], more: false };
    return new Workspace(policy).files(query);
  });
  ipcMain.handle("projects:list", async (event, legacy?: StoredProject[]) => {
    trusted(event);
    if (await history("projectsImported")) return history("listProjects");
    const projects = await history("importProjects", await legacyProjects(Array.isArray(legacy) ? legacy : []));
    // Only after the import committed: the old copy is no longer read, and keeping it would mislead.
    const state = await load();
    state.projects = {};
    await persist();
    return projects;
  });
  ipcMain.handle("projects:save", async (event, project: StoredProject) => {
    trusted(event);
    const state = await load();
    projectId(project?.id);
    const access = project.access ? sanitizePolicy(project.access) : undefined;
    if (access?.folders.some((folder) => !granted(state, folder.path))) throw new Error("Choose project folders with Add folder.");
    return history("saveProject", { ...project, access });
  });
  ipcMain.handle("projects:remove", (event, id: string) => {
    trusted(event);
    return history("deleteProject", projectId(id));
  });
  ipcMain.handle("workspace:reveal", async (event, target: string) => {
    trusted(event);
    const state = await load();
    if (typeof target !== "string" || !granted(state, target)) throw new Error("Unknown folder");
    shell.showItemInFolder(target);
  });
  ipcMain.handle("skills:list", (event) => {
    trusted(event);
    return skillFolders();
  });
  ipcMain.handle("skills:add-folder", async (event) => {
    trusted(event);
    const [folder] = await pick(event, false, "Add skills folder");
    if (folder) {
      const state = await load();
      state.skillFolders = [...new Set([...state.skillFolders, folder])];
      await persist();
    }
    return skillFolders();
  });
  ipcMain.handle("skills:remove-folder", async (event, folder: string) => {
    trusted(event);
    const state = await load();
    state.skillFolders = state.skillFolders.filter((item) => item !== folder);
    state.disabledSkills = state.disabledSkills.filter((item) => !within(folder, item));
    await persist();
    return skillFolders();
  });
  ipcMain.handle("skills:set-enabled", async (event, skill: string, enabled: boolean) => {
    trusted(event);
    const state = await load();
    if (typeof skill !== "string" || !state.skillFolders.some((folder) => within(folder, skill))) throw new Error("Unknown skill");
    state.disabledSkills = enabled ? state.disabledSkills.filter((item) => item !== skill) : [...new Set([...state.disabledSkills, skill])];
    await persist();
    return skillFolders();
  });
  ipcMain.handle("skills:read", async (event, skill: string) => {
    trusted(event);
    const state = await load();
    if (typeof skill !== "string" || path.basename(skill) !== "SKILL.md" || !state.skillFolders.some((folder) => within(folder, skill)))
      throw new Error("Unknown skill");
    return (await readSkill(skill)).content;
  });
  ipcMain.handle("ollama:status", (event) => {
    trusted(event);
    return ollamaStatus(ollamaConnection());
  });
  ipcMain.handle("ollama:open", async (event) => {
    trusted(event);
    const connection = ollamaConnection();
    let status = await ollamaStatus(connection);
    if (status.running) return status;
    const application = ollamaApps.find((item) => existsSync(item));
    const command = ollamaCommands.find((item) => existsSync(item));
    if (application) await shell.openPath(application);
    else if (command) spawn(command, ["serve"], { detached: true, stdio: "ignore" }).unref();
    else return status;
    for (let attempt = 0; attempt < 20 && !status.running; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      status = await ollamaStatus(connection);
    }
    return status;
  });
}
