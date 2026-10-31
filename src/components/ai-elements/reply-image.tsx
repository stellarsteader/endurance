"use client";

import { cn } from "@/lib/utils";
import { ImageIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { defaultComponents, type ExtraProps } from "streamdown";

/**
 * Images in replies. Fetching an image sends its address to the server that hosts it, and a model misled by
 * prompt injection can put data it has read into that address. So an image from another server shows as a
 * placeholder naming the host, and is fetched only when the person clicks it. An image carried in the reply
 * itself (a `data:` or `blob:` address) sends nothing out and shows at once.
 */

export type ReplyImageProps = ComponentProps<"img"> & ExtraProps;

const StreamdownImage = defaultComponents.img;

// `streamdown:` is the library's own marker for an image whose Markdown has not finished arriving; its component
// draws a loading box for it and fetches nothing.
const INLINE_PROTOCOLS = new Set(["data:", "blob:", "streamdown:"]);

/** The host an image would be fetched from, or `undefined` when it would not be fetched from anywhere. */
export function imageHost(src: string, base?: string): string | null | undefined {
  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    // An address that cannot be resolved is still held back: the browser may resolve it differently.
    return null;
  }
  if (INLINE_PROTOCOLS.has(url.protocol)) return undefined;
  return url.host || null;
}

export function ReplyImage(props: ReplyImageProps) {
  const { src, alt } = props;
  // The address the person agreed to load. Keeping the address rather than a flag means a different image in
  // the same place asks again.
  const [allowed, setAllowed] = useState<string | null>(null);
  const address = typeof src === "string" ? src : "";
  // Relative addresses resolve against the page, as the browser would resolve them.
  const host = address ? imageHost(address, typeof document === "undefined" ? undefined : document.baseURI) : undefined;

  if (host === undefined || allowed === address) {
    // Only `src` is handed over: `srcSet` and `sizes` could name other servers than the one the person agreed to.
    const shown = { ...props };
    delete shown.srcSet;
    delete shown.sizes;
    return <StreamdownImage {...shown} />;
  }

  const from = host ? `Image from ${host}` : "Image from another server";
  const text = alt?.trim();
  return (
    // A button is allowed where an image is, inside a paragraph as well as on its own line.
    <button
      aria-label={`Load image from ${host || "another server"}${text ? `: ${text}` : ""}`}
      className={cn(
        "inline-flex max-w-full items-start gap-2 rounded-[12px] border border-border bg-card px-3 py-2 text-left align-top",
        "outline-none transition-colors hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      )}
      data-streamdown="external-image"
      onClick={() => setAllowed(address)}
      title={address}
      type="button"
    >
      <ImageIcon aria-hidden className="mt-[2px] size-[15px] shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-[13px] leading-[1.4] text-foreground">{from}</span>
        <span className="truncate text-[12px] leading-[1.35] text-muted-foreground">
          {text ? `${text} · Click to load` : "Click to load"}
        </span>
      </span>
    </button>
  );
}

/** `<source>` sits inside `<picture>` and names images of its own; the image inside it is the one shown. */
export function ReplySource() {
  return null;
}
