import { chatResponse, compactChat } from "../src/harness/chat";
import { titleChat } from "../src/harness/title";
import { agentResponse, usesAgent } from "../src/harness/agent";
import { resumeResponse } from "../src/harness/resume";
import { setVisibleChats } from "../src/harness/limit";
import { stopAllShells } from "../src/harness/shell";
import { setAttachmentFiles, type AttachmentAnswer, type AttachmentAsk } from "../src/harness/attachments";
import type { ChatEvent, CompactEvent, TitleEvent } from "../src/lib/desktop";
import { transcribeJob } from "../src/harness/transcribe";
import type { TranscribeEvent } from "../src/lib/voice-api";
import { fileUndoWorker } from "../src/harness/restore";

const active = new Map<string, AbortController>();
const send = (event: ChatEvent | CompactEvent | TitleEvent | AttachmentAsk | TranscribeEvent) => process.parentPort.postMessage(event);

// Attached documents are encrypted and only the main process holds the key, so this process asks it for them.
const asked = new Map<number, (answer: AttachmentAnswer) => void>();
let questions = 0;
async function ask(question: Omit<AttachmentAsk, "type" | "request">) {
  const request = ++questions;
  const answer = await new Promise<AttachmentAnswer>((resolve) => {
    asked.set(request, resolve);
    send({ ...question, type: "attachment", request } as AttachmentAsk);
  });
  if (!answer.ok) throw new Error(answer.error);
  return answer;
}
setAttachmentFiles({
  read: async (id) => (await ask({ op: "read", id })).bytes,
  readText: async (id, version) => (await ask({ op: "read-text", id, version })).text,
  writeText: async (id, version, text) => void (await ask({ op: "write-text", id, version, text })),
});
// Copies of files from before the agent's edits are kept the same way, and undoing those edits runs here.
const fileUndo = fileUndoWorker((message) => process.parentPort.postMessage(message));

process.on("SIGTERM", () => { stopAllShells(); process.exit(0); });

process.parentPort.on("message", async ({ data }: { data: { id: string; type: string; body?: string; ids?: string[] } | AttachmentAnswer }) => {
  if (data.type === "attachment") { const answer = data as AttachmentAnswer; asked.get(answer.request)?.(answer); asked.delete(answer.request); return; }
  if (fileUndo.handle(data)) return;
  // These two carry no chat ID.
  if (data.type === "visible") { setVisibleChats((data as { ids?: string[] }).ids ?? []); return; }
  // The app is quitting: running commands are detached, so they are ended here before this process goes.
  if (data.type === "shutdown") { stopAllShells(); process.exit(0); }
  if (!("id" in data)) return;
  if (data.type === "cancel") { active.get(data.id)?.abort(); return; }
  // Voice input: the recording goes to the chosen speech-to-text model (src/harness/transcribe).
  if (data.type === "transcribe" && !active.has(data.id)) {
    const controller = new AbortController();
    active.set(data.id, controller);
    try {
      send({ id: data.id, type: "transcribed", text: await transcribeJob(data.body ?? "{}", (data as { audio?: unknown }).audio, controller.signal) });
    } catch (error) {
      send({ id: data.id, type: "error", message: controller.signal.aborted ? "Cancelled" : error instanceof Error ? error.message : "Speech to text failed" });
    } finally { active.delete(data.id); }
    return;
  }
  // A chat's name from its own model (src/harness/title); a failure is no name, and the chat keeps its first-message title.
  if (data.type === "title" && !active.has(data.id)) {
    const controller = new AbortController();
    active.set(data.id, controller);
    try {
      send({ id: data.id, type: "titled", title: await titleChat(JSON.parse(data.body ?? "{}"), controller.signal) });
    } catch {
      send({ id: data.id, type: "titled" });
    } finally { active.delete(data.id); }
    return;
  }
  if (data.type === "compact" && !active.has(data.id)) {
    const controller = new AbortController();
    active.set(data.id, controller);
    try {
      send({ id: data.id, type: "compacted", result: await compactChat(JSON.parse(data.body ?? "{}"), controller.signal) });
    } catch (error) {
      send({ id: data.id, type: "error", message: controller.signal.aborted ? "Cancelled" : error instanceof Error ? error.message : "Compaction failed" });
    } finally { active.delete(data.id); }
    return;
  }
  if (data.type !== "chat" || active.has(data.id)) return;
  const controller = new AbortController();
  active.set(data.id, controller);
  try {
    const body = JSON.parse(data.body ?? "{}");
    const request = new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body), signal: controller.signal });
    // A chat with no model from a connected runtime is refused by validate(), with what to do.
    // An interrupted text reply goes on in place (src/harness/resume); everything else answers anew.
    const response = body.resume ? await resumeResponse(request) : usesAgent(body) ? await agentResponse(request) : await chatResponse(request);
    send({ id: data.id, type: "headers", status: response.status, headers: Object.fromEntries(response.headers) });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (reader) while (true) {
      const part = await reader.read();
      if (part.done) break;
      send({ id: data.id, type: "chunk", chunk: decoder.decode(part.value, { stream: true }) });
    }
    const last = decoder.decode();
    if (last) send({ id: data.id, type: "chunk", chunk: last });
    send({ id: data.id, type: "done" });
  } catch (error) {
    send({ id: data.id, type: "error", message: controller.signal.aborted ? "Cancelled" : error instanceof Error ? error.message : "Chat failed" });
  } finally { active.delete(data.id); }
});
