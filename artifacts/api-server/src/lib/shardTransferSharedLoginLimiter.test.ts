import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { SHARD_OPERATOR_LOGIN_LIMIT_SQL } from "./shardTransferSharedLoginLimiter.js";

test("shared throttle uses atomic upsert rather than local Map", () => {
 assert.match(SHARD_OPERATOR_LOGIN_LIMIT_SQL, /ON CONFLICT \(identity_hash\) DO UPDATE/);
 assert.match(SHARD_OPERATOR_LOGIN_LIMIT_SQL, /RETURNING attempts, window_start_ms/);
 assert.match(SHARD_OPERATOR_LOGIN_LIMIT_SQL, /attempts \+ 1/);
});
test("login route is disabled by default and uses database limiter", () => {
 const route=readFileSync(resolve(process.cwd(),"src/routes/trade.ts"),"utf8");
 const start=route.indexOf('router.post("/trade/shard-transfer/operator-login"');
 const end=route.indexOf('router.post("/trade/shard-transfer/session-preview"',start);
 assert.ok(start>=0&&end>start);
 const body=route.slice(start,end);
 assert.match(body,/SHARD_OPERATOR_LOGIN_ENABLED/);
 assert.match(body,/await allowSharedShardOperatorLogin/);
 assert.doesNotMatch(body,/shardOperatorLoginLimiter\.allow/);
});
