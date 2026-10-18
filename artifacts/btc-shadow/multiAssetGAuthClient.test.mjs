import test from "node:test";import assert from "node:assert/strict";
import {generateKeyPairSync,verify} from "node:crypto";
import {assetGHeaders,assetGOrderPayload,makeAssetGAuthClient} from "./multiAssetGAuthClient.mjs";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
test("Kalshi signature excludes querystring and uses authenticating key",()=>{
 const h=assetGHeaders("GET","/portfolio/orders?limit=1",{keyId:"demo",privateKey,now:123});
 assert.equal(h["KALSHI-ACCESS-KEY"],"demo");
 assert(verify("sha256",Buffer.from("123GET/trade-api/v2/portfolio/orders"),
 {key:publicKey,padding:6,saltLength:32},Buffer.from(h["KALSHI-ACCESS-SIGNATURE"],"base64")));
});
test("asset order payload uses correct bid ask side and complementary price",()=>{
 const body=assetGOrderPayload({asset:"DOGE",ticker:"KXDOGE15M-26OCT181700-00",
 side:"no",clientOrderId:"client-1",contracts:3,askCents:60});
 assert.equal(body.side,"ask");assert.equal(body.price,"0.4000");assert.equal(body.count,"3.00");
 assert.throws(()=>assetGOrderPayload({...{asset:"DOGE",ticker:"KXSOL15M-TEST",side:"yes",clientOrderId:"id",contracts:1,askCents:50}}),/invalid_asset/);
});
test("global and coin-specific switches block POST before any network requests",async()=>{
 let calls=0;const client=makeAssetGAuthClient({asset:"SOL",keyId:"id",privateKey,
  allowOrders:true,fetcher:async()=>{calls++;return {ok:true,json:async()=>({})}}});
 await assert.rejects(client("POST","/portfolio/events/orders",{ticker:"test"}),/execution_disabled/);
 assert.equal(calls,0);
});
