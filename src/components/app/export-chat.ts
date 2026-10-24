import { chatJSON, chatMarkdown, exportFilename, type ChatExportFormat } from "@/lib/chat-export";
import { ipcMessage } from "@/lib/desktop";
import { getModel } from "@/lib/models";
import type { Thread } from "@/lib/store";
import { toast } from "sonner";

/** Exporting needs the desktop app, which saves the file; elsewhere the control is not shown. */
export const canExportChat = () => typeof window !== "undefined" && !!window.endurance?.exportChat;

/**
 * Saves a whole chat as a file where the person chooses (lib/chat-export). A saved chat not opened yet is read
 * from the vault first, without opening it. The copy is not encrypted, and the toast says so.
 */
export async function exportChat(thread: Thread, format: ChatExportFormat) {
  const desktop = window.endurance;
  if (!desktop) return;
  try {
    const messages = thread.loaded === false && window.enduranceHistory ? await window.enduranceHistory.messages(thread.id) : thread.messages;
    // A model no longer listed is still named from its ID; one that cannot be read is written as stored.
    const modelName = (id: string) => (getModel(id).id ? getModel(id).name : id);
    const text = format === "markdown" ? chatMarkdown(thread.title, messages, { modelName }) : chatJSON(thread.title, messages);
    const result = await desktop.exportChat(exportFilename(thread.title, format), format, text);
    if (result === "saved") toast("Exported. This copy isn't encrypted.");
  } catch (error) {
    toast.error("Couldn't export the chat", { description: error instanceof Error ? ipcMessage(error) : String(error) });
  }
}
