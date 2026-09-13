import { build } from "esbuild";
import { writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const apiDir = path.resolve("artifacts/api-server");
const entry = "/tmp/eth-reservation-probe-cleanup-entry.ts";
const outfile = "/tmp/eth-reservation-probe-cleanup-entry.cjs";
const orderId = "KXETH15M-26SEP131745-45:diagnostic-reservation-probe-v1";

const source = `
import { markEthBigBetRejected } from ${JSON.stringify(path.join(apiDir, "src/lib/strategies/ethBigBetStore.ts"))};
async function main() {
  try {
    const cleaned = await markEthBigBetRejected(${JSON.stringify(orderId)});
    console.log("ETH_RESERVATION_PROBE_CLEANUP", { orderId: ${JSON.stringify(orderId)}, cleaned });
  } catch (err) {
    console.error("ETH_RESERVATION_PROBE_CLEANUP_THROWN", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
    });
    process.exitCode = 2;
  }
}
void main();
`;

await writeFile(entry, source, "utf8");
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    sourcemap: false,
    logLevel: "silent",
    external: ["pg-native"],
  });
  const run = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  await rm(entry, { force: true });
  await rm(outfile, { force: true });
}
