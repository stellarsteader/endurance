import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const alias = { "@": resolve("src") };
// The terminal's native PTY (terminal-host) is loaded from node_modules at run time; electron-builder.yml ships and unpacks it.
export default defineConfig(({ command }) => ({
  main: {
    resolve: { alias },
    build: { outDir: command === "serve" ? "out-dev/main" : "out/main", externalizeDeps: false, rollupOptions: { input: { index: resolve("electron/main.ts"), worker: resolve("electron/worker.ts"), "history-thread": resolve("electron/history-thread.ts"), "terminal-host": resolve("electron/terminal-host.ts") }, external: ["@lydell/node-pty"] } },
  },
  preload: { build: { outDir: command === "serve" ? "out-dev/preload" : "out/preload", rollupOptions: { input: resolve("electron/preload.ts"), output: { format: "cjs", entryFileNames: "index.cjs" } } } },
  renderer: {
    root: ".", resolve: { alias }, plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve("index.html") } },
  },
}));
