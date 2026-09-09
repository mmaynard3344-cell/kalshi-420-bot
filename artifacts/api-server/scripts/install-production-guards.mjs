import { spawnSync } from "node:child_process";

for (const script of [
  "artifacts/api-server/scripts/install-regular-sequence-guard.mjs",
  "artifacts/api-server/scripts/install-account-daily-loss-guard.mjs",
  "artifacts/api-server/scripts/repair-false-daily-loss-latch-20260909.mjs",
]) {
  const result = spawnSync(process.execPath, [script], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
