import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLDryRunOrderSize,
  parseKrakenEth15mRows,
} from "./sweepReclaimDryRunRuntime.js";
import { ETH_15M_MS } from "./sweepReclaimV1.js";

test("L dry-run sizing preserves configured stake cap plus conservative fee headroom",()=>{
  assert.deepEqual(buildLDryRunOrderSize(5000,99),{
    contracts:50,
    maxPrincipalCents:4950,
    feeHeadroomCents:4,
    requestedRiskCents:4954,
  });
});

test("Kraken ETH parser returns exact contiguous finalized candles",()=>{
  const start=0;
  const payload={result:{XETHZUSD:[
    [0,100,110,90,105,0,0,0],
    [900,105,111,95,108,0,0,0],
  ],last:1800}};
  const rows=parseKrakenEth15mRows(payload,start,2,2*ETH_15M_MS+1);
  assert.equal(rows.length,2);
  assert.equal(rows[0]?.open,100);
  assert.equal(rows[1]?.close,108);
  assert.equal(rows[1]?.finalized,true);
});

test("Kraken parser fails closed on a missing interval",()=>{
  const payload={result:{XETHZUSD:[[0,100,110,90,105,0,0,0]],last:1800}};
  assert.deepEqual(parseKrakenEth15mRows(payload,0,2,2*ETH_15M_MS+1),[]);
});
