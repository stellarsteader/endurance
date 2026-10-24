"use client";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationSpacer,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { messageText } from "@/lib/derive";
import { getModel } from "@/lib/models";
import { readFailure, type FailureKind } from "@/lib/failure";
import { markNotChat } from "@/features/model-settings/preferences";
import { useStore } from "@/lib/store";
import type { AppUIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
  Volume2Icon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, useEffect } from "react";
import { SentAttachments } from "./attachment-preview";
import { FindBar } from "./find-bar";
import { ImageGallery } from "./image-viewer";
import { MessageParts } from "./message-parts";
import { useSession } from "./session-context";
import { RewindCheckpoint } from "./undo-edits";
import { Welcome } from "./welcome";

function IconButton({
  tooltip,
  children,
  ...props
}: ComponentProps<typeof Button> & { tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button aria-label={tooltip} className="text-muted-foreground" size="icon-sm" variant="ghost" {...props} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function BranchPicker() {
  return (
    <BranchPickerPrimitive.Root
      className="inline-flex items-center text-muted-foreground text-xs"
      hideWhenSingleBranch
    >
      <BranchPickerPrimitive.Previous asChild>
        <Button aria-label="Previous version" size="icon-xs" variant="ghost">
          <ChevronLeftIcon />
        </Button>
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <Button aria-label="Next version" size="icon-xs" variant="ghost">
          <ChevronRightIcon />
        </Button>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

function CopyAction() {
  return (
    <ActionBarPrimitive.Copy asChild>
      <IconButton tooltip="Copy">
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon />
        </AuiIf>
      </IconButton>
    </ActionBarPrimitive.Copy>
  );
}

function useUIMessage(): { message: AppUIMessage | undefined; index: number } {
  const { chat } = useSession();
  const id = useAuiState((s) => s.message.id);
  const index = chat.messages.findIndex((m) => m.id === id);
  return { message: chat.messages[index], index };
}

const renderUserText = (text: string): ReactNode =>
  text.split(/(@[\w./-]+)/g).map((chunk, i) =>
    chunk.startsWith("@") ? (
      <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[12px]" key={i}>
        {chunk}
      </code>
    ) : (
      <Fragment key={i}>{chunk}</Fragment>
    )
  );

function UserMessage() {
  const { message, index } = useUIMessage();
  if (!message) return null;
  const text = messageText(message);
  const files = message.parts.flatMap((p, i) => (p.type === "file" ? [{ ...p, id: `${message.id}-f${i}` }] : []));
  const images = files.filter((f) => f.mediaType.startsWith("image/")).map((f) => ({ id: f.id, url: f.url, name: f.filename }));
  const others = files.filter((f) => !f.mediaType.startsWith("image/"));

  return (
    <MessagePrimitive.Root className="flex flex-col gap-3" data-user-message="">
      {index > 0 && <RewindCheckpoint index={index} text={text} />}
      <Message data-message-id={message.id} from="user">
        {images.length > 0 && <ImageGallery className="ml-auto" images={images} />}
        {others.length > 0 && <SentAttachments files={others} />}
        {text && (
          <MessageContent className="rounded-[16px]! px-3.5! py-2!">
            <p className="whitespace-pre-wrap text-[15px] leading-[1.6]">{renderUserText(text)}</p>
          </MessageContent>
        )}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <BranchPicker />
          <ActionBarPrimitive.Root className="flex" hideWhenRunning>
            <ActionBarPrimitive.Edit asChild>
              <IconButton tooltip="Edit">
                <PencilIcon />
              </IconButton>
            </ActionBarPrimitive.Edit>
            <CopyAction />
          </ActionBarPrimitive.Root>
        </div>
      </Message>
    </MessagePrimitive.Root>
  );
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="ml-auto flex w-full max-w-[85%] flex-col gap-2 rounded-[16px] border bg-muted/40 p-3">
      <ComposerPrimitive.Input
        autoFocus
        className="min-h-16 w-full resize-none bg-transparent text-[15px] leading-[1.6] outline-none"
      />
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">Editing creates a new branch — the original stays available.</span>
        <div className="flex gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Send</Button>
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function AssistantFooter({ message, isLast }: { message: AppUIMessage; isLast: boolean }) {
  const { send } = useSession();
  const meta = message.metadata;
  const model = meta?.model ? getModel(meta.model) : undefined;
  const suggestions = message.parts.findLast((p) => p.type === "data-suggestions");

  return (
    <>
      <div className="flex flex-wrap items-center gap-0.5">
        {/* Always mounted at full size; earlier replies only fade it in, so hovering never moves the model label or the next message. */}
        <ActionBarPrimitive.Root
          autohide="never"
          className={cn(
            "flex items-center gap-0.5 transition-opacity duration-150 motion-reduce:transition-none",
            !isLast && "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
          )}
          hideWhenRunning
        >
          <CopyAction />
          <ActionBarPrimitive.Reload asChild>
            <IconButton tooltip="Regenerate">
              <RefreshCwIcon />
            </IconButton>
          </ActionBarPrimitive.Reload>
          <ActionBarPrimitive.FeedbackPositive asChild>
            <IconButton className="text-muted-foreground data-submitted:text-emerald-500" tooltip="Good response">
              <ThumbsUpIcon />
            </IconButton>
          </ActionBarPrimitive.FeedbackPositive>
          <ActionBarPrimitive.FeedbackNegative asChild>
            <IconButton className="text-muted-foreground data-submitted:text-red-500" tooltip="Bad response">
              <ThumbsDownIcon />
            </IconButton>
          </ActionBarPrimitive.FeedbackNegative>
          <AuiIf condition={(s) => s.message.speech == null}>
            <ActionBarPrimitive.Speak asChild>
              <IconButton tooltip="Read aloud">
                <Volume2Icon />
              </IconButton>
            </ActionBarPrimitive.Speak>
          </AuiIf>
          <AuiIf condition={(s) => s.message.speech != null}>
            <ActionBarPrimitive.StopSpeaking asChild>
              <IconButton tooltip="Stop reading">
                <SquareIcon />
              </IconButton>
            </ActionBarPrimitive.StopSpeaking>
          </AuiIf>
          <ActionBarPrimitive.ExportMarkdown asChild>
            <IconButton tooltip="Export as Markdown">
              <DownloadIcon />
            </IconButton>
          </ActionBarPrimitive.ExportMarkdown>
          <BranchPicker />
        </ActionBarPrimitive.Root>
        {model && (
          // Fades with the actions beside it, so an earlier reply shows nothing under it until it is hovered.
          <span
            className={cn(
              "ml-2 flex items-center gap-1.5 text-muted-foreground text-xs transition-opacity duration-150 motion-reduce:transition-none",
              !isLast && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            )}
          >
            <ModelSelectorLogo className="size-3" provider={model.provider} />
            {model.name}
            {meta?.durationMs && <span>· {(meta.durationMs / 1000).toFixed(1)}s</span>}
            {meta?.tps && <span>· {meta.tps} tok/s</span>}
          </span>
        )}
      </div>
      {isLast && suggestions && (
        <Suggestions className="mt-1">
          {suggestions.data.items.map((s) => (
            <Suggestion className="text-xs" key={s} onClick={(text) => send({ text })} suggestion={s} />
          ))}
        </Suggestions>
      )}
    </>
  );
}

function AssistantMessage() {
  const { chat } = useSession();
  const { message } = useUIMessage();
  const isLast = useAuiState((s) => s.message.isLast);
  if (!message) return null;
  const streaming = isLast && (chat.status === "streaming" || chat.status === "submitted");

  return (
    <MessagePrimitive.Root>
      <Message className="max-w-full" data-message-id={message.id} from="assistant">
        <MessageParts message={message} streaming={streaming} />
        {!streaming && <AssistantFooter isLast={isLast} message={message} />}
      </Message>
    </MessagePrimitive.Root>
  );
}

/** What each kind of failure is called, and where the fix is. */
const FAILURES: Record<FailureKind, { title: string; fix?: "models" | "picker" | "connections" }> = {
  unreachable: { title: "Can't reach the model's server", fix: "connections" },
  missing: { title: "The server doesn't have this model", fix: "picker" },
  memory: { title: "Not enough memory to load the model", fix: "models" },
  overflow: { title: "The conversation doesn't fit the context window", fix: "models" },
  tools: { title: "This server can't run tools for this model" },
  silent: { title: "The model stopped responding" },
  busy: { title: "The server is busy" },
  auth: { title: "The server refused the key", fix: "connections" },
  notChat: { title: "This model doesn't chat. It's now hidden from chat models; change that in Models settings", fix: "picker" },
  other: { title: "Request failed" },
};
const FIXES = { models: "Models settings", picker: "Choose another model", connections: "Connections" } as const;

function ErrorNotice() {
  const { chat, model } = useSession();
  const { setSettingsSection, setModelPickerOpen } = useStore();
  const kind = chat.error ? readFailure(chat.error.message).kind : undefined;
  // A model that refuses chat requests leaves the chat models, unless the person set it to chat.
  useEffect(() => {
    if (kind === "notChat") markNotChat(model);
  }, [kind, model]);
  if (!chat.error) return null;
  const failure = readFailure(chat.error.message);
  const { title, fix } = FAILURES[failure.kind];
  const act = () => {
    if (fix === "picker") setModelPickerOpen(true);
    else if (fix) setSettingsSection(fix);
  };
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm" role="alert">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-red-500" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="break-words text-muted-foreground">{failure.message}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {fix && (
          <Button onClick={act} size="sm" variant="ghost">
            {FIXES[fix]}
          </Button>
        )}
        <Button
          onClick={() => {
            chat.clearError();
            chat.regenerate();
          }}
          size="sm"
          variant="outline"
        >
          <RotateCcwIcon /> Retry
        </Button>
      </div>
    </div>
  );
}

export function ThreadView({ empty, compact = false }: { empty?: ReactNode; compact?: boolean }) {
  const { chat } = useSession();
  const last = chat.messages.at(-1);

  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent
        className={cn("mx-auto w-full max-w-(--chat-width) gap-6 pt-6 pb-10", compact ? "px-4" : "px-6")}
      >
        {chat.messages.length === 0 ? (
          (empty ?? <Welcome />)
        ) : (
          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.composer?.isEditing ? (
                <EditComposer />
              ) : message.role === "user" ? (
                <UserMessage />
              ) : (
                <AssistantMessage />
              )
            }
          </ThreadPrimitive.Messages>
        )}
        {chat.status === "submitted" && last?.role === "user" && (
          <Shimmer className="text-sm" duration={1.2}>
            Thinking…
          </Shimmer>
        )}
        <ErrorNotice />
        <ConversationSpacer />
      </ConversationContent>
      {/* Centred over the message column, above the composer, not on the pane's edge over the scrollbar. */}
      <ConversationScrollButton className="bottom-3" />
      <FindBar />
    </Conversation>
  );
}
