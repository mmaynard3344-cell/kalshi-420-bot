import assert from "node:assert/strict";
import { test } from "node:test";
import { createShardOperatorLoginLimiter } from "./shardTransferOperatorLoginLimiter.js";
test("rejects login attempts after limit and resets only after interval",()=>{
 const limiter=createShardOperatorLoginLimiter({limit:2,windowMs:60000,maxKeys:2});
 assert.equal(limiter.allow("operator",1000),true);
 assert.equal(limiter.allow("operator",1001),true);
 assert.equal(limiter.allow("operator",1002),false);
 assert.equal(limiter.allow("operator",61000),true);
});
test("fails closed on unknown identity and excessive distinct identities",()=>{
 const limiter=createShardOperatorLoginLimiter({limit:1,windowMs:60000,maxKeys:1});
 assert.equal(limiter.allow("",0),false);
 assert.equal(limiter.allow("operator",0),true);
 assert.equal(limiter.allow("another",1),false);
 assert.equal(limiter.allow("another",60000),true);
});
