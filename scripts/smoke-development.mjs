// Exercise the real watch command with a disposable profile, without packaging an app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, unlink, utimes, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

if (process.platform === "win32") throw new Error("This watch smoke test uses POSIX process groups; run it on macOS or Linux.");
const profile = await mkdtemp(join(tmpdir(), "endurance-dev-watch-"));
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const productionFiles = ["out/main/index.js", "out/preload/index.cjs"];
const before = await Promise.all(productionFiles.map((file) => readFile(file)));
const probeName = `.dev-hmr-probe-${process.pid}.js`;
const probe = join("src", probeName);
const probeCode = (revision) => `export const revision = ${revision};\nif (import.meta.hot) import.meta.hot.accept(next => { globalThis.__enduranceHmrProbe = next?.revision; });\n`;
const environment = { ...process.env, ELECTRON_CLI_ARGS: JSON.stringify([`--user-data-dir=${profile}`]) };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, ["node_modules/electron-vite/bin/electron-vite.js", "dev", "--watch", "--entry", "out-dev/main/index.js", "--remoteDebuggingPort", String(port)], {
  env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let browser;
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
async function connect() {
  await expect.poll(async () => {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); return true; }
    catch { return false; }
  }, { timeout: 30000 }).toBe(true);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector("textarea", { timeout: 20000 });
  assert.match(page.url(), /^http:\/\/(localhost|127\.0\.0\.1):/);
  assert.equal(await page.evaluate(() => typeof window.endurance?.startChat), "function");
  return page;
}
try {
  let page = await connect();
  await writeFile(probe, probeCode(1));
  assert.equal(await page.evaluate(async (url) => (await import(url)).revision, `/src/${probeName}`), 1);
  await writeFile(probe, probeCode(2));
  await expect.poll(() => page.evaluate(() => globalThis.__enduranceHmrProbe), { timeout: 10000 }).toBe(2);
  console.log("PASS: Vite HMR updates a module inside the running Electron renderer");

  const logStart = output.length;
  const now = new Date();
  await utimes("electron/identity.ts", now, now);
  await expect.poll(() => output.slice(logStart).includes("restarting electron app"), { timeout: 20000 }).toBe(true);
  // A new main process means the previous CDP connection must close.
  await expect.poll(() => browser.isConnected(), { timeout: 10000 }).toBe(false);
  page = await connect();
  console.log("PASS: a core dependency change rebuilds and restarts the development app");

  for (let index = 0; index < productionFiles.length; index++) assert.deepEqual(await readFile(productionFiles[index]), before[index]);
  await readFile("out-dev/main/index.js");
  await readFile("out-dev/preload/index.cjs");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/development-watch.png" });
  console.log("PASS: watch mode uses out-dev and leaves production output untouched");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (browser?.isConnected()) await browser.close();
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await unlink(probe).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
