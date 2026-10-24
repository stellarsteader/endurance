// Projects, folder access, Library skills and the delegating agent through the real renderer, preload and IPC.
// Disposable profile and temporary folders; the native folder dialog is replaced in the main process and the model is
// a loopback fixture, so this checks wiring and enforcement, not model quality.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const profile = await mkdtemp(join(tmpdir(), "endurance-workspace-smoke-"));
const root = await realpath(await mkdtemp(join(tmpdir(), "endurance-workspace-folders-")));
// The project folders are copied so the run never changes the fixture.
await cp("scripts/fixtures/workspace", root, { recursive: true });
const skills = join(root, "skills");
await mkdir(join(skills, "delegate-work"), { recursive: true });
await writeFile(
  join(skills, "delegate-work", "SKILL.md"),
  "---\nname: delegate-work\ndescription: Hand bounded, independent parts of a task to subagents.\n---\n\nGive each subagent one complete task and combine their reports.\n"
);
const launch = join(root, "launch-plan");
const research = join(root, "market-research");
// A profile from before projects moved to the database: workspace.json held a project the renderer no longer lists.
const legacy = join(root, "legacy-notes");
await mkdir(legacy, { recursive: true });
await writeFile(
  join(profile, "workspace.json"),
  JSON.stringify({ grants: [legacy], projects: { legacyP1: { folders: [{ path: legacy, access: "read" }], rules: [] } }, skillFolders: [], disabledSkills: [] })
);

// The fixture model calls tools natively, one step per request, chosen by how many results its conversation holds.
const coordinator = [
  { name: "list", arguments: { path: "launch-plan" } },
  { name: "search", arguments: { query: "price" } },
  { name: "read", arguments: { path: "launch-plan/private/compensation.md" } },
  { name: "write", arguments: { path: "market-research/notes.md", content: "x" } },
  { name: "delegate", arguments: { assignments: [{ name: "Writer", task: "Write launch-plan/drafts/pricing-summary.md from market-research/pricing.md. Return the path." }] } },
  // A check, which Approve for me runs at once, in the macOS sandbox.
  { name: "run_shell", arguments: { command: "ls drafts", cwd: "launch-plan" } },
  "가격 요약을 launch-plan/drafts/pricing-summary.md에 만들었습니다. 보호된 폴더는 열지 않았습니다.",
];
const subagent = [
  { name: "read", arguments: { path: "market-research/pricing.md" } },
  { name: "write", arguments: { path: "launch-plan/drafts/pricing-summary.md", content: "# Pricing summary\n\nTeam plan: $13 per seat.\n" } },
  "Wrote launch-plan/drafts/pricing-summary.md",
];
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const sse = (frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
const text = (content) => sse([{ choices: [{ delta: { content } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }]);
const call = ({ name, arguments: args }) =>
  sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
  ]);
const fixture = createServer(async (req, res) => {
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "fixture-chat" }] }));
  // Other routes a server may be asked (such as /metrics before a subagent runs) are not served.
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
  let raw = "";
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (!body.tools) return res.end(text("가격 요약을 launch-plan/drafts/pricing-summary.md에 만들었습니다. 보호된 폴더는 열지 않았습니다."));
  const script = String(body.messages[0].content).includes("a subagent working for Endurance") ? subagent : coordinator;
  const next = script[body.messages.filter((message) => message.role === "tool").length] ?? "Done.";
  res.end(typeof next === "string" ? text(next) : call(next));
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureURL = `http://127.0.0.1:${fixture.address().port}/v1`;

