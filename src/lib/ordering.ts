/**
 * Manual orders saved as lists of IDs. A saved list may name items that are gone and miss items that are
 * new; every helper here tolerates both, so a stale list never hides or duplicates anything.
 */

export type DropPosition = "before" | "after";

/** A comparator rank: an item's index in the saved list, or undefined when the list does not name it. */
export function rankOf(order: readonly string[]) {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return (id: string) => ranks.get(id);
}

/**
 * Sorts items by a saved list. Items the list does not name keep their given order and go `first` (new
 * chats and projects, which belong on top) or `last` (newly found models, which should not push others down).
 */
export function applyOrder<T>(items: readonly T[], order: readonly string[], idOf: (item: T) => string, unknown: "first" | "last" = "last") {
  const rank = rankOf(order);
  const listed = items.filter((item) => rank(idOf(item)) !== undefined).sort((a, b) => rank(idOf(a))! - rank(idOf(b))!);
  const unlisted = items.filter((item) => rank(idOf(item)) === undefined);
  return unknown === "first" ? [...unlisted, ...listed] : [...listed, ...unlisted];
}

/** Moves `id` next to `anchor`. Returns the list unchanged when either is missing or they are the same. */
export function moveId(ids: readonly string[], id: string, anchor: string, position: DropPosition) {
  if (id === anchor || !ids.includes(id) || !ids.includes(anchor)) return [...ids];
  const rest = ids.filter((item) => item !== id);
  const at = rest.indexOf(anchor) + (position === "after" ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * The full list to save after a drag: what the person sees, in that order, followed by items they cannot
 * see right now (filtered out or in a hidden group) in their previously saved order.
 */
export function materialize(shown: readonly string[], saved: readonly string[], all: readonly string[]) {
  const seen = new Set(shown);
  const hidden = applyOrder(
    all.filter((id) => !seen.has(id)),
    saved,
    (id) => id
  );
  return [...new Set([...shown, ...hidden])];
}
