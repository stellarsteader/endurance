/**
 * Folder access semantics. Portions derived from opencode (MIT; notice: ../harness/vendor/LICENSE).
 * Restrictions are inherited by descendants and a child cannot weaken a parent rule.
 * Pure functions only: the renderer uses them for display and the chat worker for enforcement.
 */
export type Access = "write" | "read" | "none";

export interface WorkspaceFolder {
  path: string;
  access: Access;
}
export interface AccessRule {
  path: string;
  access: Access;
}
export interface WorkspacePolicy {
  folders: WorkspaceFolder[];
  rules: AccessRule[];
}

export const EMPTY_POLICY: WorkspacePolicy = { folders: [], rules: [] };
export const ACCESS_LEVELS: Access[] = ["write", "read", "none"];
export const ACCESS_LABEL: Record<Access, string> = { write: "Read & write", read: "Read only", none: "No access" };
/** New projects start writable; folders added later start read only, as in the original project defaults. */
export const FIRST_FOLDER_ACCESS: Access = "write";
export const ADDED_FOLDER_ACCESS: Access = "read";

const rank: Record<Access, number> = { write: 0, read: 1, none: 2 };
const stricter = (a: Access, b: Access) => (rank[a] >= rank[b] ? a : b);
export const isAccess = (value: unknown): value is Access => value === "write" || value === "read" || value === "none";

export const within = (root: string, target: string) =>
  target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);

const matching = (policy: WorkspacePolicy, target: string) => [
  ...policy.folders.filter((folder) => within(folder.path, target)),
  ...policy.rules.filter((rule) => within(rule.path, target)),
];

export function rootOf(policy: WorkspacePolicy, target: string) {
  return policy.folders.find((folder) => within(folder.path, target));
}

/** Effective access: the strictest rule on the path or any ancestor. Paths outside every folder have no access. */
export function accessFor(policy: WorkspacePolicy, target: string): Access {
  const matched = matching(policy, target);
  if (!rootOf(policy, target)) return "none";
  return matched.reduce<Access>((level, rule) => stricter(level, rule.access), "write");
}

/** The strictest ancestor rule, excluding a rule set on the path itself. */
export function inheritedFrom(policy: WorkspacePolicy, target: string): AccessRule | undefined {
  return matching(policy, target)
    .filter((rule) => rule.path !== target)
    .sort((a, b) => rank[b.access] - rank[a.access] || b.path.length - a.path.length)[0];
}

export function allowedLevels(policy: WorkspacePolicy, target: string): Access[] {
  const parent = inheritedFrom(policy, target);
  return parent ? ACCESS_LEVELS.filter((level) => rank[level] >= rank[parent.access]) : ACCESS_LEVELS;
}

export function hasOwnRule(policy: WorkspacePolicy, target: string) {
  return policy.folders.some((folder) => folder.path === target) || policy.rules.some((rule) => rule.path === target);
}

export function setAccess(policy: WorkspacePolicy, target: string, access: Access): WorkspacePolicy {
  if (!allowedLevels(policy, target).includes(access)) return policy;
  const root = policy.folders.some((folder) => folder.path === target);
  const folders = policy.folders.map((folder) => (folder.path === target ? { ...folder, access } : folder));
  const rules = root
    ? policy.rules
    : [...policy.rules.filter((rule) => rule.path !== target), { path: target, access }];
  // Drop descendant rules that the new level makes redundant, so the saved policy stays readable.
  const next = { folders, rules };
  return {
    folders,
    rules: rules.filter((rule) => {
      if (rule.path === target || !within(target, rule.path)) return true;
      const parent = inheritedFrom(next, rule.path);
      return !parent || rank[rule.access] > rank[parent.access];
    }),
  };
}

export function clearRule(policy: WorkspacePolicy, target: string): WorkspacePolicy {
  return { ...policy, rules: policy.rules.filter((rule) => rule.path !== target) };
}

export function addFolder(policy: WorkspacePolicy, path: string, access: Access): { policy: WorkspacePolicy; error?: string } {
  const inside = policy.folders.find((folder) => within(folder.path, path));
  if (inside) return { policy, error: `${folderName(path)} is already in ${folderName(inside.path)}.` };
  const contains = policy.folders.find((folder) => within(path, folder.path));
  if (contains) return { policy, error: `${folderName(path)} contains ${folderName(contains.path)}. Remove it first.` };
  return { policy: { ...policy, folders: [...policy.folders, { path, access }] } };
}

export function removeFolder(policy: WorkspacePolicy, path: string): WorkspacePolicy {
  return {
    folders: policy.folders.filter((folder) => folder.path !== path),
    rules: policy.rules.filter((rule) => !within(path, rule.path)),
  };
}

export const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** Stable short names for each folder, used as the first path segment shown to models and people. */
export function folderLabels(policy: WorkspacePolicy) {
  const labels = new Map<string, string>();
  const used = new Set<string>();
  for (const folder of policy.folders) {
    const base = folderName(folder.path);
    let label = base;
    for (let index = 2; used.has(label); index++) label = `${base}-${index}`;
    used.add(label);
    labels.set(folder.path, label);
  }
  return labels;
}

export function displayPath(policy: WorkspacePolicy, absolute: string) {
  const root = rootOf(policy, absolute);
  if (!root) return absolute;
  const label = folderLabels(policy).get(root.path) ?? folderName(root.path);
  const rest = absolute.slice(root.path.length).replace(/^\/+/, "");
  return rest ? `${label}/${rest}` : label;
}

export function sanitizePolicy(value: unknown): WorkspacePolicy {
  const input = value && typeof value === "object" ? (value as Partial<WorkspacePolicy>) : {};
  const entries = (list: unknown, max: number) =>
    (Array.isArray(list) ? list : [])
      .filter(
        (item): item is AccessRule =>
          Boolean(item) &&
          typeof item.path === "string" &&
          item.path.startsWith("/") &&
          item.path.length <= 4096 &&
          !item.path.includes("\0") &&
          isAccess(item.access)
      )
      .slice(0, max)
      .map((item) => ({ path: item.path.replace(/\/+$/, "") || "/", access: item.access }));
  const folders = entries(input.folders, 100);
  return {
    folders,
    rules: entries(input.rules, 500).filter((rule) => folders.some((folder) => within(folder.path, rule.path))),
  };
}
