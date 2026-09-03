/**
 * Executes the focused ETH lifecycle suite in a detached frozen-baseline
 * worktree and in the current source tree. The baseline revision is fixed
 * intentionally: a refactor must not compare itself to a moving HEAD.
 *
 * Test labels are the stable observable contract. Volatile timestamps, log
 * formatting, and test duration are deliberately excluded from comparison.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FROZEN_BASELINE_REF = "cd4043a47f404792ed4d31383aa9ba9150a321bb";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(root, "../..");
const baselineWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "eth-lifecycle-baseline-"));
const baselineApiRoot = path.join(baselineWorktree, "artifacts", "api-server");

function executeBundle(cwd) {
  const result = spawnSync(process.execPath, ["scripts/run-eth-no-martingale-test.mjs"], {
    cwd, encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) throw new Error(`ETH lifecycle bundle failed in ${cwd}\n${output}`);
  return output
    .split("\n")
    .map((line) => line.match(/^(?:ok \d+ -|✔) (.+?)(?: \([\d.]+ms\))?$/)?.[1] ?? null)
    .filter((label) => label != null);
}

try {
  execFileSync("git", ["worktree", "add", "--detach", baselineWorktree, FROZEN_BASELINE_REF], {
    cwd: workspace, stdio: "ignore",
  });
  fs.symlinkSync(path.join(workspace, "node_modules"), path.join(baselineWorktree, "node_modules"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(baselineApiRoot, "node_modules"));

  const baselineLabels = executeBundle(baselineApiRoot);
  const currentLabels = executeBundle(root);
  const missingOrChanged = baselineLabels.filter((label) => !currentLabels.includes(label));
  if (missingOrChanged.length > 0) {
    throw new Error(`Current ETH lifecycle bundle no longer passes frozen baseline cases:\n${missingOrChanged.join("\n")}`);
  }
  console.log(`ETH lifecycle equivalence passed: ${baselineLabels.length} frozen baseline cases also pass in current source.`);
} finally {
  execFileSync("git", ["worktree", "remove", "--force", baselineWorktree], {
    cwd: workspace, stdio: "ignore",
  });
}