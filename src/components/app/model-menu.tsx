"use client";

import { useChatModels } from "@/features/model-settings/use-chat-models";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  arrangeModels,
  formatContext,
  getModel,
  groupOf,
  type ModelInfo,
} from "@/lib/models";
import { materialize, moveId, type DropPosition } from "@/lib/ordering";
import { useStore } from "@/lib/store";
import type { Effort } from "@/lib/types";
import { effortChoices, effortLabel, resolveEffort, thinkingControl } from "@/lib/thinking-switch";
import { defaultEffort, runtimeContext } from "@/features/model-settings/preferences";
import { useSession } from "./session-context";
import { cn } from "@/lib/utils";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LocationBadge } from "./location-badge";
import { DragCard, DropIndicator, Reorderable, useReorderDrag, useReorderDrop, type DragItem, type DropTarget } from "./reorder";

/** Gap between any composer trigger and its popup, submenus included. */
export const POPUP_GAP = 7;

/**
 * Submenus prefer the right of the parent. They flip left only when that side cannot hold the card,
 * and they never shift back over the parent. A tight side shrinks the card to `--available-width`.
 */
const BESIDE = {
  side: "right",
  sideOffset: POPUP_GAP,
  alignOffset: 0,
  collisionPadding: 12,
  collisionAvoidance: { side: "flip", align: "none", fallbackAxisSide: "none" },
} as const;

const row =
  "h-[26px] rounded-md py-0 text-[13px] font-normal leading-none data-popup-open:bg-muted [&>svg:last-child]:ml-0";


/** A model's window as its requests run with it, from its runtime. */
const windowLabel = (m: ModelInfo) => {
  if (!m.runtime) return formatContext(m.context);
  const tokens = runtimeContext(m).tokens;
  return tokens ? formatContext(tokens) : m.runtime === "ollama" ? "Auto context" : "Context unknown";
};

/** What a model shows when picked in a new chat: its window, and the thinking it starts with. */
const defaultDetail = (m: ModelInfo) =>
  [windowLabel(m), m.capabilities.includes("reasoning") ? effortLabel(thinkingControl(m), resolveEffort(thinkingControl(m), defaultEffort(m))) : null]
    .filter(Boolean)
    .join(" ");

function Toggle({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200",
        checked ? "bg-sky-500" : "bg-foreground/15"
      )}
    >
      <span
        className={cn(
          "size-3 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.28)] transition-transform duration-200 ease-[cubic-bezier(.3,1.4,.6,1)]",
          checked ? "translate-x-3" : "translate-x-0"
        )}
      />
    </span>
  );
}

function Row({ label, value }: { label: ReactNode; value?: ReactNode }) {
  return (
    <>
      <span className="flex-1">{label}</span>
      {value !== undefined && <span className="text-muted-foreground">{value}</span>}
    </>
  );
}

function LocalDot() {
  return <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15" />;
}

function ModelListItem({
  model,
  selected,
  detail,
  onPick,
}: {
  model: ModelInfo;
  selected: boolean;
  detail?: string;
  onPick: () => void;
}) {
  return (
    <DropdownMenuItem className="h-[26px] gap-1.5 rounded-md py-0 pr-2 pl-2 text-[13px] font-normal leading-none" onClick={onPick}>
      <span className="truncate">{model.name}</span>
      <span className="truncate text-[12px] leading-[1.35] text-muted-foreground">
        {detail || model.variant || defaultDetail(model)}
      </span>
      <CheckIcon className={cn("ml-auto size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
    </DropdownMenuItem>
  );
}

type ModelGroupView = ReturnType<typeof arrangeModels>[number];

/** A model row is dragged within its own group; a group is dragged by its label among other groups. */
interface ModelSpot {
  group: string;
}

function DraggableModel({
  model,
  reorderable,
  ...item
}: {
  model: ModelInfo;
  reorderable: boolean;
  selected: boolean;
  detail?: string;
  onPick: () => void;
}) {
  const spot: ModelSpot = { group: groupOf(model) };
  const { setNode: setDrag, handle, dragging } = useReorderDrag({ kind: "model", id: model.id, data: spot }, !reorderable);
  const { setNode: setDrop, placement } = useReorderDrop({ kind: "model", id: model.id, data: spot, accepts: ["model"] }, !reorderable);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setDrag(node);
      setDrop(node);
    },
    [setDrag, setDrop]
  );
  return (
    <div {...handle} className={cn("relative", dragging && "opacity-40")} ref={ref}>
      <DropIndicator placement={placement} />
      <ModelListItem model={model} {...item} />
    </div>
  );
}

