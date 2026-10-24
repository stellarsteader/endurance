import { createUIMessageStream, createUIMessageStreamResponse, type FinishReason } from "ai";
import { Layer } from "effect";
import { LLMClient } from "./vendor/llm/route/client";
import { RequestExecutor } from "./vendor/llm/route/executor";
import { Auth } from "./vendor/llm/route/auth";
import { OpenAICompatibleChat } from "./vendor/llm/protocols/openai-compatible-chat";
import { Ollama } from "./vendor/schema/ollama";
import { OllamaChat } from "./ollama-chat";
import { Message, type ContentPart, type LLMEvent } from "./vendor/llm/schema";
import { endpoint } from "./runtime";
import { carryCounts, compactHistory, summaryMessage } from "./compaction";
import { skillCatalog, type SkillEntry } from "./skills";
import { streamReply } from "./reply";
import { thinkingRequest } from "./thinking";
import { measure, modelProfile, recheckWindow, windowFromError, withLiveWindow } from "./profile/models";
import { budgetFor, isEstimatedPrompt } from "./budget";
import { hasLarge } from "./documents";
import { hasAttachments, type Reader } from "./attachments";
import { attachmentId, documentFormat, imageFormat, SENT_IMAGE_FORMATS } from "../lib/attachments";
import { tuned } from "./sampling";
import { describeFailure } from "./failure";
import { runAs } from "./limit";
import type { AppUIMessage, Approval, ChatSettings, Usage } from "../lib/types";
import type { CompactResult } from "../lib/desktop";
import { estimateText } from "../lib/token-estimate";
import { fitInstructions } from "./instructions";
import { breakdownOf } from "./breakdown";
import type { CallInfo } from "./guarded";
import type { ThinkingSwitchChoice } from "../lib/thinking-switch";
import type { SamplingSets } from "../lib/sampling";
import { runtimeName, type RuntimeConnection, type RuntimeId, type ServerLocation } from "../lib/models";

export interface ChatRequest extends Omit<ChatSettings, "defaultApproval"> {
  /** The chat's ID; a side chat has its own. Requests for the chat on screen go first (see ./limit). */
  id?: string;
  /** This chat's approval mode. */
  approval: Approval;
  messages: AppUIMessage[];
  runtime: RuntimeId;
  runtimeModelId: string;
  connection: RuntimeConnection;
  reasoningSupported?: boolean;
  /** Per-model preference from Models settings. False sends reasoning effort "none". */
  thinking?: boolean;
  /** False when the model reports no image input. Unknown is treated as supported. */
  visionSupported?: boolean;
  /** Tokens the runtime loads the model with, used to compact long conversations. */
  contextWindow?: number;
  /** Display name from Models settings, so the model can say what it is. */
  modelName?: string;
  /** Set by the main process from the saved connection; the renderer only names the connection. */
  connectionId?: string;
  location?: ServerLocation;
  host?: string;
  /**
   * The window the person set in Models settings, for runtimes that do not store one with the model: LM Studio
   * loads the model at it first; vLLM and other servers fill no more than it of the window they serve.
   */
  contextLimit?: number;
  /** For a template runtime: the person's choice of thinking variable in Models settings; unset means automatic. */
  thinkingSwitch?: ThinkingSwitchChoice;
  /** What the person set for this model's sampling in Models settings (lib/sampling); unset is the model's own. */
  sampling?: SamplingSets;
  /** The model that reads pages that are images in attached documents, with its connection set by the main process. */
  reader?: Reader;
  /** Enabled skills from Library, set by the main process. Paths stay in the harness. */
  skillCatalog?: SkillEntry[];
  /** What the person wrote for the chat's project, set by the main process (./instructions). */
  projectInstructions?: string;
  /** Go on writing the last reply, which was interrupted, instead of answering anew (./resume). */
  resume?: boolean;
  /** The chat's project, by name; the renderer sends it with the project's ID. */
  projectName?: string;
}

