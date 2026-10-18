import assert from "node:assert/strict";
import { test } from "node:test";
import { issueShardOperatorSession } from "./shardTransferOperatorLogin.js";
import { authorizedShardTransferPreview } from "./shardTransferAuthorizedPreview.js";
import { validateOperatorSession } from "./shardTransferOperatorSession.js";
const credential="shard-operator-credential-strong-enough-123";
const signingKey="separate-signing-key-strong-enough-456";
const nowMs=1760000000000;
const body={requestId:"69e61066-4170-4eb4-bfca-1b33800ca633",sourceExchangeShard:0,destinationExchangeShard:2,amountCents:100,confirmation:"TRANSFER $1.00 FROM 0 TO 2"};
test("login issues a cookie-backed session; protected preview remains inert",()=>{
 const login=issueShardOperatorSession({presentedOperatorCredential:credential,configuredOperatorCredential:credential,sessionSigningKey:signingKey,tradeTokens:["trade-token-only"],nowMs});
 assert.ok(login);
 const args={sessionCookie:login.token,sessionSigningKey:signingKey,csrfHeader:login.csrf,contentType:"application/json",origin:"https://shawshank.example.com",expectedOrigin:"https://shawshank.example.com",fetchSite:"same-origin",contentLength:"220",requestBody:body,nowMs:nowMs+1000};
 const preview=authorizedShardTransferPreview(args);
 assert.equal(preview?.sourceShard,0);
 assert.equal(preview?.destinationShard,2);
 assert.equal(preview?.wouldSubmit,false);
 assert.equal(authorizedShardTransferPreview({...args,csrfHeader:"wrong"}),null);
 assert.equal(authorizedShardTransferPreview({...args,nowMs:nowMs+901000}),null);
 assert.equal(validateOperatorSession(login.token,signingKey,nowMs+901000),null);
});
test("wrong operator credential cannot create session",()=>{
 assert.equal(issueShardOperatorSession({presentedOperatorCredential:"incorrect",configuredOperatorCredential:credential,sessionSigningKey:signingKey,tradeTokens:[],nowMs}),null);
});
