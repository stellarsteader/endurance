import type { ServerLocation } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * Marks a model or server on a public address, outside localhost and the private network. Neutral on purpose:
 * it informs where requests go rather than warning.
 */
export function LocationBadge({ location, className }: { location?: ServerLocation; className?: string }) {
  if (location !== "public") return null;
  return (
    <span
      className={cn("inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 font-normal text-[11px] leading-none text-muted-foreground", className)}
      title="Runs on a public network address. Messages and attachments are sent there."
    >
      Public network
    </span>
  );
}
