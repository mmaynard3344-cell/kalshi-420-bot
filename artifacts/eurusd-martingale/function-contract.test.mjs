import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('./railway-review-function.ts',import.meta.url),'utf8');
test('review Railway source includes persistent ledger and settlement gate',()=>{
  assert.match(src,/initializeUsdLadder\(db,/);
  assert.match(src,/await prepareUsdEntry\(db,/);
  assert.match(src,/if \(!usdEntry\.allowed\)/);
  assert.match(src,/if \(hasUnresolvedUsdOrders\(db\)\) return false/);
  assert.match(src,/ORDER_CAP_CENTS\s*=\s*usdEntry\.allowed/);
});
test('review source preserves USD shard 0 and authenticated order retrieval',()=>{
  assert.match(src,/const EXCHANGE_INDEX = 0/);
  assert.match(src,/auth\("GET","\/portfolio\/orders\/"/);
});
test('do not claim complete release without recovery for ambiguous POST',()=>{
  // An ambiguous POST is currently fail-closed; exchange client-ID recovery
  // is still a separate integration requirement.
  assert.match(src,/ERROR_REQUIRES_RECONCILIATION/);
});
