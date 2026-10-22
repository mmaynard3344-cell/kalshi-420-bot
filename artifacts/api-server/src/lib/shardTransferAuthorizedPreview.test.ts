import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizedShardTransferPreview } from "./shardTransferAuthorizedPreview.js";
import { createOperatorSession } from "./shardTransferOperatorSession.js";

const signingKey = "independent-operator-session-signing-key-123456";
const nowMs = 1760000000000;
const session = createOperatorSession(signingKey, nowMs);
const requestBody = {
  requestId: "69e61066-4170-4eb4-bfca-1b33800ca633",
  sourceExchangeShard: 0, destinationExchangeShard: 2,
  amountCents: 100, confirmation: "TRANSFER $1.00 FROM 0 TO 2",
};
const valid = {
 sessionCookie: session.token, sessionSigningKey: signingKey,
 csrfHeader: session.csrf, contentType: "application/json",
 origin: "https://shawshank.example.com", expectedOrigin: "https://shawshank.example.com",
 fetchSite: "same-origin", contentLength: "220", requestBody, nowMs,
};
test("valid authenticated request previews without submitting", () => {
 const response = authorizedShardTransferPreview(valid);
 assert.equal(response?.exchangeAmount, 10000);
 assert.equal(response?.wouldSubmit, false);
});
test("missing, forged or expired session and wrong CSRF fail closed", () => {
 assert.equal(authorizedShardTransferPreview({...valid, sessionCookie: undefined}), null);
 assert.equal(authorizedShardTransferPreview({...valid, sessionCookie: session.token+"x"}), null);
 assert.equal(authorizedShardTransferPreview({...valid, csrfHeader: "wrong"}), null);
 assert.equal(authorizedShardTransferPreview({...valid, nowMs: nowMs+901000}), null);
});
test("cross-origin and missing content length fail closed", () => {
 assert.equal(authorizedShardTransferPreview({...valid, origin: "https://evil.example.com"}), null);
 assert.equal(authorizedShardTransferPreview({...valid, fetchSite: "cross-site"}), null);
 assert.equal(authorizedShardTransferPreview({...valid, contentLength: undefined}), null);
});
