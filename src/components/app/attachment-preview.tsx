"use client";

import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/features/model-settings/download-progress";
import { attachmentId, documentFormat } from "@/lib/attachments";
import { ipcMessage } from "@/lib/desktop";
import { CheckIcon, CopyIcon, DownloadIcon, FileXIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { FileUIPart } from "ai";
import type { PDFDocumentProxy as PdfDocument } from "unpdf/pdfjs";
import { ImageViewer } from "./image-viewer";

/** A document sent with a message, kept by the app under `id` (lib/attachments). */
export interface PreviewFile {
  id: string;
  name: string;
  mediaType: string;
}

/** Text and CSV show this much; Copy still copies all of it. */
const SHOWN_TEXT = 256 * 1024;

type Kind = "image" | "pdf" | "text" | "extracted";
type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "too-large"; size: number }
  | { state: "unread" }
  | { state: "failed"; message: string }
  | { state: "bytes"; bytes: Uint8Array }
  | { state: "image"; url: string; size: number }
  | { state: "text"; text: string; size?: number };

const kindOf = (file: PreviewFile): Kind | undefined => {
  if (file.mediaType.startsWith("image/")) return "image";
  const format = documentFormat(file.mediaType, file.name);
  if (format === "pdf") return "pdf";
  if (format === "text" || format === "csv") return "text";
  if (format === "docx" || format === "xlsx") return "extracted";
  return undefined;
};

/** A sent file the preview opens: one the app keeps (an `attachment:` URL), of a kind it shows. */
function previewable(part: FileUIPart): PreviewFile | undefined {
  const id = attachmentId(part.url);
  const file = id ? { id, name: part.filename || "Attachment", mediaType: part.mediaType } : undefined;
  return file && kindOf(file) ? file : undefined;
}

/** Reads the document again whenever `attempt` changes (Retry). Word and Excel files show the text the model read. */
function useKept(file: PreviewFile | null, attempt: number): Loaded {
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded } | null>(null);
  const key = file ? `${file.id}:${attempt}` : "";
  useEffect(() => {
    const desktop = window.endurance;
    if (!file || !desktop) return;
    let current = true;
    const done = (value: Loaded) => current && setLoaded({ key, value });
    const kind = kindOf(file);
    const read = async (): Promise<Loaded> => {
      if (kind === "extracted") {
        const kept = await desktop.readAttachmentText(file.id);
        return kept.state === "ok" ? { state: "text", text: kept.text } : kept;
      }
      const result = await desktop.readAttachment(file.id);
      if (result.state !== "ok") return result;
      if (kind === "image") return { state: "image", url: await dataUrl(result.bytes, file.mediaType), size: result.bytes.byteLength };
      if (kind !== "text") return { state: "bytes", bytes: result.bytes };
      return { state: "text", text: new TextDecoder().decode(result.bytes), size: result.bytes.byteLength };
    };
    read().then(done, (error: unknown) => done({ state: "failed", message: error instanceof Error ? ipcMessage(error) : "The file could not be read." }));
    return () => {
      current = false;
    };
  }, [file, key]);
  return loaded?.key === key ? loaded.value : { state: "loading" };
}

/** An image as a data: URL, as images sent with a message already are, so nothing needs revoking. */
const dataUrl = (bytes: Uint8Array, type: string) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type }));
  });

/** One page, drawn when it comes near the view; until then a blank of the first page's shape keeps the scroll length. */
function PdfPage({ document, number, ratio, width }: { document: PdfDocument; number: number; ratio: number; width: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shape, setShape] = useState(ratio);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let cancelled = false;
    let task: { cancel(): void } | undefined;
    const draw = async () => {
      const page = await document.getPage(number);
      if (cancelled || !canvas.current) return;
      const natural = page.getViewport({ scale: 1 });
      setShape(natural.height / natural.width);
      const viewport = page.getViewport({ scale: (width * window.devicePixelRatio) / natural.width });
      canvas.current.width = Math.floor(viewport.width);
      canvas.current.height = Math.floor(viewport.height);
      const render = page.render({ canvas: canvas.current, viewport });
      task = render;
      await render.promise;
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        draw().catch((error: unknown) => {
          if (!cancelled && (error as { name?: string })?.name !== "RenderingCancelledException") setFailed(true);
        });
      },
      { rootMargin: "800px 0px" }
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
      task?.cancel();
    };
  }, [document, number, width]);
  return (
    <div
      aria-label={`Page ${number}`}
      className="relative mx-auto overflow-hidden rounded-[4px] bg-white shadow-sm ring-1 ring-foreground/10"
      ref={box}
      role="img"
      style={{ width, height: Math.round(width * shape) }}
    >
      <canvas className="block size-full" ref={canvas} />
      {failed && <span className="absolute inset-0 flex items-center justify-center text-neutral-500 text-xs">Page {number} could not be drawn</span>}
    </div>
  );
}