/**
 * What a plain chat cannot do, said as facts. A chat with no project folders, no Internet Access
 * and nothing attached gets no tools; a model not told so answers a question about files as a model with no file
 * access at all ("as a local model I cannot…"), instead of saying what the person can change. Small models follow a
 * stated fact better than a condition, and the text is the same on every request, so the prompt stays cached.
 */
export function plainChatNote(body: Pick<ChatRequest, "projectName">) {
  const where = body.projectName ? `This chat is in the project "${body.projectName}", which has no folders.` : "This chat is not in a project.";
  return (
    `${where} So in this chat you have no tools: you cannot list, search or read files, run commands or use the internet. ` +
    "The user can choose a project with folders, attach files to a message, or turn on Internet Access."
  );
}

/** The text of the latest user message, which decides which skills are listed first. */
/**
 * Two calls of one reply, as when an answer that filled the window went on in another call. What the reply took adds
 * up; the window is what the later call saw; and since neither call wrote the whole reply, its own count is unknown.
 */
/** The answer's usage with the summaries made for it added to its totals; the window stays the answer's. */
const withSide = (answer: Usage, side: Usage): Usage => ({
  ...answer,
  input: answer.input + side.input,
  output: answer.output + side.output,
  reasoning: answer.reasoning + side.reasoning,
  cached: answer.cached + side.cached,
  calls: (answer.calls ?? 1) + (side.calls ?? 0),
  ...(answer.decodeMs || side.decodeMs ? { decodeMs: (answer.decodeMs ?? 0) + (side.decodeMs ?? 0) } : {}),
});

function joinUsage(a: Usage, b: Usage): Usage {
  const decodeMs = (a.decodeMs ?? 0) + (b.decodeMs ?? 0);
  const { reply: _reply, first: _first, ...later } = b;
  void _reply;
  void _first;
  return {
    ...later,
    // The first call's count stays the turn's own; the later call's prompt held the answer written so far.
    ...(a.first !== undefined ? { first: a.first } : {}),
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cached: a.cached + b.cached,
    calls: (a.calls ?? 1) + (b.calls ?? 1),
    ...(decodeMs ? { decodeMs } : {}),
    ...(a.estimated || b.estimated ? { estimated: true } : {}),
  };
}

/**
 * A call made for a reply besides its answer, such as a summary: what it took adds to the reply's totals, while the
 * window and the reply's own count stay those of the answer's calls.
 */
export function addSideUsage(total: Usage, usage: Extract<LLMEvent, { type: "finish" }>["usage"], call?: CallInfo) {
  if (!usage) return;
  total.input += usage.inputTokens ?? 0;
  total.reasoning += usage.reasoningTokens ?? 0;
  total.output += Math.max(0, (usage.outputTokens ?? 0) - (usage.reasoningTokens ?? 0));
  total.cached += usage.cacheReadInputTokens ?? 0;
  total.calls = (total.calls ?? 0) + 1;
  if (call?.decodeMs) total.decodeMs = (total.decodeMs ?? 0) + call.decodeMs;
}

/** A single-call turn: its prompt and visible reply are what now fills the window. */
export function turnUsage(usage: Extract<LLMEvent, { type: "finish" }>["usage"], window?: number, call?: CallInfo): Usage {
  const output = Math.max(0, (usage?.outputTokens ?? 0) - (usage?.reasoningTokens ?? 0));
  const input = usage?.inputTokens ?? 0;
  // The reply's own count, only when neither thinking nor tool arguments are folded into it (see Usage.reply).
  const exact = !!call && usage?.outputTokens !== undefined && (usage.reasoningTokens !== undefined || !call.thought) && !call.tools;
  return {
    input,
    output,
    reasoning: usage?.reasoningTokens ?? 0,
    cached: usage?.cacheReadInputTokens ?? 0,
    context: input + output,
    calls: 1,
    ...(usage?.inputTokens !== undefined && !isEstimatedPrompt(usage) ? { first: usage.inputTokens } : {}),
    ...(exact ? { reply: output } : {}),
    ...(call?.decodeMs ? { decodeMs: call.decodeMs } : {}),
    ...(window ? { window } : {}),
    ...(isEstimatedPrompt(usage) ? { estimated: true } : {}),
  };
}

