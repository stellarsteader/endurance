/**
 * Each chat runs on its own model and effort. A chat that was never given a model follows the model its replies
 * came from, so older chats keep theirs; a new chat starts with the model chosen last anywhere. An effort is kept
 * only when the person chose it in that chat, for that model; otherwise the model's thinking default applies,
 * so changing that default in Models settings reaches every chat that did not choose for itself.
 */
import type { AppUIMessage, ChatChoice } from "./types";

const replyModel = (messages: readonly AppUIMessage[]) => messages.findLast((message) => message.role === "assistant" && message.metadata?.model)?.metadata?.model;

export function chatModelId(chat: { choice?: ChatChoice; messages: readonly AppUIMessage[]; replyModel?: string }, latest: string) {
  return chat.choice?.model ?? replyModel(chat.messages) ?? chat.replyModel ?? latest;
}

/** The chat's choice after the person picks: another model drops an effort chosen for the previous one, not the approval mode. */
export function nextChoice(current: ChatChoice, patch: ChatChoice): ChatChoice {
  const approval = patch.approval ?? current.approval;
  if (patch.model && patch.model !== current.model)
    return { model: patch.model, ...(patch.effort ? { effort: patch.effort } : {}), ...(approval ? { approval } : {}) };
  return { ...current, ...patch };
}