delete process.env.ELECTRON_RUN_AS_NODE;
const start = () => electron.launch({ args: [".", `--user-data-dir=${profile}`], cwd: process.cwd(), timeout: 30000 });
let application = await start();
try {
  let page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("textarea", { timeout: 20000 });
  // Only Ollama is listed on a fresh profile; vLLM is added the way the Connections menu adds it.
  await page.evaluate(async (baseUrl) => {
    await window.endurance.addRuntime("vllm");
    await window.endurance.updateConnection("vllm", { baseUrl });
  }, fixtureURL);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("endurance:v1")) ?? {};
    saved.settings = { model: "local:vllm:fixture-chat", effort: "high", defaultApproval: "auto", webSearch: false };
    localStorage.setItem("endurance:v1", JSON.stringify(saved));
  });
  await page.reload();
  await page.waitForSelector("textarea", { timeout: 20000 });
  const stored = () => page.evaluate(() => window.enduranceWorkspace.projects());
  // First launch imports the old copies once: here the project only workspace.json still had.
  const imported = await stored();
  assert.deepEqual(imported.find((project) => project.id === "legacyP1")?.access?.folders, [{ path: legacy, access: "read" }]);
  assert.equal(JSON.parse(await readFile(join(profile, "workspace.json"), "utf8")).projects?.legacyP1, undefined);
  console.log("PASS: projects from workspace.json are imported into the database once");
  const pick = (paths) =>
    application.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
    }, paths);
  await mkdir("artifacts/workspace", { recursive: true });

  // Create a project with two folders and a No access subfolder.
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: /New project/ }).click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await dialog.getByPlaceholder("Project name").fill("Lumen launch");
  await pick([launch, research]);
  await dialog.getByRole("button", { name: "Add folder", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Access for launch-plan: Read & write" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Access for market-research: Read only" })).toBeVisible();
  await dialog.getByRole("button", { name: "launch-plan", exact: true }).click();
  await dialog.getByRole("button", { name: "Access for private: Read & write" }).click();
  await page.getByRole("menuitem", { name: "No access" }).click();
  await expect(dialog.getByRole("button", { name: "Access for private: No access" })).toBeVisible();
  await dialog.getByRole("button", { name: "market-research", exact: true }).click();
  await dialog.getByRole("button", { name: "Access for pricing.md: Read only" }).click();
  await expect(page.getByRole("menuitem", { name: "Read & write" })).toHaveAttribute("data-disabled", "");
  await page.screenshot({ path: "artifacts/workspace/access-menu.png" });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "artifacts/workspace/create-project.png" });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  const policy = (await stored()).find((project) => project.name === "Lumen launch").access;
  assert.deepEqual(policy.folders, [{ path: launch, access: "write" }, { path: research, access: "read" }]);
  assert.deepEqual(policy.rules, [{ path: join(launch, "private"), access: "none" }]);
  console.log("PASS: Create project picks folders, inherits access and saves the policy in the main process");

  // Library → Skills: empty, then import a folder.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByText("No skills folder", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/workspace/skills-empty.png" });
  await pick([skills]);
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await expect(page.getByText("delegate-work", { exact: true })).toBeVisible();
  await page.getByText("delegate-work", { exact: true }).click();
  await expect(page.getByText("Give each subagent one complete task and combine their reports.")).toBeVisible();
  await page.screenshot({ path: "artifacts/workspace/skills.png" });
  // Library is a page: the sidebar keeps the chats and shows Library as open.
  await expect(page.getByRole("button", { name: "Library", exact: true })).toHaveAttribute("aria-pressed", "true");
  console.log("PASS: Library imports a skills folder and previews SKILL.md");

  // New chat in the project; the agent delegates, is denied twice and writes through a subagent.
  await page.getByRole("button", { name: "Lumen launch options", exact: true }).click({ force: true });
  await page.getByRole("menuitem", { name: "New chat" }).click();
  await page.locator("textarea").fill("delegate work를 써서 가격 요약을 만들고 검색을 해줘");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator("body")).toContainText("가격 요약을 launch-plan/drafts/pricing-summary.md에 만들었습니다", { timeout: 30000 });
  await expect(page.getByRole("button", { name: /^Worked/ })).toBeVisible();
  await page.getByRole("button", { name: /^Worked/ }).click();
  await expect(page.getByText("Used delegate-work")).toBeVisible();
  // Blocked steps read as not done, never as "Read …".
  await expect(page.getByText("Couldn't read launch-plan/private/compensation.md")).toBeVisible();
  await expect(page.getByText("No access", { exact: true })).toBeVisible();
  await expect(page.getByText("Read only", { exact: true })).toBeVisible();
  await expect(page.getByText("Edited launch-plan/drafts/pricing-summary.md")).toBeVisible();
  await page.screenshot({ path: "artifacts/workspace/agent-chat.png" });
  await page.getByRole("button", { name: /Writer/ }).first().click();
  await expect(page.getByText("Wrote launch-plan/drafts/pricing-summary.md").last()).toBeVisible();
  await page.screenshot({ path: "artifacts/workspace/agent-subagent.png" });
  assert.equal(await readFile(join(launch, "drafts", "pricing-summary.md"), "utf8"), "# Pricing summary\n\nTeam plan: $13 per seat.\n");
  assert.equal(existsSync(join(research, "notes.md")), false);
  await page.getByRole("button", { name: "ls drafts" }).click();
  await expect(page.locator("pre").filter({ hasText: "announcement-outline.md" })).toContainText("pricing-summary.md");
  assert.deepEqual(errors, []);
  console.log("PASS: project chat uses the skill, delegates to a subagent, enforces No access and Read only, writes allowed files and runs a sandboxed check");

  // Project settings: a reload right after Save used to restore the old copy and overwrite the saved one.
  await page.getByRole("button", { name: "Lumen launch options", exact: true }).click({ force: true });
  await page.getByRole("menuitem", { name: /Project settings/ }).click();
  let settings = page.getByRole("dialog", { name: "Project settings" });
  await settings.getByPlaceholder("Project name").fill("Lumen launch v2");
  await settings.getByRole("button", { name: "market-research", exact: true }).click();
  await settings.getByRole("button", { name: "Access for pricing.md: Read only" }).click();
  await page.getByRole("menuitem", { name: "No access" }).click();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings).toBeHidden();
  await page.reload();
  await page.waitForSelector("textarea", { timeout: 20000 });
  const expectSaved = async () => {
    const project = (await stored()).find((item) => item.name === "Lumen launch v2");
    assert.ok(project, "renamed project is saved");
    assert.deepEqual(project.access.rules, [
      { path: join(launch, "private"), access: "none" },
      { path: join(research, "pricing.md"), access: "none" },
    ]);
    await expect(page.getByRole("button", { name: "Lumen launch v2 options", exact: true })).toBeAttached();
  };
  await expectSaved();
  await application.close();
  application = await start();
  page = await application.firstWindow();
  await page.waitForSelector("textarea", { timeout: 20000 });
  await expectSaved();
  await page.getByRole("button", { name: "Lumen launch v2 options", exact: true }).click({ force: true });
  await page.getByRole("menuitem", { name: /Project settings/ }).click();
  settings = page.getByRole("dialog", { name: "Project settings" });
  await expect(settings.getByPlaceholder("Project name")).toHaveValue("Lumen launch v2");
  await settings.getByRole("button", { name: "market-research", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Access for pricing.md: No access" })).toBeVisible();
  await page.screenshot({ path: "artifacts/workspace/project-settings-saved.png" });
  console.log("PASS: project settings survive a reload right after Save and an app restart");
  console.log("Loopback fixture only: no real model, Hugging Face request or user profile was used.");
} finally {
  await application.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
