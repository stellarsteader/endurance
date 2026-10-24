import type { ServerLocation } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * Marks a model or server that runs outside this computer and the person's network. Neutral on purpose:
 * it informs where requests go rather than warning.
 */
export function LocationBadge({ location, className }: { location?: ServerLocation; className?: string }) {
  if (location !== "remote") return null;
  return (
    <span
      className={cn("inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 font-normal text-[11px] leading-none text-muted-foreground", className)}
      title="Runs on a remote server. Messages and attachments are sent there."
    >
      Remote
    </span>
  );
}
