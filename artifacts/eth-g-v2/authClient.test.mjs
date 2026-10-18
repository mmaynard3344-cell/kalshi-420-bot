import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,verify} from "node:crypto";
import {authHeaders,orderPayload,makeAuthClient} from "./authClient.mjs";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
test("signs only URI path, not query parameters",()=>{
 const h=authHeaders("GET","/portfolio/orders?limit=1",{keyId:"test-id",privateKey,now:12345});
 assert.equal(h["KALSHI-ACCESS-KEY"],"test-id");
 assert(verify("sha256",Buffer.from("12345GET/trade-api/v2/portfolio/orders"),{key:publicKey,padding:6,saltLength:32},Buffer.from(h["KALSHI-ACCESS-SIGNATURE"],"base64")));
});
test("NO order uses Kalshi ask at complementary price",()=>{
 const p=orderPayload({ticker:"KXETH15M-26OCT181530-30",side:"no",clientOrderId:"12345678-1234-4123-8123-123456789abc",contracts:4,askCents:50});
 assert.equal(p.side,"ask");assert.equal(p.price,"0.5000");assert.equal(p.count,"4.00");
});
test("live POST remains disabled even with injected transport",async()=>{
 let requested=false;
 const auth=makeAuthClient({keyId:"id",privateKey,fetcher:async()=>{requested=true;return {ok:true,json:async()=>({})}}});
 await assert.rejects(auth("POST","/portfolio/events/orders",{}),/live_orders_disabled/);
 assert.equal(requested,false);
});
