import { contextBridge, ipcRenderer } from "electron";
import type { VoiceAPI } from "../src/lib/voice-api";

export function installVoiceBridge() {
  const api: VoiceAPI = {
    transcribe: (id, choice, audio) => ipcRenderer.invoke("voice:transcribe", id, choice, audio),
    cancelTranscription: (id) => ipcRenderer.send("voice:cancel", id),
  };
  contextBridge.exposeInMainWorld("enduranceVoice", api);
}