export function requestText(messages: AppUIMessage[]) {
  const last = messages.findLast((message) => message.role === "user");
  return last?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
}
/** Without a system prompt small models often claim to be a well-known cloud model. */
export function identity(body: ChatRequest) {
  const name = typeof body.modelName === "string" && body.modelName.trim() ? body.modelName.trim().slice(0, 80) : body.runtimeModelId;
  const server = runtimeName(body.runtime);
  const host = typeof body.host === "string" && body.host ? body.host.slice(0, 120) : "another machine";
  // Only a loopback address is this computer; anything else names the host it actually runs on.
  if (body.location === "remote") return `You are ${name}, a model (${body.runtimeModelId}) served by ${server} on the remote host ${host}, used through the Endurance app.`;
  if (body.location === "network") return `You are ${name}, a model (${body.runtimeModelId}) served by ${server} on ${host} in the local network, used through the Endurance app.`;
  return `You are ${name}, a local model (${body.runtimeModelId}) running on this computer through ${server} in the Endurance app.`;
}
export const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer));
export function validate(body: ChatRequest) {
  if (!Array.isArray(body.messages) || typeof body.runtimeModelId !== "string" || !body.runtimeModelId) throw new Error("Choose a model from a connected local runtime.");
}
/** Ollama is called on its own /api/chat (see ./ollama-chat); every other runtime on its OpenAI-compatible API. */
export function modelFor(body: ChatRequest) {
  const base = endpoint(body.connection);
  const query = body.connection.query ? Object.fromEntries(new URLSearchParams(body.connection.query)) : undefined;
  const settings = { provider: body.runtime, auth: body.connection.apiKey ? Auth.bearer(body.connection.apiKey) : Auth.none, ...(body.connection.headers ? { headers: body.connection.headers } : {}) };
  const where = (baseURL: string) => ({ endpoint: { baseURL, ...(query ? { query } : {}) } });
  const route = body.runtime === "ollama" ? OllamaChat.route.with({ ...settings, ...where(Ollama.baseURL(base)) }) : OpenAICompatibleChat.route.with({ ...settings, ...where(base) });
  return route.model({ id: body.runtimeModelId });
}
/** Thinking turned off for this model: in Models settings, or with Off in the effort menu. */
export const thinkingOff = (body: Pick<ChatRequest, "thinking" | "effort">) => body.thinking === false || body.effort === "none";

export function reasoningOptions(body: ChatRequest, enabled = true) {
  if (!body.reasoningSupported) return undefined;
  if (!enabled || thinkingOff(body)) return { openai: { reasoningEffort: "none" as const } };
  return body.effort ? { openai: { reasoningEffort: body.effort } } : undefined;
}
type Part = AppUIMessage["parts"][number];
type FilePart = Extract<Part, { type: "file" }>;
const isImage = (part: Part): part is FilePart => part.type === "file" && part.mediaType.startsWith("image/");

/** Which of its message's images a note stands for, so a note left alone still says which one it was. */
function imageLabel(images: FilePart[], part: FilePart) {
  const name = part.filename ? ` (${part.filename})` : "";
  return images.length > 1 ? `Image ${images.indexOf(part) + 1} of ${images.length}${name}` : `An image${name}`;
}

/**
 * Whether an image's bytes are a format runtimes take as image input. Images are made ready when they are sent
 * (lib/prepare-image); one kept from before that, in another format, would be refused by the runtime on every
 * later request of the chat, so it goes as a note instead.
 */
function sendable(url: string) {
  const base64 = url.slice(url.indexOf(",") + 1, url.indexOf(",") + 1 + 1368);
  const format = imageFormat(new Uint8Array(Buffer.from(base64, "base64")));
  return Boolean(format && SENT_IMAGE_FORMATS.has(format));
}

/**
 * Whether a refused request was about images while the newest message has some, so it can go once more without
 * them. Runtimes do not say which image they could not take; the newest are the likeliest, as images kept from
 * earlier requests already went through.
 */
