import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperatorSession, validateOperatorSession, validateOperatorCsrf, SHARD_OPERATOR_COOKIE_ATTRIBUTES } from "./shardTransferOperatorSession.js";
const secret = "operator-session-signing-secret-not-the-trade-token-123";
test("session is signed, short-lived and CSRF bound", () => {
 const now = 1760000000000;
 const issued = createOperatorSession(secret,now);
 assert.deepEqual(validateOperatorSession(issued.token,secret,now+500),{csrf:issued.csrf});
 assert.equal(validateOperatorSession(issued.token,secret,now+900001),null);
 assert.equal(validateOperatorSession(issued.token,secret,now-1),null);
 assert.equal(validateOperatorSession(issued.token,secret+"x",now),null);
 assert.equal(validateOperatorSession(issued.token+"x",secret,now),null);
 assert.equal(validateOperatorCsrf(issued.csrf,issued.csrf),true);
 assert.equal(validateOperatorCsrf(issued.csrf,"wrong"),false);
});
test("weak key and cookie flags fail safely", () => {
 assert.throws(()=>createOperatorSession("short",100),/invalid/);
 assert.equal(validateOperatorSession("a.b","short",100),null);
 assert.match(SHARD_OPERATOR_COOKIE_ATTRIBUTES,/HttpOnly; Secure; SameSite=Strict; Path=\//);
});
