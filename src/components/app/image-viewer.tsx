"use client";

import { cn } from "@/lib/utils";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeftIcon, ChevronRightIcon, ImageOffIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface ViewerImage {
  id: string;
  url: string;
  name?: string;
}

const control =
  "flex items-center justify-center rounded-full text-white/80 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50 disabled:pointer-events-none disabled:opacity-25";

/** An image that shows a quiet placeholder instead of a broken icon when it cannot load. */
export function SafeImage({ src, alt, className, iconClassName, onLoad }: { src: string; alt: string; className?: string; iconClassName?: string; onLoad?: (image: HTMLImageElement) => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) {
    return (
      <span className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)} role="img" aria-label={`${alt} could not be loaded`}>
        <ImageOffIcon className={cn("size-4", iconClassName)} />
      </span>
    );
  }
  return <img alt={alt} className={className} draggable={false} onError={() => setFailed(src)} onLoad={(event) => onLoad?.(event.currentTarget)} src={src} />;
}

/**
 * Full-window viewer for a set of images. Arrow keys and the side buttons move between them; clicking the
 * image toggles between fitting the window and its actual size when it is larger than the window.
 */
export function ImageViewer({ images, index, onIndexChange }: { images: ViewerImage[]; index: number | null; onIndexChange: (index: number | null) => void }) {
  const open = index !== null && images.length > 0;
  const current = open ? Math.min(index, images.length - 1) : 0;
  const image = images[current];
  const many = images.length > 1;
  const [zoom, setZoom] = useState<{ id: string; on: boolean }>({ id: "", on: false });
  const [size, setSize] = useState<{ id: string; width: number; height: number; fits: boolean } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const zoomed = zoom.id === image?.id && zoom.on;
  const known = size?.id === image?.id ? size : null;

  const go = useCallback(
    (step: number) => {
      if (index === null) return;
      const next = current + step;
      if (next >= 0 && next < images.length) onIndexChange(next);
    },
    [current, images.length, index, onIndexChange]
  );

  useEffect(() => {
    if (!open) return;
    // Captured before any focused control sees the key, so arrows always move between images.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, open]);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [current, open]);

  const measure = (element: HTMLImageElement) => {
    if (!image) return;
    const fits = element.naturalWidth <= element.clientWidth + 1 && element.naturalHeight <= element.clientHeight + 1;
    setSize({ id: image.id, width: element.naturalWidth, height: element.naturalHeight, fits });
  };
  const canZoom = Boolean(known && !known.fits);
  const toggleZoom = () => canZoom && image && setZoom({ id: image.id, on: !zoomed });

  let stage: ReactNode = null;
  if (image) {
    stage = zoomed ? (
      <div className="absolute inset-0 overflow-auto">
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          <img alt={image.name ?? "Image"} className="max-w-none cursor-zoom-out select-none" draggable={false} onClick={toggleZoom} src={image.url} />
        </div>
      </div>
    ) : (
      <div className="absolute inset-0 flex items-center justify-center px-16 py-4" onClick={(event) => event.target === event.currentTarget && onIndexChange(null)}>
        <SafeImage
          alt={image.name ?? "Image"}
          className={cn(
            "max-h-full max-w-full select-none rounded-[6px] object-contain shadow-[0_24px_80px_rgba(0,0,0,0.45)] duration-200 animate-in fade-in-0 zoom-in-[0.98]",
            canZoom ? "cursor-zoom-in" : "cursor-default"
          )}
          iconClassName="size-8 text-white/40"
          key={image.id}
          onLoad={measure}
          src={image.url}
        />
      </div>
    );
  }

  return (
    <Dialog.Root onOpenChange={(next) => !next && onIndexChange(null)} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup
          aria-label={image?.name ?? "Image viewer"}
          // Focus the viewer, not its first button, so the first key press reaches it and no ring appears.
          initialFocus={popup}
          ref={popup}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex flex-col text-white outline-none duration-150 [-webkit-app-region:no-drag] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          onClick={(event) => !zoomed && event.target === event.currentTarget && onIndexChange(null)}
        >
          {/* Leaves room on the left for the window controls. */}
          <header className="flex h-12 shrink-0 items-center gap-3 pr-3 pl-24">
            <div className="flex min-w-0 flex-1 items-baseline gap-2 text-[13px]">
              <Dialog.Title className="truncate font-medium text-white/90">{image?.name ?? "Image"}</Dialog.Title>
              <span className="shrink-0 text-[12px] text-white/45 tabular-nums">
                {[many ? `${current + 1} of ${images.length}` : null, known ? `${known.width} × ${known.height}` : null].filter(Boolean).join(" · ")}
              </span>
            </div>
            <button aria-label={zoomed ? "Fit to window" : "Actual size"} className={cn(control, "size-8")} disabled={!canZoom} onClick={toggleZoom} title={zoomed ? "Fit to window" : "Actual size"} type="button">
              {zoomed ? <ZoomOutIcon className="size-4" /> : <ZoomInIcon className="size-4" />}
            </button>
            <Dialog.Close aria-label="Close" className={cn(control, "size-8")} title="Close (Esc)">
              <XIcon className="size-4" />
            </Dialog.Close>
          </header>

          <div className="relative min-h-0 flex-1">
            {stage}
            {many && (
              <>
                <button aria-label="Previous image" className={cn(control, "absolute top-1/2 left-4 size-10 -translate-y-1/2 bg-white/[0.08] backdrop-blur")} disabled={current === 0} onClick={() => go(-1)} type="button">
                  <ChevronLeftIcon className="size-5" />
                </button>
                <button aria-label="Next image" className={cn(control, "absolute top-1/2 right-4 size-10 -translate-y-1/2 bg-white/[0.08] backdrop-blur")} disabled={current === images.length - 1} onClick={() => go(1)} type="button">
                  <ChevronRightIcon className="size-5" />
                </button>
              </>
            )}
          </div>

          {many && (
            <div className="flex shrink-0 justify-center px-6 pt-3 pb-4">
              <div className="flex max-w-full gap-1.5 overflow-x-auto p-1 [scrollbar-width:none]" ref={strip}>
                {images.map((item, i) => (
                  <button
                    aria-current={i === current}
                    aria-label={`Show ${item.name ?? `image ${i + 1}`}`}
                    className={cn(
                      "size-12 shrink-0 overflow-hidden rounded-[6px] outline-none ring-offset-2 ring-offset-black transition focus-visible:ring-2 focus-visible:ring-white/60",
                      i === current ? "opacity-100 ring-2 ring-white/90" : "opacity-45 hover:opacity-80"
                    )}
                    data-index={i}
                    key={item.id}
                    onClick={() => onIndexChange(i)}
                    type="button"
                  >
                    <SafeImage alt="" className="size-full object-cover" iconClassName="text-white/40" src={item.url} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Holds which image of a set is open, so any thumbnail can open the viewer at its position. */
export function useImageViewer(images: ViewerImage[]) {
  const [index, setIndex] = useState<number | null>(null);
  return { open: setIndex, viewer: <ImageViewer images={images} index={index} onIndexChange={setIndex} /> };
}

/**
 * Images sent with a message, sized by count: one shows at its own shape, two or three sit side by side,
 * and four or more fill a two-by-two grid whose last tile counts the rest.
 */
export function ImageGallery({ images, className }: { images: ViewerImage[]; className?: string }) {
  const { open, viewer } = useImageViewer(images);
  if (images.length === 0) return null;
  const shown = images.length > 4 ? images.slice(0, 4) : images;
  const extra = images.length - shown.length;
  const tile =
    "group/tile relative block overflow-hidden rounded-[12px] bg-muted outline-none ring-1 ring-foreground/10 transition focus-visible:ring-2 focus-visible:ring-ring cursor-zoom-in";
  const shade = <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover/tile:bg-black/10" />;

  return (
    <>
      {images.length === 1 ? (
        // The cap sits on the tile, whose width the message sets: on the image, 100% would mean the tile, which takes
        // its width from the image, so the tile would size to the uncapped image and show empty space beside it.
        <button aria-label={`Open ${images[0].name ?? "image"}`} className={cn(tile, "w-fit max-w-[min(100%,22rem)]", className)} onClick={() => open(0)} type="button">
          <SafeImage alt={images[0].name ?? "Image"} className="block max-h-80 min-h-16 w-auto min-w-16 max-w-full object-contain" src={images[0].url} />
          {shade}
        </button>
      ) : (
        <div className={cn("grid w-fit gap-1.5", images.length === 2 && "grid-cols-2", images.length === 3 && "grid-cols-3", images.length >= 4 && "grid-cols-2", className)}>
          {shown.map((image, i) => (
            <button
              aria-label={`Open ${image.name ?? `image ${i + 1}`}`}
              className={cn(tile, images.length === 3 ? "size-[7.5rem]" : "size-[9.5rem]")}
              key={image.id}
              onClick={() => open(i)}
              type="button"
            >
              <SafeImage alt={image.name ?? "Image"} className="size-full object-cover transition-transform duration-300 group-hover/tile:scale-[1.02]" src={image.url} />
              {shade}
              {extra > 0 && i === shown.length - 1 && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 font-medium text-[17px] text-white tabular-nums">+{extra}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {viewer}
    </>
  );
}
