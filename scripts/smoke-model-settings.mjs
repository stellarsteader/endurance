// Isolated Electron profile with injected HTTP responses. No real runtime or user profile is modified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const profile = await mkdtemp(join(tmpdir(), "endurance-model-settings-"));
const base = "http://fixture.endurance.invalid";
// Same shape as the Ollama registry config for qwen3.5:4b-mlx; served only by the fixture below.
const libraryConfig = JSON.stringify({
  model_format: "safetensors",
  file_type: "nvfp4",
  requires: "0.19.0",
  capabilities: ["completion", "vision", "thinking"],
});
const libraryDigest = `sha256:${createHash("sha256").update(libraryConfig).digest("hex")}`;
delete process.env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  args: [".", `--user-data-dir=${profile}`],
  cwd: process.cwd(),
  timeout: 30000,
});
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("textarea", { timeout: 20000 });
  assert.equal(
    await page.evaluate(() => typeof window.enduranceModels?.details),
    "function",
  );
  // Keep real renderer/preload/IPC; replace HTTP at the main-process boundary.
  await application.evaluate((_electron, { base, libraryConfig, libraryDigest }) => {
    const original = globalThis.fetch;
    const state = {
      // The Modelfile's num_ctx, and the window the loaded instance runs with; they differ after a write.
      context: 4096,
      loaded: true,
      loadedContext: 4096,
      installed: false,
      libraryInstalled: false,
      remote: "ok",
      hubQueries: [],
      operations: [],
    };
    globalThis.__modelFixture = state;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://registry.ollama.ai") {
        if (url.pathname === "/v2/library/qwen3.5/manifests/4b-mlx")
          return Response.json({
            schemaVersion: 2,
            config: { digest: libraryDigest, size: libraryConfig.length },
            layers: [
              { mediaType: "application/vnd.ollama.image.tensor", size: 3_000_000_000 },
              { mediaType: "application/vnd.ollama.image.tensor", size: 973_304_734 },
            ],
          });
        if (url.pathname === `/v2/library/qwen3.5/blobs/${libraryDigest}`)
          return new Response(null, {
            status: 307,
            headers: { Location: "https://storage.fixture.endurance.invalid/config" },
          });
        return new Response("{}", { status: 404 });
      }
      // A remote server reached by a pasted curl command: Bearer key plus an access header.
      if (url.origin === "https://gpu.fixture-remote.test") {
        const headers = new Headers(init?.headers);
        if (headers.get("authorization") !== "Bearer remote-key" || headers.get("x-access") !== "tok") return new Response("", { status: 401 });
        if (state.remote === "starting") return new Response("", { status: 503 });
        if (state.remote === "ended") return new Response("", { status: 404 });
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fixture-remote", owned_by: "vllm" }] });
        if (url.pathname === "/version") return Response.json({ version: "0.12.0" });
        return new Response("", { status: 404 });
      }
      if (url.origin === "https://storage.fixture.endurance.invalid")
        return new Response(libraryConfig);
      if (url.origin === "https://huggingface.co") {
        if (url.pathname === "/api/models")
          state.hubQueries.push(url.searchParams.get("search"));
        const model = {
          id: "fixture/Model-GGUF",
          gated: false,
          downloads: 100,
          siblings: [{ rfilename: "Model-Q4_K_M.gguf", size: 4_000_000_000 }],
        };
        return Response.json(url.pathname === "/api/models" ? [model] : model);
      }
      if (url.origin !== base) return original(input, init);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const route = url.pathname;
      if (route === "/api/version") return Response.json({ version: "0.40.5" });
      if (route === "/api/tags")
        return Response.json({
          models: [
            { name: "qwen:latest", details: { quantization_level: "Q4_K_M" } },
            ...(state.installed
              ? [{ name: "hf.co/fixture/Model-GGUF:Q4_K_M" }]
              : []),
            ...(state.libraryInstalled
              ? [{ name: "qwen3.5:4b-mlx", details: { quantization_level: "nvfp4" } }]
              : []),
          ],
        });
      if (route === "/api/show")
        return Response.json({
          parameters: `num_ctx ${state.context}`,
          model_info: { "qwen.context_length": 32768 },
          capabilities: ["completion", "tools"],
        });
      if (route === "/api/ps")
        return Response.json({
          models: state.loaded
            ? [{ name: "qwen:latest", context_length: state.loadedContext }]
            : [],
        });
      if (route === "/api/create") {
        state.operations.push({ url: route, body });
        state.context = body.parameters.num_ctx;
        return Response.json({ status: "success" });
      }
      if (route === "/api/generate") {
        state.operations.push({ url: route, body });
        state.loaded = body.keep_alive !== 0;
        if (state.loaded) state.loadedContext = body.options?.num_ctx ?? state.context;
        return Response.json({ done: true });
      }
      if (route === "/api/pull" && body.model === "qwen3.5:4b-mlx") {
        state.operations.push({ url: route, body });
        // Held open until the smoke test releases it, so navigation happens mid-download.
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode('{"status":"pulling","digest":"mlx","total":3973304734,"completed":1500000000}\n'));
              await new Promise((resolve) => {
                globalThis.__releasePull = resolve;
              });
              state.libraryInstalled = true;
              controller.enqueue(encoder.encode('{"status":"success"}\n'));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      if (route === "/api/pull") {
        state.operations.push({ url: route, body });
        state.installed = true;
        return new Response(
          '{"status":"pulling","digest":"fixture","total":100,"completed":40}\n{"status":"success"}\n',
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      if (route === "/api/delete" && init?.method === "DELETE") {
        state.operations.push({ url: route, body });
        state.installed = false;
        return new Response(null, { status: 200 });
      }
      if (route === "/empty/v1/models") return Response.json({ data: [] });
      return new Response("{}", { status: 404 });
    };
  }, { base, libraryConfig, libraryDigest });
  // Connections belong to the main process; the renderer edits them through its API.
  await page.evaluate(async (base) => {
    // Only Ollama is listed on a fresh profile; the others are added the way the Connections menu adds them.
    for (const id of ["lmstudio", "vllm", "llamacpp"]) await window.endurance.addRuntime(id);
    await window.endurance.updateConnection("ollama", { baseUrl: `${base}/v1` });
    await window.endurance.updateConnection("lmstudio", { baseUrl: `${base}/empty/v1` });
    await window.endurance.updateConnection("vllm", { baseUrl: `${base}/missing/v1` });
    await window.endurance.updateConnection("llamacpp", { baseUrl: `${base}/missing/v1` });
  }, base);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByText("Connected · v0.40.5 · 1 model", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ollama settings", exact: true })
    .click();
  await expect(
    page.locator("#runtime-settings-ollama").getByLabel("API address"),
  ).toHaveValue(`${base}/v1`);
  await expect(
    page.locator("#runtime-settings-ollama").getByLabel("API key"),
  ).toHaveAttribute("type", "password");
  await page
    .getByRole("button", { name: "Test Ollama connection", exact: true })
    .click();
  await expect(
    page.locator("#runtime-settings-ollama").getByRole("status"),
  ).toContainText(/\d+ ms · v0\.40\.5 · 1 model · qwen:latest loaded/);
  await page.locator("#runtime-settings-ollama").getByLabel("API address").fill(`${base}/broken/v1`);
  await expect(
    page.locator("#runtime-settings-ollama").getByRole("status"),
  ).toHaveText("");
  await page.locator("#runtime-settings-ollama").getByLabel("API address").fill(`${base}/v1`);
  await page.locator("#runtime-settings-ollama").getByLabel("API key").fill("fixture-key");
  await page
    .locator("#runtime-settings-ollama")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  // The typed key is encrypted in the main process, never kept in plain text or in renderer storage.
  await page.waitForTimeout(500);
  const secrets = await readFile(join(profile, "connection-secrets.json"), "utf8");
  assert.ok(JSON.parse(secrets).ollama.apiKey);
  assert.ok(!secrets.includes("fixture-key"));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("endurance:v1")).connections), undefined);
  await page.getByRole("button", { name: "Ollama settings", exact: true }).click();
  await expect(page.locator("#runtime-settings-ollama").getByLabel("API key")).toHaveAttribute("placeholder", "Saved in Keychain");
  await page.locator("#runtime-settings-ollama").getByRole("button", { name: "Cancel", exact: true }).click();

  // Any server by pasted curl command: variables become a key field, the server is identified and labeled Remote.
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page.getByRole("menuitem", { name: /Server URL/ }).click();
  await page
    .getByLabel("Server address or curl command")
    .fill('curl https://gpu.fixture-remote.test/v1/chat/completions -H "Authorization: Bearer $GPU_KEY" -H "X-Access: tok"');
  await expect(page.getByText("gpu.fixture-remote.test/v1", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/model-settings/add-server.png" });
  await page.getByRole("form", { name: "Add a server by address" }).getByLabel("API key").fill("remote-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("placeholder", "gpu.fixture-remote.test");
  await name.fill("GPU box");
  await page.locator('form[id^="runtime-settings-srv-"]').getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("GPU box", { exact: true })).toBeVisible();
  await expect(page.getByText("Connected · 1 model", { exact: true })).toBeVisible();
  const remoteSecrets = JSON.parse(await readFile(join(profile, "connection-secrets.json"), "utf8"));
  const remoteId = Object.keys(remoteSecrets).find((id) => id.startsWith("srv-"));
  assert.ok(remoteSecrets[remoteId].apiKey && remoteSecrets[remoteId].headers);
  assert.ok(!JSON.stringify(remoteSecrets).includes("remote-key") && !JSON.stringify(remoteSecrets).includes('"tok"'));
  await page.screenshot({ path: "artifacts/model-settings/remote-connected.png" });

  // 502/503/504 read as Starting and are checked again automatically; the ready toast follows.
  await application.evaluate(() => { globalThis.__modelFixture.remote = "starting"; });
  await page.getByRole("button", { name: "Refresh GPU box models", exact: true }).click();
  await expect(page.getByText("Starting · checks again on its own", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/model-settings/remote-starting.png" });
  await application.evaluate(() => { globalThis.__modelFixture.remote = "ok"; });
  await expect(page.getByText("GPU box is ready", { exact: true })).toBeVisible({ timeout: 12000 });

  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("region", { name: "GPU box models" }).getByRole("heading", { name: "GPU box", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();

  // A server that answered before and now 404s has ended; removing it deletes its secrets.
  await application.evaluate(() => { globalThis.__modelFixture.remote = "ended"; });
  await page.getByRole("button", { name: "Refresh GPU box models", exact: true }).click();
  await expect(page.getByText(/^Ended · last connected/)).toBeVisible();
  await page.screenshot({ path: "artifacts/model-settings/remote-ended.png" });
  await page.getByRole("button", { name: "GPU box settings", exact: true }).click();
  await page.locator('form[id^="runtime-settings-srv-"]').getByRole("button", { name: "Remove from list", exact: true }).click();
  await page.getByRole("group", { name: "Remove GPU box" }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("GPU box", { exact: true })).toHaveCount(0);
  assert.equal(JSON.parse(await readFile(join(profile, "connection-secrets.json"), "utf8"))[remoteId], undefined);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Models", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const catalog = page.getByRole("region", { name: "Ollama models" });
  await expect(catalog).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "LM Studio models" })
      .getByText("No models yet. Download one below."),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "vLLM models" })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "qwen:latest settings", exact: true })
    .click();
  await expect(page.getByLabel("Context length for qwen:latest")).toContainText(
    "4K",
  );
  await page.getByLabel("Display name for qwen:latest").fill("Work model");
  await page.getByLabel("Context length for qwen:latest").click();
  await page.getByRole("option", { name: "8K", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Thinking for qwen:latest" })).toBeDisabled();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Work model settings", exact: true }),
  ).toBeVisible();
  assert.equal(
    (await application.evaluate(() => globalThis.__modelFixture)).context,
    8192,
  );
  assert.deepEqual(
    (await application.evaluate(() => globalThis.__modelFixture)).operations[0]
      .body,
    {
      from: "qwen:latest",
      model: "qwen:latest",
      parameters: { num_ctx: 8192 },
      stream: false,
    },
  );
  // Saving writes only the Modelfile. The model loaded at the old window stays until its next request, which
  // Ollama serves at the new window (it reloads a runner whose num_ctx differs).
  const written = await application.evaluate(() => globalThis.__modelFixture);
  assert.equal(written.loaded, true);
  assert.equal(written.operations.length, 1);
  await page
    .getByRole("button", { name: "Work model settings", exact: true })
    .click();
  // The setting reads back from the runtime, and nothing loads a model from here.
  await expect(page.getByLabel("Context length for qwen:latest")).toContainText("8K");
  await expect(page.getByRole("button", { name: /^(Load|Unload)$/ })).toHaveCount(0);
  assert.equal((await application.evaluate(() => globalThis.__modelFixture)).operations.length, 1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("switch", { name: "Show Work model in model picker" })
    .click();
  await expect(
    page.getByRole("switch", { name: "Show Work model in model picker" }),
  ).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.keyboard.press("Meta+/");
  await expect(
    page.getByRole("dialog", { name: "Select a model" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option").filter({ hasText: "Work model" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page
    .getByRole("button", { name: "Work model settings", exact: true })
    .click();
  await mkdir("artifacts/model-settings", { recursive: true });
  await page.screenshot({ path: "artifacts/model-settings/models-inline.png" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Search models").fill("Model");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "fixture/Model-GGUF", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Download fixture/Model-GGUF", exact: true })
    .click();
  await expect(page.getByText("Installed", { exact: true })).toBeVisible();
  assert.equal(
    (
      await application.evaluate(() => globalThis.__modelFixture)
    ).operations.find((item) => item.url === "/api/pull").body.model,
    "hf.co/fixture/Model-GGUF:Q4_K_M",
  );
  // The finished download opens its settings with a suggested display name.
  await expect(
    page.getByLabel("Display name for hf.co/fixture/Model-GGUF:Q4_K_M"),
  ).toHaveValue("Model");
  await page.screenshot({ path: "artifacts/model-settings/huggingface.png" });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.screenshot({ path: "artifacts/model-settings/delete-confirm.png" });
  await page
    .getByRole("group", { name: "Delete hf.co/fixture/Model-GGUF:Q4_K_M" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "hf.co/fixture/Model-GGUF:Q4_K_M settings", exact: true }),
  ).toHaveCount(0);
  assert.deepEqual(
    (await application.evaluate(() => globalThis.__modelFixture)).operations.at(-1),
    { url: "/api/delete", body: { model: "hf.co/fixture/Model-GGUF:Q4_K_M" } },
  );
  // A deleted model can be downloaded again.
  await expect(
    page.getByRole("button", { name: "Download fixture/Model-GGUF", exact: true }),
  ).toBeVisible();
  // An Ollama library tag is recognized as typed, checked on the registry only, and pulled by Ollama.
  await page.getByLabel("Search models").fill("ollama pull qwen3.5:4b-mlx");
  await expect(page.getByRole("combobox", { name: "Download runtime" })).toHaveCount(0);
  const hubQueries = (await application.evaluate(() => globalThis.__modelFixture)).hubQueries.length;
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("link", { name: "qwen3.5:4b-mlx", exact: true })).toBeVisible();
  await expect(page.getByText("MLX", { exact: true })).toBeVisible();
  await expect(page.getByText("NVFP4", { exact: true })).toBeVisible();
  await expect(page.getByText("Image", { exact: true })).toBeVisible();
  await expect(page.getByText("3.7 GB", { exact: true })).toBeVisible();
  // The fixture runtime is not loopback, so its hardware is not claimed.
  await expect(page.getByText(/another machine, so Endurance can't check it/)).toBeVisible();
  await page.screenshot({ path: "artifacts/model-settings/ollama-library.png" });
  assert.equal(
    (await application.evaluate(() => globalThis.__modelFixture)).hubQueries.length,
    hubQueries,
  );
  await page.getByRole("button", { name: "Download qwen3.5:4b-mlx", exact: true }).click();
  // Progress lives in the main process: it survives other pages and a renderer reload.
  const downloading = page.getByRole("group", { name: "Downloading qwen3.5:4b-mlx" });
  await expect(downloading.getByRole("status")).toContainText("37%");
  // Progress shows in the result row itself, not again as a separate row.
  await expect(downloading).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Download qwen3.5:4b-mlx", exact: true })).toHaveCount(0);
  assert.equal(
    (await application.evaluate(() => globalThis.__modelFixture)).operations.at(-1).body.model,
    "qwen3.5:4b-mlx",
  );
  await page.screenshot({ path: "artifacts/model-settings/download-models-page.png" });
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("img", { name: "Downloading, 37%" })).toBeVisible();
  await page.screenshot({ path: "artifacts/model-settings/download-settings-nav.png" });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  const indicator = page.getByRole("button", { name: /^qwen3\.5:4b-mlx, 37%.*Open Models settings$/ });
  await expect(indicator).toBeVisible();
  await page.reload();
  await expect(indicator).toBeVisible();
  await page.screenshot({ path: "artifacts/model-settings/download-sidebar.png" });
  await application.evaluate(() => globalThis.__releasePull());
  await expect(indicator).toHaveCount(0);
  await expect(page.getByText("qwen3.5:4b-mlx is ready", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/model-settings/download-ready-toast.png" });
  await page.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(page.getByLabel("Display name for qwen3.5:4b-mlx")).toHaveValue("Qwen3.5 4B MLX");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Search models").fill("qwen3.5:4b-mlx");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByText("Installed", { exact: true })).toBeVisible();
  // The renderer names connections by ID; an address it supplies is never used, and unknown IDs are refused.
  const stale = await page.evaluate(async () => {
    const attempt = (target) => window.enduranceModels.details(target, "qwen").then(() => "unexpected", (error) => String(error));
    return [await attempt({ connectionId: "srv-doesnotexist1" }), await attempt({ runtime: "ollama", connection: { baseUrl: "http://localhost:1/v1", apiKey: "" } })];
  });
  for (const message of stale) assert.match(message, /no longer listed/);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Electron preload/IPC, current Connections UI, connection test and keychain-stored keys, connected-only Models, context written to the Modelfile without loading or releasing the model, and no Load/Unload controls, aliases, picker visibility, HF search/file/pull/progress/refresh, server by curl with key field, Starting/ready/Ended/remove, Ollama library tag check/pull, downloads across pages and reloads with ready toast, model delete and rejection of unknown or renderer-supplied connections",
  );
  console.log(
    "Fixtures only: no real runtime, Hugging Face or Ollama registry request, or model download was performed.",
  );
} finally {
  await application.close();
}
