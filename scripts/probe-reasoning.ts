/**
 * Checks how a running local model handles reasoning together with structured output, the way the agent
 * chooses its steps. Real inference on the given runtime; nothing is saved and no app profile is touched.
 *
 *   npm run probe:reasoning -- --model qwen3:4b
 *   npm run probe:reasoning -- --runtime lmstudio --base http://127.0.0.1:1234/v1 --model qwen/qwen3-4b --effort low
 *
 * --thinking false probes a model whose thinking is turned off in Models settings.
 */
import { parseArgs } from "node:util";
import { probeReasoning } from "../src/harness/reasoning";
import { RUNTIMES, isRuntimeId } from "../src/lib/models";
import type { ChatRequest } from "../src/harness/chat";

const { values } = parseArgs({
  options: {
    runtime: { type: "string", default: "ollama" },
    base: { type: "string" },
    model: { type: "string" },
    effort: { type: "string", default: "high" },
    thinking: { type: "string", default: "true" },
    "api-key": { type: "string", default: "" },
  },
});
if (!values.model || !isRuntimeId(values.runtime)) {
  console.error("Usage: npm run probe:reasoning -- --model <runtime model id> [--runtime ollama] [--base http://127.0.0.1:11434/v1] [--effort high]");
  process.exit(2);
}
const runtime = values.runtime;
const body = {
  messages: [],
  runtime,
  runtimeModelId: values.model,
  connection: { baseUrl: values.base ?? RUNTIMES.find((item) => item.id === runtime)!.baseUrl, apiKey: values["api-key"] },
  // Send the effort as the app does for a model that reports thinking.
  reasoningSupported: true,
  thinking: values.thinking !== "false",
  effort: values.effort,
} as unknown as ChatRequest;

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
console.log(`Probing ${values.model} on ${runtime} at ${body.connection.baseUrl} (effort ${values.effort})…`);
const result = await probeReasoning(body, controller.signal);
for (const item of result.tried)
  console.log(
    `${item.mode.padEnd(9)} ${item.valid ? "valid JSON" : "no valid JSON"}, ${item.reasoning} reasoning chars, ${(item.ms / 1000).toFixed(1)}s${item.error ? ` — ${item.error}` : ""}`
  );
console.log(
  result.mode
    ? `The agent will use "${result.mode}"${result.mode === "off" ? ": steps are chosen without visible reasoning." : " and show the reasoning while it chooses steps."}`
    : "No way returned valid JSON. Check the model id and that the runtime supports structured output."
);
