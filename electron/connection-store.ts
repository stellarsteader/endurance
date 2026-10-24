/** The connection list on disk in the app profile, with DNS for locating servers by name. */
import { app } from "electron";
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConnectionBook } from "../src/lib/connection-book";
import { vault } from "./connection-secrets";

const file = () => path.join(app.getPath("userData"), "connections.json");

export const book = new ConnectionBook(
  {
    read: () => (existsSync(file()) ? readFileSync(file(), "utf8") : undefined),
    write: (text) => {
      writeFileSync(file(), text, { mode: 0o600 });
      try {
        chmodSync(file(), 0o600);
      } catch {
        /* The profile folder is already private to the user. */
      }
    },
  },
  vault,
  async (host) => {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500));
    const found = await Promise.race([lookup(host, { all: true }), timeout]);
    return found.map((item) => item.address);
  },
);
