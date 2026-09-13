import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Service G is intentionally isolated from the shared downfade/API runtime.
// All other roles retain the existing production entrypoint unchanged.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypoint = process.env.ETH_SERVICE_ROLE === "downfade_g"
  ? "artifacts/api-server/dist/g4060ScalpIndex.mjs"
  : "artifacts/api-server/dist/index.mjs";

const api = spawn(
  process.execPath,
  ["--enable-source-maps", entrypoint],
  { cwd: root, stdio: "inherit", env: process.env },
);
const stop = () => api.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
api.on("exit", (code) => process.exit(code ?? 1));