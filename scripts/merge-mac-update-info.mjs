// Joins the arm64 and x64 latest-mac.yml into one, printed to stdout.
// Each macOS runner builds one architecture, so each writes a latest-mac.yml that lists only its own files. Uploaded as
// they are, one would replace the other on the release and that architecture's copies would find no update. The
// installed app picks the file for its own architecture from the joined `files` list.
// Usage: node scripts/merge-mac-update-info.mjs <first latest-mac.yml> <second latest-mac.yml>
import { readFileSync } from "node:fs";

const [first, second] = process.argv.slice(2).map((file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
if (!first || !second) throw new Error("Give the two latest-mac.yml files.");

const version = (text) => text.match(/^version: (.+)$/m)?.[1];
if (!version(first) || version(first) !== version(second)) throw new Error("The two files are not for the same version.");

/** The `files:` block's entries: the indented lines right after `files:`. */
function entries(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("files:");
  if (start < 0) throw new Error("A latest-mac.yml has no files list.");
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("  ")) end++;
  if (end === start + 1) throw new Error("A latest-mac.yml has an empty files list.");
  return { lines, start, end };
}

const base = entries(first);
const added = entries(second);
const urls = (block) => block.lines.slice(block.start + 1, block.end).filter((line) => /^ {2}- url: /.test(line));
const seen = new Set(urls(base));
if (urls(added).some((line) => seen.has(line))) throw new Error("Both files list the same download. Were they built for the same architecture?");

const merged = [...base.lines.slice(0, base.end), ...added.lines.slice(added.start + 1, added.end), ...base.lines.slice(base.end)];
process.stdout.write(merged.join("\n"));
