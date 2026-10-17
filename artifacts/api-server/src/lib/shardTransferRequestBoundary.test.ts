import assert from "node:assert/strict";
import { test } from "node:test";
import { validateShardTransferHttpBoundary as valid } from "./shardTransferRequestBoundary.js";
const good = {contentType:"application/json", origin:"https://shawshank.example",expectedOrigin:"https://shawshank.example",fetchSite:"same-origin",contentLength:"180"};
test("requires same-origin small JSON body and configured HTTPS origin", () => {
  assert.equal(valid(good), true);
  for (const patch of [
    {expectedOrigin:undefined},{expectedOrigin:"http://shawshank.example"},
    {origin:"https://evil.example"},{origin:undefined},
    {fetchSite:"cross-site"},{fetchSite:undefined},
    {contentType:"text/plain"},{contentLength:"5000"},{contentLength:undefined},
  ]) assert.equal(valid({...good,...patch}), false, JSON.stringify(patch));
});