function ModelGroupSection({ group, reorderable, children }: { group: ModelGroupView; reorderable: boolean; children: ReactNode }) {
  const { setNode: setBlock, placement } = useReorderDrop({ kind: "group", id: group.id, data: null, accepts: ["group"] }, !reorderable);
  const { setNode: setHandle, handle, dragging } = useReorderDrag({ kind: "group", id: group.id, data: null }, !reorderable);
  return (
    <div className={cn("relative", dragging && "opacity-40")} ref={setBlock}>
      <DropIndicator placement={placement} />
      {/* The label takes a slot like a row, so it sits as far below the row above as above its first model. */}
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex h-[23px] items-center gap-2 px-2 py-0 text-[11px] leading-none font-normal" ref={setHandle} {...handle}>
          {group.label}
          <span className="ml-auto flex items-center gap-1.5 font-normal">
            {group.location === "remote" ? <LocationBadge location="remote" /> : group.local && <LocalDot />}
            {group.meta}
          </span>
        </DropdownMenuLabel>
        {children}
      </DropdownMenuGroup>
    </div>
  );
}

/**
 * Drag groups and models into the order the person wants. The order is saved with the app's view settings
 * and also orders the ⌘/ model picker. Searching shows a filtered list, so dragging waits until it is cleared.
 */
function useModelReorder(arranged: ModelGroupView[]) {
  const { modelOrder, setModelOrder } = useStore();
  const canDrop = (item: DragItem, target: DropTarget) =>
    item.kind === target.kind &&
    item.id !== target.id &&
    (item.kind === "group" || (item.data as ModelSpot).group === (target.data as ModelSpot).group);
  const onDrop = (item: DragItem, target: DropTarget) => {
    const position = target.placement as DropPosition;
    if (item.kind === "group") {
      // Servers that are offline right now keep their place after the ones shown.
      const shown = arranged.map((group) => group.id);
      setModelOrder({ groups: moveId(materialize(shown, modelOrder.groups, [...shown, ...modelOrder.groups]), item.id, target.id, position) });
    } else {
      const shown = arranged.flatMap((group) => group.models.map((model) => model.id));
      setModelOrder({ models: moveId(materialize(shown, modelOrder.models, [...shown, ...modelOrder.models]), item.id, target.id, position) });
    }
  };
  const overlay = (item: DragItem) => {
    if (item.kind === "group")
      return <DragCard className="h-6 text-[11px] text-muted-foreground">{arranged.find((group) => group.id === item.id)?.label}</DragCard>;
    const model = arranged.flatMap((group) => group.models).find((m) => m.id === item.id);
    return (
      <DragCard className="h-[26px] gap-1.5">
        <span className="truncate">{model?.name}</span>
        {model && <span className="truncate text-[12px] text-muted-foreground">{model.variant || defaultDetail(model)}</span>}
      </DragCard>
    );
  };
  const label = (item: DragItem) =>
    (item.kind === "group"
      ? arranged.find((group) => group.id === item.id)?.label
      : arranged.flatMap((group) => group.models).find((m) => m.id === item.id)?.name) ?? "Item";
  return { canDrop, onDrop, overlay, label };
}

