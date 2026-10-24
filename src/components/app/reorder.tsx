"use client";

/**
 * Drag to reorder, shared by the sidebar and the model menu. Rows stay where they are while dragging; a
 * line shows where the item will land (or a highlight when it moves into a group), and a copy of the row
 * follows the pointer. Rows of different heights, nested groups and scrolling menus all behave the same.
 *
 * Each draggable item has a `kind`. Drop targets list the kinds they accept and either sit `between` items
 * (before or after, by the pointer's half) or take items `into` themselves, like a project header.
 */
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type Modifier,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { DropPosition } from "@/lib/ordering";
import { cn } from "@/lib/utils";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type Placement = DropPosition | "inside";

export interface DragItem<Data = unknown> {
  kind: string;
  id: string;
  data: Data;
}

export interface DropTarget<Data = unknown> {
  kind: string;
  id: string;
  data: Data;
  placement: Placement;
}

interface DropData {
  target: Omit<DropTarget, "placement">;
  accepts: readonly string[];
  mode: "between" | "into";
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

interface ReorderState {
  active: DragItem | null;
  /** The target under the pointer, only when `canDrop` allows it. */
  over: { key: string; placement: Placement } | null;
  nodes: Map<string, HTMLElement>;
}

const ReorderContext = createContext<ReorderState | null>(null);

/** Drop targets accept only some kinds; the rest are invisible to the pointer while that kind is dragged. */
const collisions: CollisionDetection = (args) => {
  const kind = (args.active.data.current as { item?: DragItem } | undefined)?.item?.kind;
  const droppableContainers = args.droppableContainers.filter((container) =>
    Boolean(kind && (container.data.current as DropData | undefined)?.accepts.includes(kind))
  );
  const scoped = { ...args, droppableContainers };
  // Between rows, or past the ends of a list, the nearest target still answers.
  const within = pointerWithin(scoped);
  return within.length ? within : closestCenter(scoped);
};

/**
 * The copy trails just below and right of the pointer, like a file dragged in Finder, so it never covers
 * the line or highlight that says where the item will land.
 */
const trailPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect || !("clientX" in activatorEvent)) return transform;
  const start = activatorEvent as PointerEvent;
  return {
    ...transform,
    x: start.clientX + transform.x - draggingNodeRect.left + 14,
    y: start.clientY + transform.y - draggingNodeRect.top + 10,
  };
};

/** Removes the click that follows a drop, so dropping a row never also opens or selects it. */
function swallowNextClick() {
  const stop = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 50);
}

export function Reorderable({
  children,
  canDrop,
  onDrop,
  overlay,
  label,
}: {
  children: ReactNode;
  /** The item's name for screen reader announcements. */
  label: (item: DragItem) => string;
  /** Whether the item may land at the target; disallowed targets show nothing and ignore the drop. */
  canDrop: (item: DragItem, target: DropTarget) => boolean;
  onDrop: (item: DragItem, target: DropTarget) => void;
  /** The copy that follows the pointer. */
  overlay: (item: DragItem) => ReactNode;
}) {
  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so clicks and text selection keep working.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );
  const [nodes] = useState(() => new Map<string, HTMLElement>());
  const [active, setActive] = useState<DragItem | null>(null);
  const [over, setOverState] = useState<ReorderState["over"]>(null);
  // Drag handlers read the latest target from here rather than from a render that may be one move behind.
  const overRef = useRef<ReorderState["over"]>(null);
  const setOver = useCallback((next: ReorderState["over"]) => {
    const current = overRef.current;
    if (current === next || (current && next && current.key === next.key && current.placement === next.placement)) return;
    overRef.current = next;
    setOverState(next);
  }, []);
  const pointer = useRef({ x: 0, y: 0 });
  /** Whether the last drag landed, kept until the next drag for the closing announcement. */
  const landed = useRef(false);
  const overData = useRef<DropData | null>(null);
  const latest = useRef({ active, canDrop });
  useEffect(() => {
    latest.current = { active, canDrop };
  });

  // The placement depends on where the pointer is inside the target, measured live so scrolling is exact.
  const resolve = useCallback(() => {
    const item = latest.current.active;
    const data = overData.current;
    const key = data && keyOf(data.target.kind, data.target.id);
    const node = key && nodes.get(key);
    if (!item || !data || !key || !node) {
      setOver(null);
      return;
    }
    const rect = node.getBoundingClientRect();
    const placement: Placement =
      data.mode === "into" ? "inside" : pointer.current.y < rect.top + rect.height / 2 ? "before" : "after";
    setOver(latest.current.canDrop(item, { ...data.target, placement }) ? { key, placement } : null);
  }, [nodes, setOver]);

  useEffect(() => {
    if (!active) return;
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      resolve();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("scroll", resolve, true);
    document.documentElement.dataset.reordering = "";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("scroll", resolve, true);
      delete document.documentElement.dataset.reordering;
    };
  }, [active, resolve]);

  const finish = () => {
    setActive(null);
    setOver(null);
    overData.current = null;
  };

  const onDragStart = (event: DragStartEvent) => {
    const start = event.activatorEvent as PointerEvent;
    pointer.current = { x: start.clientX, y: start.clientY };
    landed.current = false;
    setActive((event.active.data.current as { item: DragItem }).item);
  };
  const onDragOver = (event: DragOverEvent) => {
    overData.current = (event.over?.data.current as DropData | undefined) ?? null;
    resolve();
  };
  const onDragEnd = (event: DragEndEvent) => {
    const item = (event.active.data.current as { item: DragItem }).item;
    const data = overData.current;
    const target = overRef.current;
    landed.current = Boolean(target && data);
    if (target && data) onDrop(item, { ...data.target, placement: target.placement });
    swallowNextClick();
    finish();
  };

  const state = useMemo(() => ({ active, over, nodes }), [active, over, nodes]);
  const named = (event: { active: { data: { current?: unknown } } }) => {
    const item = (event.active.data.current as { item?: DragItem } | undefined)?.item;
    return item ? label(item) : "Item";
  };
  // dnd-kit's default announcements read internal IDs; these use the names people see.
  const announcements: Announcements = {
    onDragStart: (event) => `Picked up ${named(event)}.`,
    onDragOver: () => undefined,
    onDragMove: () => undefined,
    onDragEnd: (event) => (landed.current ? `Moved ${named(event)}.` : `${named(event)} was not moved.`),
    onDragCancel: (event) => `Cancelled. ${named(event)} was not moved.`,
  };
  return (
    <ReorderContext.Provider value={state}>
      <DndContext accessibility={{ announcements }} collisionDetection={collisions} onDragCancel={finish} onDragEnd={onDragEnd} onDragOver={onDragOver} onDragStart={onDragStart} sensors={sensors}>
        {children}
        {typeof document !== "undefined" &&
          // Over everything and never under the pointer, so menus underneath keep their hover state.
          createPortal(
            <DragOverlay className="pointer-events-none" dropAnimation={null} modifiers={[trailPointer]} zIndex={1000}>
              {active ? overlay(active) : null}
            </DragOverlay>,
            document.body
          )}
      </DndContext>
    </ReorderContext.Provider>
  );
}

