import { contextBridge, ipcRenderer } from "electron";
import type { WorkspaceAPI } from "../src/lib/workspace-api";

export function installWorkspaceBridge() {
  const api: WorkspaceAPI = {
    pickFolders: (multiple) => ipcRenderer.invoke("workspace:pick-folders", multiple),
    listFolder: (root, directory) => ipcRenderer.invoke("workspace:list", root, directory),
    mentionFiles: (projectId, query) => ipcRenderer.invoke("workspace:mention-files", projectId, query),
    projects: (legacy) => ipcRenderer.invoke("projects:list", legacy),
    saveProject: (project) => ipcRenderer.invoke("projects:save", project),
    removeProject: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
    revealFolder: (path) => ipcRenderer.invoke("workspace:reveal", path),
    skills: () => ipcRenderer.invoke("skills:list"),
    addSkillFolder: () => ipcRenderer.invoke("skills:add-folder"),
    removeSkillFolder: (path) => ipcRenderer.invoke("skills:remove-folder", path),
    setSkillEnabled: (path, enabled) => ipcRenderer.invoke("skills:set-enabled", path, enabled),
    readSkill: (path) => ipcRenderer.invoke("skills:read", path),
    ollamaStatus: () => ipcRenderer.invoke("ollama:status"),
    openOllama: () => ipcRenderer.invoke("ollama:open"),
  };
  contextBridge.exposeInMainWorld("enduranceWorkspace", api);
}
