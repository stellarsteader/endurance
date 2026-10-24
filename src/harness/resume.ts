/**
 * Continuing an interrupted reply in the same reply. The reply was only text, so the answer so far
 * goes back as the last assistant message and the runtime goes on writing it (./continuation), as when an answer
 * fills the window. What comes back is added to the same message on screen. A reply that used tools or the agent is
 * not continued here: its run state is gone, so it goes on in a new turn instead (lib/interrupted).
 */
import { createUIMessageStream, createUIMessageStreamResponse, type FinishReason } from "ai";
import type { LLMEvent } from "./vendor/llm/schema";
import { identity, imageNote, plainChatNote, toMessages, turnUsage, validate, type ChatRequest } from "./chat";
import { continueAnswer } from "./continuation";
import type { CallInfo } from "./guarded";
import { describeFailure } from "./failure";
import { fitInstructions } from "./instructions";
import { runAs } from "./limit";
import { withLiveWindow } from "./profile/models";
import type { AppUIMessage } from "../lib/types";

export async function resumeResponse(request: Request) {
  const raw = (await request.json()) as ChatRequest;
  validate(raw);
  const last = raw.messages.at(-1);
  if (last?.role !== "assistant") throw new Error("There is no reply to continue.");
  const answer = last.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const before = raw.messages.slice(0, -1);
  // Unsupported history is reported before streaming, as for any request.
  toMessages(before, { vision: raw.visionSupported });
  const started = Date.now();
  let usage: Extract<LLMEvent, { type: "finish" }>["usage"];
  let call: CallInfo | undefined;
  const stream = createUIMessageStream<AppUIMessage>({
    originalMessages: raw.messages,
    onError: describeFailure,
    execute: ({ writer }) =>
      runAs({ chat: raw.id, kind: "chat" }, async () => {
        writer.write({ type: "start", messageId: last.id, messageMetadata: { model: raw.model, createdAt: last.metadata?.createdAt ?? started } });
        const body = await withLiveWindow(
          raw,
          () => writer.write({ type: "data-status", data: { state: "loading" }, transient: true }),
          (window) => writer.write({ type: "data-window", data: { window }, transient: true }),
        );
        // The plain chat's own prompt, less the skills list: the answer goes on as it was being written.
        const system = [identity(body), fitInstructions(body.projectInstructions, body.contextWindow).text, plainChatNote(body), imageNote(body)].filter(Boolean).join("\n\n");
        const id = `text-${crypto.randomUUID()}`;
        let open = false;
        const end = await continueAnswer({
          body,
          system,
          messages: toMessages(before, { vision: body.visionSupported }),
          answer,
          signal: request.signal,
          onText: (delta) => {
            if (!open) writer.write({ type: "text-start", id });
            open = true;
            writer.write({ type: "text-delta", id, delta });
          },
          onUsage: (reported, info) => {
            usage = reported;
            call = info;
          },
          // The conversation already fit when the reply started; it is not summarized again to go on.
          makeRoom: async () => undefined,
        });
        if (open) writer.write({ type: "text-end", id });
        // Out of room: the reply ends here, with the note that offers a new turn.
        if (end.full) writer.write({ type: "data-loop", data: { part: "text", reason: "limit" } });
        const finishReason: FinishReason = end.finishReason;
        // The count covers only the part written now, not the whole reply in the window, so it is not the reply's own.
        const counted = usage ? { ...turnUsage(usage, body.contextWindow, call), reply: undefined } : undefined;
        writer.write({ type: "finish", finishReason, messageMetadata: { model: raw.model, durationMs: Date.now() - started, usage: counted } });
      }),
  });
  return createUIMessageStreamResponse({ stream });
}