export function imageRejected(error: unknown, messages: AppUIMessage[]) {
  if (!messages.findLast((message) => message.role === "user")?.parts.some(isImage)) return false;
  return /\b(image|images|media|vision|multimodal)\b/i.test(error instanceof Error ? error.message : String(error));
}

/** Shown to the person when the newest message went once more without its images. */
export const IMAGES_LEFT_OUT = "The model couldn't process the image, so this reply was written without it.";

/** The conversation with the newest message's images replaced by notes, for sending once more after a refusal. */
export function withoutNewImages(messages: AppUIMessage[]): AppUIMessage[] {
  const last = messages.findLastIndex((message) => message.role === "user");
  return messages.map((message, index) => {
    if (index !== last) return message;
    const images = message.parts.filter(isImage);
    const parts = message.parts.map((part): Part => (isImage(part) ? { type: "text", text: `[${imageLabel(images, part)} could not be processed, so its content is not included.]` } : part));
    return { ...message, parts };
  });
}

/**
 * Whether the model sees this chat's images, as one fact, for the model that runs this request (so it holds after a
 * switch). The messages carry the rest: a list of each message's images, or a note where each one was. Nothing is
 * said when the chat has no images.
 */
export function imageNote(body: Pick<ChatRequest, "messages" | "visionSupported">) {
  if (!body.messages.some((message) => message.parts.some(isImage))) return "";
  return body.visionSupported !== false
    ? "You can see images: those the user attaches are sent to you with their messages."
    : "You cannot see images: this model does not take image input, so images in this chat are not sent to you.";
}

