import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The published runner owns only the live ETH martingale API. Research workers
// are intentionally excluded so they cannot add load or revive retired paths.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const api = spawn(
  process.execPath,
  ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"],
  { cwd: root, stdio: "inherit", env: process.env },
);
const stop = () => api.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
api.on("exit", (code) => process.exit(code ?? 1));