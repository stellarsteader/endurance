import assert from "node:assert/strict";
import { createServer } from "node:http";
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = await mkdtemp(join(tmpdir(), "endurance-smoke-"));
const localAuth = [];
const localBodies = [];
const fixture = createServer(async (req, res) => {
  localAuth.push(req.headers.authorization ?? "");
  if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-chat" }] })); return; }
  if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
  let body = ""; for await (const part of req) body += part;
  const request = JSON.parse(body);
  localBodies.push(request);
  assert.equal(request.model, "fixture-chat");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "로컬 IPC 스트림 연결 확인" } }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureURL = `http://127.0.0.1:${fixture.address().port}/v1`;
// A second server added by curl command: it answers only with its own Bearer key and access header.
const remoteRequests = [];
const remoteFixture = createServer(async (req, res) => {
  remoteRequests.push({ url: req.url, auth: req.headers.authorization, access: req.headers["x-access"] });
  if (req.headers.authorization !== "Bearer remote-key" || req.headers["x-access"] !== "tok") { res.writeHead(401); res.end(); return; }
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "fixture-remote", owned_by: "vllm" }] })); return; }
  if (req.url === "/version") { res.end(JSON.stringify({ version: "0.12.0" })); return; }
  if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
  let body = ""; for await (const part of req) body += part;
  assert.equal(JSON.parse(body).model, "fixture-remote");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "원격 서버 응답 확인" } }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => remoteFixture.listen(0, "127.0.0.1", resolve));
