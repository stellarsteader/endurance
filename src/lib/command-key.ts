/**
 * What "Always allow" remembers for a shell command: its key, the program plus its first subcommand-like word
 * (`npm test`, `git status`, `pytest`, `ls`). Allowing a key allows later commands with the same key in that chat,
 * whatever their other arguments.
 * - Leading environment assignments (FOO=1) are skipped. So is `sudo` when finding the program, but it stays at the
 *   front of the key (`sudo npm install`), so allowing a command never allows it as root.
 * - The subcommand is the word after the program, if it is a plain word: one that starts with `-`, contains `/` or
 *   `.`, or has quotes, `$`, `=` or globs ends the key there.
 * - A chain (`&&`, `||`, `;`, `|`, `&`, a new line) has a key per part. It is covered only when every part's key is
 *   allowed (coveredBy), so `npm test && rm -rf build` still asks after `npm test` was allowed.
 * - A command that substitutes (`$(…)`, backticks), redirects to a file or opens a subshell has no key and always
 *   asks. Sending output to another stream (2>&1) or to /dev/null is fine.
 * Pure, shared by the renderer (the approval card names the key) and the harness (shell.ts needsApproval).
 */

/** Redirections that write nothing: one stream into another, or into /dev/null. */
const HARMLESS_REDIRECT = /\s*(?:\d*|&)>>?\s*(?:&\d+|\/dev\/null)(?=\s|$|[;&|])/g;
/** What makes a command's effect depend on more than its words. */
const OPAQUE = /`|\$\(|[<>()]/;
const CHAIN = /\|\||&&|[;|&\n]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WORD = /^[A-Za-z0-9][\w:@+-]*$/;
/** Programs whose next word is a name to make, never a subcommand: allowing `mkdir build` allows making folders. */
const NAMES_FOLLOW = new Set(["mkdir", "touch"]);

/** The key of one simple command, or undefined when it has none. */
function keyOf(part: string): string | undefined {
  const words = part.trim().split(/\s+/).filter(Boolean);
  let at = 0;
  let root = false;
  for (; at < words.length && (ASSIGNMENT.test(words[at]) || words[at] === "sudo"); at++) root ||= words[at] === "sudo";
  const program = words[at];
  if (!program || program.startsWith("-") || /["'$*?]/.test(program)) return undefined;
  const sub = words[at + 1];
  const key = sub && WORD.test(sub) && !NAMES_FOLLOW.has(program) ? `${program} ${sub}` : program;
  return root ? `sudo ${key}` : key;
}

/** The distinct keys of every part of the command, in order; empty when the command cannot be remembered. */
export function commandKeys(command: string): string[] {
  const text = command.replace(HARMLESS_REDIRECT, "");
  if (!text.trim() || OPAQUE.test(text)) return [];
  const keys: string[] = [];
  for (const part of text.split(CHAIN)) {
    if (!part.trim()) continue;
    const key = keyOf(part);
    if (!key) return [];
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The key of the command's first part, which the approval card names; "" when it cannot be remembered. */
export const commandKey = (command: string): string => commandKeys(command)[0] ?? "";

/** Whether the command runs without asking: every part's key is allowed. */
export function coveredBy(command: string, allowed: ReadonlySet<string>): boolean {
  const keys = commandKeys(command);
  return keys.length > 0 && keys.every((key) => allowed.has(key));
}
