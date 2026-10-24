/**
 * Skill discovery: a skill is a SKILL.md file whose frontmatter names and describes it. Portions derived from
 * opencode (MIT; notice: vendor/LICENSE).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { IGNORED } from "./workspace-tools";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}
export interface SkillContent extends SkillInfo {
  content: string;
}

const MAX_SKILL_BYTES = 256_000;

/** Parsed frontmatter by file; a file is read again only when its size or modification time changes. */
const parsed = new Map<string, { mtimeMs: number; size: number; info: SkillInfo }>();

export function parseSkill(text: string, file: string): SkillInfo {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1].toLowerCase()] = field[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    name: (fields.name || path.basename(path.dirname(file))).slice(0, 80),
    description: (fields.description ?? "").slice(0, 1024),
    path: file,
  };
}

export function skillBody(text: string) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export async function scanSkills(root: string, limit = 200): Promise<SkillInfo[]> {
  const found: SkillInfo[] = [];
  const walk = async (directory: string, depth: number) => {
    if (depth > 4 || found.length >= limit) return;
    const items = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (found.length >= limit) return;
      if (IGNORED.has(item.name) || item.isSymbolicLink()) continue;
      const child = path.join(directory, item.name);
      if (item.isDirectory()) await walk(child, depth + 1);
      else if (item.isFile() && item.name === "SKILL.md") {
        const stat = await fs.stat(child);
        if (stat.size > MAX_SKILL_BYTES) continue;
        const cached = parsed.get(child);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          found.push(cached.info);
          continue;
        }
        const info = parseSkill(await fs.readFile(child, "utf8"), child);
        parsed.set(child, { mtimeMs: stat.mtimeMs, size: stat.size, info });
        found.push(info);
      }
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(file: string): Promise<SkillContent> {
  const stat = await fs.stat(file);
  if (stat.size > MAX_SKILL_BYTES) throw new Error("Skill file is too large.");
  const text = await fs.readFile(file, "utf8");
  return { ...parseSkill(text, file), content: skillBody(text) };
}

const words = (value: string) => value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/** A skill is used when the message names it, as "release notes", "release-notes" or "/release-notes". */
export function mentionedSkills<T extends { name: string }>(text: string, skills: T[]) {
  // Separate Latin names from attached particles such as "delegation을".
  const spaced = text
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/([A-Za-z0-9])(?=[^\p{ASCII}])/gu, "$1 ")
    .replace(/([^\p{ASCII}])(?=[A-Za-z0-9])/gu, "$1 ");
  const message = ` ${words(spaced)} `;
  return skills.filter((skill) => {
    const name = words(skill.name);
    return name.length >= 3 && message.includes(` ${name} `);
  });
}

/**
 * How skills reach a model. Every request carries the catalog of enabled skills (name and description),
 * so the model knows what is installed. A skill's instructions are loaded only when the person names it
 * or the agent chooses it with use_skill. Paths come from the main process and never reach the model.
 */
export type SkillEntry = SkillInfo;

const DESCRIPTION_CHARS = 150;

/** A window assumed when the runtime reports none, as before budgets followed the window. */
const UNKNOWN_WINDOW = 32_000;

/** About 4% of the context window for the catalog, so a long list never crowds out the conversation. */
const catalogBudget = (contextWindow?: number) => Math.round((contextWindow ?? UNKNOWN_WINDOW) * 0.04 * 3);

/** Characters of skill instructions per request: about 15% of the context window. */
export const skillBudget = (contextWindow?: number) => Math.round((contextWindow ?? UNKNOWN_WINDOW) * 0.15 * 3);

const terms = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** Skills whose name or description shares words with the request come first, so they keep their descriptions. */
function rank<T extends SkillInfo>(skills: T[], request: string) {
  const asked = terms(request);
  const score = (skill: T) => [...terms(`${skill.name.replace(/[-_]/g, " ")} ${skill.description}`)].filter((term) => asked.has(term)).length;
  return skills
    .map((skill, index) => ({ skill, index, score: score(skill) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.skill);
}

const catalogLine = (skill: SkillInfo) => {
  const description = skill.description.length > DESCRIPTION_CHARS ? `${skill.description.slice(0, DESCRIPTION_CHARS - 1)}…` : skill.description;
  return `- ${skill.name}${description ? `: ${description}` : ""}`;
};

/**
 * Said when no skill is turned on, so the model knows what skills are in Endurance and that none are on. A plain
 * fact rather than "if the user asks…": small models follow a stated fact and pass over a condition. The same
 * every time, so the prompt stays cacheable; Library shows why none are on.
 */
const NO_SKILLS = "In Endurance, skills are instruction sets the user turns on in Library; none are on.";

/**
 * The installed skills for the system prompt. While every description fits, they keep the order they come in,
 * so the prompt is the same from one message to the next and the runtime can reuse its cache of it. Only when
 * some must be listed by name alone do the ones that match the request keep their descriptions.
 */
export function skillCatalog(skills: SkillEntry[] | undefined, request: string, contextWindow: number | undefined, howToUse: string) {
  if (!skills?.length) return NO_SKILLS;
  let budget = catalogBudget(contextWindow);
  const fits = skills.reduce((total, skill) => total + catalogLine(skill).length, 0) <= budget;
  const described: string[] = [];
  const named: string[] = [];
  for (const skill of fits ? skills : rank(skills, request)) {
    const line = catalogLine(skill);
    if (line.length <= budget) {
      described.push(line);
      budget -= line.length;
    } else named.push(skill.name);
  }
  return [
    "Skills the user installed and turned on in Library. They are instructions you can follow, not files in the project; never look for them in the project folders.",
    ...described,
    named.length ? `Also installed: ${named.join(", ")}.` : "",
    howToUse,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The catalog entry a model meant, matched the same way a message names a skill. */
export function findSkill<T extends { name: string }>(skills: T[] | undefined, name: string | undefined) {
  if (!skills || !name) return undefined;
  return skills.find((skill) => words(skill.name) === words(name));
}
