import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyShardTransferOperatorToken as verify } from "./shardTransferOperatorAuth.js";
const operator = "0123456789abcdef0123456789abcdef";
const trade = "abcdef0123456789abcdef0123456789";
test("operator token is separate from dashboard trade token", () => {
  assert.equal(verify(operator, operator, [trade]), true);
  assert.equal(verify(trade, operator, [trade]), false);
  assert.equal(verify(operator, operator, [operator]), false);
});
test("fail closed on missing or weak credentials", () => {
  assert.equal(verify(operator, undefined, [trade]), false);
  assert.equal(verify(undefined, operator, [trade]), false);
  assert.equal(verify("short", "short", [trade]), false);
});