/** Makes a node the handle that starts dragging `item`. */
export function useReorderDrag<Data>(item: DragItem<Data>, disabled = false) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: keyOf(item.kind, item.id), data: { item }, disabled });
  return { setNode: setNodeRef, handle: disabled ? undefined : listeners, dragging: isDragging };
}

/** Makes a node a drop target, and says where a dragged item would land on it. */
export function useReorderDrop<Data>(
  target: Omit<DropTarget<Data>, "placement"> & { accepts: readonly string[]; mode?: "between" | "into" },
  disabled = false
) {
  const state = useContext(ReorderContext);
  const key = keyOf(target.kind, target.id);
  const data: DropData = { target: { kind: target.kind, id: target.id, data: target.data }, accepts: target.accepts, mode: target.mode ?? "between" };
  const { setNodeRef } = useDroppable({ id: key, data, disabled });
  const nodes = state?.nodes;
  const setNode = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      if (node) nodes?.set(key, node);
      else nodes?.delete(key);
    },
    [key, nodes, setNodeRef]
  );
  return { setNode, placement: state?.over?.key === key ? state.over.placement : null };
}

/** The item being dragged, if any, for styling the list while it moves. */
export const useReorderActive = () => useContext(ReorderContext)?.active ?? null;

/**
 * Where the item will land: a line with a small ring at its start, or a tint over the whole target.
 * Place it inside a `relative` element. `inset` lines the start up with the row's text. `gap` is the space
 * between neighbouring targets: the line sits in the middle of it, so "after one" and "before the next"
 * draw the same line.
 */
export function DropIndicator({ placement, inset = 8, gap = 1, className }: { placement: Placement | null; inset?: number; gap?: number; className?: string }) {
  if (!placement) return null;
  if (placement === "inside")
    return <span aria-hidden className={cn("pointer-events-none absolute inset-0 z-20 rounded-[6px] bg-sky-500/10 ring-1 ring-sky-500/60 ring-inset", className)} />;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute right-1 z-20 h-0.5 rounded-full bg-sky-500",
        "before:absolute before:top-1/2 before:-left-1 before:size-1.5 before:-translate-y-1/2 before:rounded-full before:border-[1.5px] before:border-sky-500 before:bg-background",
        className
      )}
      // Half the gap, plus half the 2px line, so the line's centre is the gap's centre.
      style={{ left: inset, [placement === "before" ? "top" : "bottom"]: -(gap / 2 + 1) }}
    />
  );
}

/** The floating copy of a row: its name on a small lifted card, as wide as its text up to a limit. */
export function DragCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-7 w-max max-w-60 items-center gap-2 rounded-[6px] bg-popover/95 px-2 text-[13px] text-popover-foreground shadow-lg ring-1 ring-foreground/10 backdrop-blur-sm dark:ring-foreground/15",
        className
      )}
    >
      {children}
    </div>
  );
}
