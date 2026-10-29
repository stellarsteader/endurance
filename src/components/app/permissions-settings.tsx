"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStore } from "@/lib/store";
import type { Approval } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { APPROVALS } from "./composer";
import { PageScroll } from "./page-scroll";

/** Settings → Permissions: the approval mode a new chat starts in. Each chat keeps its own from its first message. */
export function PermissionsSettings() {
  const { settings, setSettings } = useStore();
  const current = APPROVALS.find((item) => item.id === settings.defaultApproval) ?? APPROVALS[0];

  return (
    <PageScroll>
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <h1 className="mb-6 pl-2 font-medium text-[15px] leading-[1.6]">Permissions</h1>
        <section className="divide-y overflow-hidden rounded-[12px] border bg-card">
          <div className="flex items-center gap-6 px-3 py-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-[13px] leading-[1.4]">Default for new chats</div>
              <div className="text-[12px] leading-[1.35] text-muted-foreground">
                A new chat starts in this mode. Change it for one chat from the message box; that chat keeps its mode.
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[13px] outline-none hover:bg-muted/50 data-popup-open:bg-muted",
                      current.danger && "text-orange-500 dark:text-orange-400"
                    )}
                    type="button"
                  />
                }
              >
                <current.icon className="size-3.5" />
                {current.label}
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[22rem] p-1" sideOffset={6}>
                <DropdownMenuRadioGroup onValueChange={(value) => setSettings({ defaultApproval: value as Approval })} value={current.id}>
                  {APPROVALS.map((item) => (
                    <DropdownMenuRadioItem
                      className="items-center gap-2 rounded-md py-1 pr-8 pl-2 text-[13px] font-normal leading-none focus:bg-muted focus:text-foreground data-checked:bg-muted [&_[data-slot=dropdown-menu-radio-item-indicator]]:inset-y-0"
                      key={item.id}
                      value={item.id}
                    >
                      <item.icon className={cn("size-4", item.danger ? "text-orange-500!" : "text-muted-foreground!")} />
                      <span className="flex min-w-0 flex-col">
                        <span className={cn("leading-4", item.danger ? "text-orange-500! dark:text-orange-400!" : "text-foreground!")}>{item.label}</span>
                        <span className={cn("text-[12px] leading-4", item.danger ? "text-orange-500/80!" : "text-muted-foreground!")}>{item.hint}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </section>
      </div>
    </PageScroll>
  );
}