function AllModels({
  current,
  currentDetail,
  onPick,
}: {
  current: string;
  currentDetail: string;
  onPick: (id: string) => void;
}) {
  const models = useChatModels();
  const { modelOrder } = useStore();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (m: ModelInfo) =>
    !q || `${m.name} ${m.providerLabel} ${m.variant ?? ""} ${m.id}`.toLowerCase().includes(q);
  const arranged = arrangeModels(models, modelOrder);
  const reorder = useModelReorder(arranged);
  const reorderable = !q;

  return (
    <>
      <div className="flex h-[26px] items-center gap-2 border-b px-2">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" && e.key !== "ArrowDown" && e.key !== "ArrowUp") e.stopPropagation();
          }}
          placeholder="Search models"
          value={query}
        />
      </div>
      <ScrollArea className="-mr-1 h-[min(20rem,calc(var(--available-height)-2.25rem))]" scrollbarClassName="w-1.5 p-0 py-1">
        {/* Rows inset their text, the divider does not: this makes up the difference above the first label. */}
        <div className="pt-2 pr-1 pb-1">
          <Reorderable {...reorder}>
            {arranged.map((group) => {
              const items = group.models.filter(matches);
              if (items.length === 0) return null;
              return (
                <ModelGroupSection group={group} key={group.id} reorderable={reorderable}>
                  {items.map((m) => (
                    <DraggableModel
                      detail={m.id === current ? currentDetail : undefined}
                      key={m.id}
                      model={m}
                      onPick={() => onPick(m.id)}
                      reorderable={reorderable}
                      selected={m.id === current}
                    />
                  ))}
                </ModelGroupSection>
              );
            })}
          </Reorderable>
          {models.every((m) => !matches(m)) && (
            <div className="px-2.5 py-6 text-center text-muted-foreground text-sm">No models match “{query}”.</div>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

export function ModelEffortMenu() {
  const { model, effort, choose } = useSession();
  const [open, setOpen] = useState(false);
  const reasons = model.capabilities.includes("reasoning");
  // On and off for a model that only switches thinking, its own levels for one that names them.
  const control = thinkingControl(model);
  const choices = effortChoices(control);
  // A model's window is set in Models settings; the menu shows it and switches thinking.
  const pick = (id: string) => {
    choose({ model: id });
    setOpen(false);
  };

  const detail = [model.runtime ? windowLabel(model) : null, reasons ? effortLabel(control, effort) : null].filter(Boolean).join(" ");

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        render={
          <button
            className="flex h-7 min-w-0 items-center gap-1.5 overflow-hidden rounded-full px-2.5 text-[12.5px] text-foreground/85 outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-popup-open:bg-muted/70 data-popup-open:text-foreground"
            type="button"
          />
        }
      >
        {model.runtime && <LocalDot />}
        <span className="min-w-12 truncate">{model.name}</span>
        {detail && <span className="hidden shrink-0 text-muted-foreground @[30rem]/composer:inline">{detail}</span>}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[13.75rem] p-1" side="top" sideOffset={POPUP_GAP}>
        {/* An on/off model gets a switch; a model with levels gets the level menu. */}
        {reasons && choices.length > 1 && control.kind === "toggle" && (
          <DropdownMenuItem
            className={row}
            closeOnClick={false}
            onClick={() => choose({ effort: effort === "none" ? "high" : "none" })}
          >
            <Row label="Thinking" />
            <Toggle checked={effort !== "none"} />
          </DropdownMenuItem>
        )}
        {reasons && choices.length > 1 && control.kind === "levels" && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={row}>
              <Row label="Effort" value={effortLabel(control, effort)} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent align="center" className="w-[min(12.5rem,var(--available-width))] p-1" {...BESIDE}>
              <DropdownMenuRadioGroup onValueChange={(v) => choose({ effort: v as Effort })} value={effort}>
                {choices.map((e) => (
                  <DropdownMenuRadioItem className="h-[26px] rounded-md py-0 text-[13px] font-normal leading-none data-checked:bg-muted" key={e.id} value={e.id}>
                    {e.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {reasons && choices.length > 1 && <DropdownMenuSeparator className="my-1" />}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={row}>
            <Row label="Model" value={<span className="block max-w-[7.5rem] truncate">{model.name}</span>} />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            align="end"
            className="w-[min(15.5rem,var(--available-width))] overflow-hidden p-1 pt-1.5"
            {...BESIDE}
          >
            <AllModels current={model.id} currentDetail={detail} onPick={pick} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