const remoteURL = `http://127.0.0.1:${remoteFixture.address().port}/v1`;
// A stand-in for the Endurance vLLM manager (server/): it starts a model, reports it starting then ready, and
// remembers the windows it was asked to start at. Every request must carry its token.
const manager = { model: { id: "Qwen/Qwen3-8B", status: "stopped", window: undefined }, starts: [], auth: [] };
const managerServer = createServer(async (req, res) => {
  manager.auth.push(req.headers.authorization);
  if (req.headers.authorization !== "Bearer manager-key") { res.writeHead(401); res.end("{}"); return; }
  let raw = ""; for await (const part of req) raw += part;
  const url = new URL(req.url, "http://manager");
  const send = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
  const model = manager.model;
  if (url.pathname === "/manager/info") return send({ version: "1", image: "vllm/vllm-openai:latest", gpu: { name: "GB10", memoryBytes: 128 * 1024 ** 3 } });
  if (url.pathname === "/manager/models") return send({ models: [{ id: model.id, sizeBytes: 16e9, kind: "chat", sampling: { temperature: 0.6, topP: 0.95, topK: 20 }, maxWindow: 40960, weightsBytes: 16e9, status: model.status, ...(model.status === "stopped" ? {} : { window: model.window, share: 0.3, image: "vllm/vllm-openai:latest" }), saved: {} }] });
  if (url.pathname === "/manager/downloads") return send({ downloads: [] });
  if (url.pathname === "/manager/plan") return send({ window: Number(url.searchParams.get("window")) || 40960, share: 0.3, needBytes: 38e9, fits: true, stop: [], message: "" });
  if (url.pathname === `/manager/models/${model.id}/start`) {
    const body = raw ? JSON.parse(raw) : {};
    manager.starts.push(body);
    Object.assign(model, { status: "starting", window: body.window ?? 40960 });
    setTimeout(() => (model.status = "ready"), 800);
    return send({ id: model.id, status: "starting", window: model.window, share: 0.3, image: "vllm/vllm-openai:latest" });
  }
  if (url.pathname === "/v1/models") return send({ object: "list", data: model.status === "ready" ? [{ id: model.id, object: "model", owned_by: "vllm", max_model_len: model.window }] : [] });
  res.writeHead(404); res.end("{}");
});
await new Promise((resolve) => managerServer.listen(0, "127.0.0.1", resolve));
const managerURL = `http://127.0.0.1:${managerServer.address().port}/v1`;
delete process.env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.ENDURANCE_APP_EXECUTABLE;
const application = await electron.launch({ executablePath, args: [...(executablePath ? [] : ["."]), `--user-data-dir=${profile}`], cwd: process.cwd(), timeout: 30000 });
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("textarea", { timeout: 20000 });
  assert.equal(await page.title(), "Endurance");
  assert.equal(page.url(), "endurance://app/index.html");
  assert.equal(await page.evaluate(() => window.endurance?.platform), "darwin");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/macos-desktop.png" });

  // Connections belong to the main process; the renderer edits them through its API.
  // Only Ollama is listed on a fresh profile; vLLM is added the way the Connections menu adds it.
  await page.evaluate(async (baseUrl) => {
    await window.endurance.addRuntime("vllm");
    await window.endurance.updateConnection("vllm", { baseUrl });
  }, fixtureURL);
  await page.evaluate(() => {
    // The store writes its first save shortly after launch; it may not be there yet.
    const saved = JSON.parse(localStorage.getItem("endurance:v1")) ?? {};
    saved.settings = { model: "local:vllm:fixture-chat", effort: "high", defaultApproval: "auto", webSearch: false };
    localStorage.setItem("endurance:v1", JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByRole("button", { name: /fixture-chat/ })).toBeVisible({ timeout: 15000 });
  await page.locator("textarea").fill("안녕");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator("body")).toContainText("로컬 IPC 스트림 연결 확인", { timeout: 20000 });
  await page.screenshot({ path: "artifacts/macos-local-chat-fixture.png" });
  console.log("PASS: renderer → native bridge → extracted core → loopback model fixture → renderer");

  // The request is recorded by the main process and the chat lives in the history database.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const requests = page.getByRole("region", { name: "Requests" });
  await expect(requests.getByText("fixture-chat", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(requests.getByText(/^5 in · 7 out/)).toBeVisible();
  await page.screenshot({ path: "artifacts/macos-history.png" });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("endurance:v1")).threads), undefined);
  await expect
    .poll(() => page.evaluate(async () => (await window.enduranceHistory.sessions()).some((session) => session.title === "안녕" && session.messageCount === 2)))
    .toBe(true);
  console.log("PASS: local-model request recorded with usage; chats are not kept in localStorage");

  // An attached document goes to the main process once; the message names it, and the worker reads its text.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: "prices.csv", mimeType: "text/csv", buffer: Buffer.from("tier,price\nteam,13\n") });
  await page.locator("textarea").fill("What does a team seat cost?");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect.poll(() => localBodies.some((request) => JSON.stringify(request.messages).includes("| team | 13 |")), { timeout: 20000 }).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const history = window.enduranceHistory;
        const chats = await Promise.all((await history.sessions()).map((session) => history.messages(session.id)));
        return chats.some((messages) => messages.some((message) => message.parts?.some((part) => part.type === "file" && /^attachment:[a-f0-9]{64}$/.test(part.url))));
      })
    )
    .toBe(true);
  console.log("PASS: an attached CSV is kept by the main process, named in history, and read into a table for the model");
  // PDF, Excel and Word go through libraries bundled into the worker; each is read in the packaged layout too.
  const pdfText = "Launch in Seoul on March 14.";
  const pdfObjects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${`BT /F1 12 Tf 72 720 Td (${pdfText}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 72 720 Td (${pdfText}) Tj ET\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = pdfObjects.map((body, index) => {
    const at = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  pdf += `xref\n0 ${pdfObjects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${pdfObjects.length + 1} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Seats").addRow(["Tier", "Total"]);
  book.getWorksheet("Seats").addRow(["Team", { formula: "4*13", result: 52 }]);
  const { default: JSZip } = await import("jszip");
  const docx = new JSZip();
  docx.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  docx.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  docx.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word says the code is BLUE HERON.</w:t></w:r></w:p></w:body></w:document>');
  await page.locator('input[type="file"]').first().setInputFiles([
    { name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf, "latin1") },
    { name: "seats.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) },
    { name: "notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await docx.generateAsync({ type: "nodebuffer" }) },
  ]);
  await page.locator("textarea").fill("Summarize the three files.");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect
    .poll(() => {
      const sent = JSON.stringify(localBodies.at(-1)?.messages ?? []);
      return sent.includes(pdfText) && sent.includes("| Team | 52 |") && sent.includes("BLUE HERON");
    }, { timeout: 30000 })
    .toBe(true);
  console.log("PASS: PDF, Excel and Word attachments are read by the worker's bundled libraries");

  // Changing the key encrypts everything again: attachments get new names and the old files are removed.
  const attachmentNames = () =>
    page.evaluate(async () => {
      const history = window.enduranceHistory;
      const chats = await Promise.all((await history.sessions()).map((session) => history.messages(session.id)));
      return chats.flatMap((messages) => messages.flatMap((message) => (message.parts ?? []).filter((part) => part.type === "file" && part.url?.startsWith("attachment:")).map((part) => part.url.slice(11))));
    });
  const oldNames = await attachmentNames();
  assert.ok(oldNames.length > 0);
  assert.deepEqual(await page.evaluate(() => window.enduranceHistory.rotateKey()), { status: "open", hasRecovery: false });
  const newNames = await attachmentNames();
  const kept = await readdir(join(profile, "attachments"));
  assert.equal(newNames.length, oldNames.length);
  assert.ok(newNames.every((name) => !oldNames.includes(name) && kept.includes(name)), "new names, each kept");
  assert.ok(!kept.some((name) => oldNames.includes(name.slice(0, 64))), "old files removed");
  console.log("PASS: changing the key encrypts history and attachments again under new names");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  // A server added by curl command with a Bearer key and a custom header, used in the same chat as local vLLM.
  const added = await page.evaluate((input) => window.endurance.addServer({ input }), `curl ${remoteURL}/chat/completions -H "Authorization: Bearer remote-key" -H "X-Access: tok"`);
  assert.equal(added.kind, "vllm");
  assert.match(added.connection.id, /^srv-/);
  assert.equal(added.connection.secrets.hasKey, true);
  assert.deepEqual(added.connection.secrets.headerNames, ["X-Access"]);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.keyboard.press("Meta+Shift+O");
  const choose = async (name) => {
    await page.keyboard.press("Meta+/");
    const search = page.locator('input[placeholder="Search models…"]:visible').last();
    await search.fill(name);
    await page.keyboard.press("Enter");
    await expect(search).toBeHidden();
    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  };
  await choose("fixture-remote");
  await page.locator("textarea:visible").fill("원격");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator("body")).toContainText("원격 서버 응답 확인", { timeout: 20000 });
  await choose("fixture-chat");
  await page.locator("textarea:visible").fill("다시 로컬");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator("body")).toContainText("로컬 IPC 스트림 연결 확인", { timeout: 20000 });
  await page.screenshot({ path: "artifacts/macos-local-and-remote-chat.png" });
  // Each server received only its own credentials.
  assert.ok(localAuth.every((value) => !value.includes("remote-key")));
  assert.ok(remoteRequests.some((request) => request.url === "/v1/chat/completions"));
  assert.ok(remoteRequests.every((request) => request.auth === "Bearer remote-key" && request.access === "tok"));
  console.log("PASS: local vLLM and a keyed server added by curl alternate in one chat; keys stay with their server");

  // A server running the Endurance manager: its models start from Models settings, and a new window restarts one there.
  const managed = await page.evaluate((input) => window.endurance.addServer({ input, apiKey: "manager-key", name: "GPU box" }), managerURL);
  assert.equal(managed.kind, "vllm");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const section = page.getByRole("region", { name: "GPU box models" });
  // The manager's own view: each model with its state, which a plain server list does not show.
  await expect(section).toContainText("Stopped", { timeout: 15000 });
  await section.getByRole("button", { name: "Start", exact: true }).click();
  await expect(section).toContainText("Ready", { timeout: 15000 });
  assert.deepEqual(manager.starts[0], {}, "started at the most that fits");
  await section.getByRole("button", { name: "Qwen/Qwen3-8B settings", exact: true }).click();
  await section.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(section.getByLabel("Temperature with thinking on")).toHaveAttribute("placeholder", "0.6");
  await section.getByLabel("Context length for Qwen/Qwen3-8B").click();
  await page.getByRole("option", { name: "16K", exact: true }).click();
  await section.getByRole("button", { name: "Save and restart", exact: true }).click();
  await expect.poll(() => manager.starts.at(-1)?.window).toBe(16384);
  await expect(section).toContainText("Ready", { timeout: 15000 });
  await page.screenshot({ path: "artifacts/macos-managed-server.png" });
  assert.ok(manager.auth.every((value) => value === "Bearer manager-key"), "every manager request carries its token");
  console.log("PASS: a managed vLLM server's model starts from Models settings and restarts at a new window");
  assert.deepEqual(errors, []);
  const info = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion(), name: app.getName(), userData: app.getPath("userData"), sessionData: app.getPath("sessionData") }));
  assert.equal(info.name, info.packaged ? "Endurance" : "Endurance Dev");
  assert.equal(info.userData, profile);
  assert.equal(info.sessionData, profile);
  console.log(JSON.stringify({ ...info, renderer: page.url(), pageErrors: errors, profile }, null, 2));
  await application.close();
  // Chats and attachments are encrypted on disk: nothing written or attached is readable in the profile.
  const stored = await Promise.all(["history.sqlite", "history.sqlite-wal"].map((name) => readFile(join(profile, name)).catch(() => Buffer.alloc(0))));
  const attached = await Promise.all((await readdir(join(profile, "attachments"))).map((name) => readFile(join(profile, "attachments", name))));
  for (const text of ["안녕", "What does a team seat cost?", "tier,price", pdfText]) assert.ok(![...stored, ...attached].some((bytes) => bytes.includes(Buffer.from(text))), text);
  console.log("PASS: chats and attachments are encrypted in the profile");
  // Reopen the same disposable profile: the chat comes back from the history database.
  const reopened = await electron.launch({ executablePath, args: [...(executablePath ? [] : ["."]), `--user-data-dir=${profile}`], cwd: process.cwd(), timeout: 30000 });
  try {
    const again = await reopened.firstWindow();
    await again.waitForSelector("textarea", { timeout: 20000 });
    await expect(again.getByRole("button", { name: "안녕", exact: true })).toBeVisible({ timeout: 10000 });
    console.log("PASS: chats persist across restarts in the history database");
  } finally {
    await reopened.close();
  }
} finally {
  await application.close().catch(() => {});
  fixture.closeAllConnections();
  remoteFixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((resolve) => remoteFixture.close(resolve));
  managerServer.closeAllConnections();
  await new Promise((resolve) => managerServer.close(resolve));
}
