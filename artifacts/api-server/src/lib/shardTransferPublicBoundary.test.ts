import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

/** Deployment security invariant until an independently reviewed operator UI exists. */
test("dashboard proxy remains GET/HEAD only and transfer POST stays disabled", () => {
  const repoRoot = resolve(process.cwd(), "../..");
  const proxy = readFileSync(resolve(repoRoot, "artifacts/kalshi-reader/server.mjs"), "utf8");
  const route = readFileSync(resolve(repoRoot, "artifacts/api-server/src/routes/trade.ts"), "utf8");
  assert.match(proxy, /req\.method !== 'GET' && req\.method !== 'HEAD'/);
  assert.doesNotMatch(proxy, /ALLOWED_(?:POST|WRITE)_PATHS/);
  const guardedPost = route.match(/router\.post\("\/trade\/shard-transfer"[\s\S]*?\n\}\);/);
  assert.ok(guardedPost, "Transfer endpoint must exist");
  assert.match(guardedPost[0], /verifyShardTransferOperatorToken/);
  assert.match(guardedPost[0], /status\(503\)/);
  assert.match(guardedPost[0], /transfer_submitted:\s*false/);
  assert.doesNotMatch(guardedPost[0], /kalshiAuthFetch|submitManualShardTransfer/);
});

test("operator endpoints cannot be reached through dashboard's public read proxy", () => {
  const repoRoot = resolve(process.cwd(), "../..");
  const proxy = readFileSync(resolve(repoRoot, "artifacts/kalshi-reader/server.mjs"), "utf8");
  const routes = readFileSync(resolve(repoRoot, "artifacts/api-server/src/routes/trade.ts"), "utf8");
  const allowlist = proxy.match(/ALLOWED_READ_PATHS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(allowlist, "Explicit public read allowlist is required");
  assert.doesNotMatch(allowlist[1], /\/api\/trade\/shard-transfer\/|\/api\/trade\/shard-transfer['"]/);
  assert.match(routes, /router\.post\("\/trade\/shard-transfer\/preview", requireTradeAuth/);
  assert.match(routes, /router\.get\("\/trade\/shard-transfer\/:requestId", requireTradeAuth/);
  assert.match(routes, /router\.get\("\/trade\/shard-transfer\/:requestId"[\s\S]*?verifyShardTransferOperatorToken/);
});

test("public browser bundle never carries the operator token or calls transfer submission", () => {
  const repoRoot = resolve(process.cwd(), "../..");
  const dashboard = readFileSync(resolve(repoRoot, "artifacts/kalshi-reader/src/pages/LiveMartingale.tsx"), "utf8");
  const proxy = readFileSync(resolve(repoRoot, "artifacts/kalshi-reader/server.mjs"), "utf8");
  assert.doesNotMatch(dashboard, /SHARD_TRANSFER_OPERATOR_TOKEN|x-shard-transfer-operator-token/);
  assert.doesNotMatch(dashboard, /fetch\s*\(\s*['"`]\/api\/trade\/shard-transfer/);
  assert.doesNotMatch(proxy, /SHARD_TRANSFER_OPERATOR_TOKEN|x-shard-transfer-operator-token/);
  assert.match(dashboard, /disabled=\{true\}|disabled(?:\s|>)/);
});

test("read-only shard balances are scoped to 0/1/2 and cannot authorize transfers", () => {
  const repoRoot = resolve(process.cwd(), "../..");
  const route = readFileSync(resolve(repoRoot, "artifacts/api-server/src/routes/trade.ts"), "utf8");
  const dashboard = readFileSync(resolve(repoRoot, "artifacts/kalshi-reader/src/pages/LiveMartingale.tsx"), "utf8");
  assert.match(route, /const shardIndexes = \[0, 1, 2\] as const/);
  assert.match(route, /fetchKalshiBalanceForExchangeRead\(exchangeIndex\)/);
  assert.match(route, /stale: true/);
  assert.match(dashboard, /Manual shard transfer · preview only/);
  assert.match(dashboard, /<button type="button" disabled className=/);
});

test("operator login and session preview stay private and login defaults off", () => {
  const repoRoot = resolve(process.cwd(), "../..");
  const routes = readFileSync(resolve(repoRoot, "artifacts/api-server/src/routes/trade.ts"), "utf8");
  const proxy = readFileSync(resolve(repoRoot, "artifacts/kalshi-reader/server.mjs"), "utf8");
  const login = routes.match(/router\.post\("\/trade\/shard-transfer\/operator-login"[\s\S]*?\n\}\);/);
  const preview = routes.match(/router\.post\("\/trade\/shard-transfer\/session-preview"[\s\S]*?\n\}\);/);
  assert.ok(login && preview);
  assert.match(login[0], /requireTradeAuth/);
  assert.match(login[0], /SHARD_OPERATOR_LOGIN_ENABLED/);
  assert.match(login[0], /allowSharedShardOperatorLogin/);
  assert.match(login[0], /issueShardOperatorSession/);
  assert.match(preview[0], /requireTradeAuth/);
  assert.match(preview[0], /authorizedShardTransferPreview/);
  assert.doesNotMatch(proxy, /ALLOWED_(?:POST|WRITE)_PATHS/);
  assert.doesNotMatch(proxy.match(/ALLOWED_READ_PATHS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "", /shard-transfer/);
});