/**
 * A PDF drawn page by page with PDF.js (the build unpdf ships, already used to read PDFs), in this window. Chromium's
 * own PDF viewer is a plugin, which this window does not enable (webPreferences.plugins).
 */
function PdfView({ bytes }: { bytes: Uint8Array }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ bytes: Uint8Array; document?: PdfDocument; ratio: number; width: number; failed?: boolean } | null>(null);
  const opened = state?.bytes === bytes && state.document ? { ...state, document: state.document } : null;
  const failed = state?.bytes === bytes && state.failed;
  useEffect(() => {
    let cancelled = false;
    // Destroying the loading task frees the document, or stops it loading when the preview closes first.
    let task: { destroy(): Promise<void> } | undefined;
    (async () => {
      // The serverless build runs PDF.js on this thread, with no worker file to load.
      const { getDocument } = await import("unpdf/pdfjs");
      // PDF.js takes over the buffer it is given, so it gets a copy.
      const loading = getDocument({ data: bytes.slice(), useSystemFonts: true });
      task = loading;
      const document = await loading.promise;
      if (cancelled) return;
      const first = (await document.getPage(1)).getViewport({ scale: 1 });
      const room = (scroller.current?.clientWidth ?? 800) - 48;
      if (!cancelled) setState({ bytes, document, ratio: first.height / first.width, width: Math.max(240, Math.min(880, room)) });
    })().catch(() => !cancelled && setState({ bytes, ratio: 1, width: 0, failed: true }));
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [bytes]);
  return (
    <div className="h-full overflow-auto bg-muted/40" ref={scroller}>
      {failed ? (
        <Notice icon={<TriangleAlertIcon className="size-5 text-red-500" />} title="This PDF couldn't be shown">
          Save a copy to open it in another app.
        </Notice>
      ) : !opened ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-4 px-6 py-6">
          {Array.from({ length: opened.document.numPages }, (_, i) => (
            <PdfPage document={opened.document} key={i} number={i + 1} ratio={opened.ratio} width={opened.width} />
          ))}
        </div>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  );
}

function Notice({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon}
      <div className="font-medium text-sm">{title}</div>
      {children && <div className="max-w-sm text-muted-foreground text-sm">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Shows a document sent with a message: PDF pages, text, the text the model read from Word and Excel files, or an image. */
export function DocumentPreview({ file, onClose }: { file: PreviewFile | null; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const loaded = useKept(file, attempt);
  const kind = file ? kindOf(file) : undefined;

  if (loaded.state === "image" && file) {
    return <ImageViewer images={[{ id: file.id, url: loaded.url, name: file.name }]} index={0} onIndexChange={(index) => index === null && onClose()} />;
  }

  const retry = (
    <Button onClick={() => setAttempt((n) => n + 1)} size="sm" variant="outline">
      <RotateCcwIcon /> Retry
    </Button>
  );
  const save = async () => {
    if (!file || !window.endurance) return;
    try {
      const result = await window.endurance.saveAttachmentCopy(file.id, file.name);
      if (result === "saved") toast("Saved a copy");
      else if (result === "missing") setAttempt((n) => n + 1);
    } catch (error) {
      toast.error(error instanceof Error ? ipcMessage(error) : "Couldn't save a copy");
    }
  };
  const copy = () => {
    if (loaded.state !== "text") return;
    navigator.clipboard.writeText(loaded.text).then(
      () => setCopied(file?.id ?? null),
      () => toast("Couldn't copy")
    );
  };

  let body: ReactNode;
  let note: string | undefined;
  if (loaded.state === "loading") body = <Loading />;
  else if (loaded.state === "missing")
    body = (
      <Notice action={retry} icon={<FileXIcon className="size-5 text-muted-foreground" />} title="This file is no longer kept">
        It may have been removed with its chat, or renamed when the history key changed.
      </Notice>
    );
  else if (loaded.state === "too-large")
    body = (
      <Notice icon={<FileXIcon className="size-5 text-muted-foreground" />} title={`Too large to show here (${formatBytes(loaded.size)})`}>
        Save a copy to open it in another app.
      </Notice>
    );
  else if (loaded.state === "unread")
    body = (
      <Notice action={retry} icon={<FileXIcon className="size-5 text-muted-foreground" />} title="No text from this file yet">
        The text is kept once a chat has read the whole file. Save a copy to open it in another app.
      </Notice>
    );
  else if (loaded.state === "failed")
    body = (
      <Notice action={retry} icon={<TriangleAlertIcon className="size-5 text-red-500" />} title="Couldn't open this file">
        {loaded.message}
      </Notice>
    );
  else if (loaded.state === "bytes") body = <PdfView bytes={loaded.bytes} />;
  else if (loaded.state === "text") {
    const clipped = loaded.text.length > SHOWN_TEXT;
    if (kind === "extracted") note = "The text the model read from this file";
    else if (clipped) note = `Showing the first ${formatBytes(SHOWN_TEXT)}; Copy copies all of it`;
    body = (
      <div className="h-full overflow-auto">
        <pre className="whitespace-pre-wrap break-words px-5 py-4 font-mono text-[12px] leading-[1.6]">{clipped ? loaded.text.slice(0, SHOWN_TEXT) : loaded.text}</pre>
      </div>
    );
  }
  const size = loaded.state === "bytes" ? loaded.bytes.byteLength : loaded.state === "text" ? loaded.size : undefined;

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={file !== null}>
      <DialogContent className="flex h-[min(760px,calc(100dvh-4rem))] flex-col gap-0 overflow-hidden rounded-[12px] p-0 sm:max-w-[min(960px,calc(100vw-4rem))]">
        <header className="flex shrink-0 items-center gap-3 border-b py-2.5 pr-12 pl-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[14px] leading-[1.4]" title={file?.name}>
              {file?.name ?? "Attachment"}
            </DialogTitle>
            <DialogDescription className="truncate text-xs">
              {[size !== undefined ? formatBytes(size) : undefined, note].filter(Boolean).join(" · ") || "\u00a0"}
            </DialogDescription>
          </div>
          {loaded.state === "text" && (
            <Button onClick={copy} size="sm" variant="ghost">
              {copied === file?.id ? <CheckIcon /> : <CopyIcon />} {copied === file?.id ? "Copied" : "Copy"}
            </Button>
          )}
          {loaded.state !== "missing" && (
            <Button disabled={loaded.state === "loading"} onClick={() => void save()} size="sm" variant="ghost">
              <DownloadIcon /> Save a copy…
            </Button>
          )}
        </header>
        <div className="min-h-0 flex-1">{body}</div>
      </DialogContent>
    </Dialog>
  );
}

/** The files sent with a message, other than images; the ones the app keeps open in the preview by click or keyboard. */
export function SentAttachments({ files }: { files: (FileUIPart & { id: string })[] }) {
  const [open, setOpen] = useState<PreviewFile | null>(null);
  return (
    <>
      <Attachments className="ml-auto justify-end" variant="inline">
        {files.map((f) => {
          const file = previewable(f);
          const props = file
            ? {
                "aria-label": `Open ${file.name}`,
                className: "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                onClick: () => setOpen(file),
                onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setOpen(file);
                },
                role: "button",
                tabIndex: 0,
              }
            : { className: "cursor-default" };
          return (
            <Attachment data={f} key={f.id} {...props}>
              <AttachmentPreview />
              <AttachmentInfo className="max-w-48" />
            </Attachment>
          );
        })}
      </Attachments>
      {/* Mounted only while open, so a closed preview keeps no document in memory. */}
      {open && <DocumentPreview file={open} onClose={() => setOpen(null)} />}
    </>
  );
}
