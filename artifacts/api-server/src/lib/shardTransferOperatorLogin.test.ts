import assert from "node:assert/strict";
import { test } from "node:test";
import { issueShardOperatorSession } from "./shardTransferOperatorLogin.js";
import { validateOperatorSession } from "./shardTransferOperatorSession.js";
const operator="operator-secret-at-least-thirty-two-characters";
const session="independent-session-signing-secret-123456789";
test("independent operator proof creates a short-lived verified session",()=>{
 const result=issueShardOperatorSession({presentedOperatorCredential:operator,configuredOperatorCredential:operator,sessionSigningKey:session,tradeTokens:["trade-only"],nowMs:1760000000000});
 assert.ok(result);
 assert.equal(validateOperatorSession(result.token,session,1760000000001)?.csrf,result.csrf);
});
test("weak, missing and shared credentials fail closed",()=>{
 const base={presentedOperatorCredential:operator,configuredOperatorCredential:operator,sessionSigningKey:session,tradeTokens:["trade-only"]};
 assert.equal(issueShardOperatorSession({...base,presentedOperatorCredential:"wrong"}),null);
 assert.equal(issueShardOperatorSession({...base,sessionSigningKey:operator}),null);
 assert.equal(issueShardOperatorSession({...base,sessionSigningKey:"short"}),null);
 assert.equal(issueShardOperatorSession({...base,tradeTokens:[operator]}),null);
 assert.equal(issueShardOperatorSession({...base,tradeTokens:[session]}),null);
});
