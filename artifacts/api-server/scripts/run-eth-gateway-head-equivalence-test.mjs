/**
 * Runs the immutable git HEAD ETH lifecycle bundle beside the working-tree
 * bundle.  This is intentionally not a mocked duplicate of the old path:
 * each bundle compiles and executes its own strategy and tests.  The selected
 * cases cover every gateway boundary whose behavior must survive extraction.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(root, "../..");
const headWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "eth-gateway-head-"));
const headApiRoot = path.join(headWorktree, "artifacts", "api-server");
const requiredCases = [
  /missing exchange index blocks/,
  /insufficient active ETH exchange balance/,
  /manual recovery residual exchange exposure/,
  /an unsettled order blocks/,
  /settlement sweep stays blocked after a transient failure/,
  /shared placement gateway preserves legacy zero, partial, and ambiguous/,
  /daily loss -250 boundary/,
];

function runBundle(cwd) {
  const result = spawnSync(process.execPath, ["scripts/run-eth-no-martingale-test.mjs"], {
    cwd, encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) throw new Error(`ETH bundle failed in ${cwd}\n${output}`);
  for (const expression of requiredCases) {
    if (!output.split("\n").some((line) => /^(?:ok \d+ -|✔) /.test(line) && expression.test(line))) {
      throw new Error(`ETH bundle in ${cwd} did not pass required case ${expression}: \n${output}`);
    }
  }
}

try {
  execFileSync("git", ["worktree", "add", "--detach", headWorktree, "HEAD"], {
    cwd: workspace, stdio: "ignore",
  });
  // The temporary worktree intentionally shares installed dependencies only;
  // it never writes workspace source, flags, database rows, or deployments.
  fs.symlinkSync(path.join(workspace, "node_modules"), path.join(headWorktree, "node_modules"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(headApiRoot, "node_modules"));
  runBundle(headApiRoot);
  runBundle(root);
  console.log("HEAD and working-tree ETH lifecycle bundles passed identical gateway boundary cases.");
} finally {
  execFileSync("git", ["worktree", "remove", "--force", headWorktree], {
    cwd: workspace, stdio: "ignore",
  });
}