export function toMessages(input: AppUIMessage[], options: { vision?: boolean } = {}) {
  const last = input.findLastIndex((message) => message.role === "user");
  return input.map((message, index) => {
    const images = message.parts.filter(isImage);
    // The images that go as image input, in order, for the line that lists them.
    const sent: FilePart[] = [];
    const content: ContentPart[] = message.parts.flatMap((part): ContentPart[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      // An attached document is read into text before the conversation is built (./attachments); here it is only checked.
      if (part.type === "file" && attachmentId(part.url)) {
        if (!documentFormat(part.mediaType, part.filename)) throw new Error(`${part.filename ?? "The attachment"} can't be read. Attach PDF, Word, Excel, CSV or text files.`);
        return [];
      }
      if (part.type.startsWith("tool-")) throw new Error("This chat has tool results from the app's earlier demo. Start a new chat.");
      if (part.type !== "file") return [];
      if (part.mediaType.startsWith("image/")) {
        if (!part.url.startsWith("data:")) throw new Error(`${part.filename ?? "An image"} could not be read. Attach it again.`);
        if (options.vision !== false) {
          if (!sendable(part.url)) return [{ type: "text", text: `[${imageLabel(images, part)} is in a format that can't be sent as image input, so its content is not included.]` }];
          sent.push(part);
          return [{ type: "media", mediaType: part.mediaType, data: part.url, filename: part.filename }];
        }
        // After switching to a text-only model, earlier images stay in the chat but are not sent.
        if (index === last) throw new Error("This model doesn't take image input. Switch to a model with image input to ask about images.");
        return [{ type: "text", text: `[${imageLabel(images, part)} was shared here; this model cannot see it.]` }];
      }
      if (part.mediaType.startsWith("text/") && part.url.startsWith("data:")) {
        const match = /^data:[^,]*;base64,(.*)$/.exec(part.url);
        if (!match) throw new Error("Unsupported text attachment encoding.");
        return [{ type: "text", text: `[${part.filename ?? "Attachment"}]\n${Buffer.from(match[1], "base64").toString("utf8")}` }];
      }
      // The composer refuses other formats; one already in the chat stands as a note, so the chat can go on.
      return [{ type: "text", text: `[${part.filename ?? "A file"} (${part.mediaType || "unknown type"}) was attached; this format can't be read, so its content is not included.]` }];
    });
    // Ollama sends a message's text as one string and its images apart, so what is sent is said once, up front, in
    // the order the images go. It speaks of image input, so it does not read like the note left for an image not sent.
    if (sent.length) {
      const names = sent.map((image) => image.filename ?? `image ${images.indexOf(image) + 1}`);
      const list = sent.length > 1 ? `${sent.length} images as image input, in order: ${names.join(", ")}` : `1 image as image input${sent[0].filename ? `: ${sent[0].filename}` : ""}`;
      content.unshift({ type: "text", text: `[This message includes ${list}.]` });
    }
    if (message.role === "user" && typeof message.metadata?.note === "string") content.push({ type: "text", text: `[Note from the app: ${message.metadata.note}]` });
    return Message.make({ id: message.id, role: message.role, content });
  });
}
export async function chatResponse(request: Request) {
  const raw = await request.json() as ChatRequest;
  validate(raw);
  // Converting first reports unsupported history (old demo tool results, images for a text-only model) before streaming.
  toMessages(raw.messages, { vision: raw.visionSupported });
  // Attached documents and text too long to send whole are read by the agent, which can read them in pieces.
  const window = hasAttachments(raw.messages) ? undefined : ((await modelProfile(raw)).window ?? raw.contextWindow);
  if (hasAttachments(raw.messages) || hasLarge(raw.messages, budgetFor(window, undefined, false))) {
    const { agentResponse } = await import("./agent");
    return agentResponse(new Request(request.url, { method: "POST", body: JSON.stringify(raw), signal: request.signal }));
  }
  const started = Date.now();
  let finishReason: FinishReason = "stop";
  // Every call of the reply: one usually, more when an answer that filled the window went on in another call.
  const reported: { usage: NonNullable<Extract<LLMEvent, { type: "finish" }>["usage"]>; call?: CallInfo }[] = [];
  // Summaries made for this reply, counted in what it took.
  const side: Usage = { input: 0, output: 0, reasoning: 0, cached: 0 };
  const stream = createUIMessageStream<AppUIMessage>({
    originalMessages: raw.messages,
    onError: describeFailure,
    execute: ({ writer }) =>
      runAs({ chat: raw.id, kind: "chat" }, async () => {
      writer.write({ type: "start", messageMetadata: { model: raw.model, createdAt: started } });
      // The window the runtime holds now, loading the model first when only loading tells it.
      const body = await withLiveWindow(
        raw,
        () => writer.write({ type: "data-status", data: { state: "loading" }, transient: true }),
        (window) => writer.write({ type: "data-window", data: { window }, transient: true }),
      );
      const model = modelFor(body);
      // A plain chat cannot load a skill itself: naming one sends the request through the agent, which can.
      const skills = skillCatalog(
        body.skillCatalog,
        requestText(body.messages),
        body.contextWindow,
        "A skill is used when the user names it in a message. When asked which skills are installed, list these."
      );
      const instructions = fitInstructions(body.projectInstructions, body.contextWindow);
      if (instructions.cut) writer.write({ type: "data-instructions", data: instructions.cut });
      const system = [identity(body), instructions.text, plainChatNote(body), imageNote(body), skills].filter(Boolean).join("\n\n");
      // What the request sent, for the context meter's parts (./breakdown).
      let sent: { messages: Message[]; summary?: Message } = { messages: [] };
      const send = async (window: number | undefined) => {
        // Summarized only when the conversation and the room this model's answers take would not fit.
        const fitted = { ...body, contextWindow: window };
        const thinks = Boolean(body.reasoningSupported) && !thinkingOff(body);
        const { budget, ratio } = await measure(fitted, system, [], thinks);
        // A summary thinks as the chat does, within the output every call of this model keeps free.
        const compact = async (extra: number) => compactHistory({ messages: body.messages, contextWindow: budget.window || window, system: estimateText(system) + extra, reserve: budget.reserve, model, layer, signal: request.signal, writer, thinking: await thinkingRequest(body, thinks), thinks, ratio, connection: body.connection, tune: (maxTokens) => tuned(body, thinks, { maxTokens }), onUsage: (usage, call) => addSideUsage(side, usage, call) });
        const conversation = (history: Awaited<ReturnType<typeof compact>>) => {
          const sent = [...(history.summary ? [summaryMessage(history.summary)] : []), ...toMessages(history.rest, { vision: body.visionSupported })];
          carryCounts(sent, body.messages);
          return sent;
        };
        const history = await compact(0);
        // Older turns are summarized at most once per request, so a summary is never summarized again.
        let compacted = Boolean(history.data);
        const messages = conversation(history);
        sent = { messages, summary: history.summary ? messages[0] : undefined };
        return streamReply({
          body: fitted, system, messages, writer, signal: request.signal,
          onUsage: (usage, call) => { if (usage) reported.push({ usage, call }); },
          rejectToolCalls: "Tool execution has not been connected to the local harness yet.",
          // An answer that filled the window needs room beside the conversation to go on.
          makeRoom: async (answer) => {
            if (compacted) return undefined;
            compacted = true;
            const more = await compact(answer);
            return more.data ? conversation(more) : undefined;
          },
        });
      };
      let window = body.contextWindow;
      const attempt = async () => {
        try {
          return await send(window);
        } catch (error) {
          // The runtime named a smaller window before anything was written: ask it again, so the menu, the meter
          // and the request all follow one window, fit the request to that and send it again.
          const named = windowFromError(error instanceof Error ? error.message : String(error));
          if (!named || request.signal.aborted) throw error;
          const fit = await recheckWindow(body, named);
          window = fit.window;
          writer.write({ type: "data-fit", data: fit });
          return await send(window);
        }
      };
      try {
        finishReason = await attempt();
      } catch (error) {
        // The runtime could not take an image: the newest message goes once more with notes in its images' place.
        if (request.signal.aborted || !imageRejected(error, body.messages)) throw error;
        body.messages = withoutNewImages(body.messages);
        writer.write({ type: "data-toast", data: { message: IMAGES_LEFT_OUT }, transient: true });
        finishReason = await attempt();
      }
      const answered = reported.length ? reported.map((item) => turnUsage(item.usage, window, item.call)).reduce(joinUsage) : undefined;
      const usage = answered && side.calls ? withSide(answered, side) : answered;
      const breakdown = breakdownOf({ system: [identity(body), plainChatNote(body), imageNote(body)].filter(Boolean).join("\n\n"), instructions: instructions.text, skills }, 0, sent.messages, sent.messages.length, sent.summary);
      if (usage?.output) breakdown.reply = usage.output;
      writer.write({ type: "finish", finishReason, messageMetadata: { model: body.model, durationMs: Date.now() - started, usage, breakdown } });
    }),
  });
  return createUIMessageStreamResponse({ stream });
}
/**
 * /compact: summarizes everything before the latest turn now, with the same summarizer automatic compaction
 * uses. The renderer stores the returned part on the conversation, so later requests reuse the summary.
 */
export async function compactChat(raw: ChatRequest, signal: AbortSignal): Promise<CompactResult> {
  validate(raw);
  const body = await withLiveWindow(raw);
  const thinks = Boolean(body.reasoningSupported) && !thinkingOff(body);
  const thinking = await thinkingRequest(body, thinks);
  const { budget, ratio } = await measure(body, identity(body), [], thinks);
  // Asked for in the chat, so it waits in line as that chat. What it took is kept with the summary (CompactionData.usage).
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cached: 0 };
  const result = await runAs({ chat: raw.id, kind: "chat" }, () => compactHistory({
    messages: body.messages,
    contextWindow: body.contextWindow,
    // The same estimate before and after, so the saving shown is the history's own.
    system: estimateText(identity(body)),
    model: modelFor(body),
    layer,
    signal,
    force: true,
    thinking,
    thinks,
    ratio,
    reserve: budget.reserve,
    connection: body.connection,
    tune: (maxTokens) => tuned(body, thinks, { maxTokens }),
    onUsage: (reported, call) => addSideUsage(usage, reported, call),
  }));
  return result.data ? { data: { ...result.data, ...(usage.calls ? { usage } : {}) } } : { skipped: result.skipped === "failed" ? "failed" : "short" };
}
