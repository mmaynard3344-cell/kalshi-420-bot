import { validateOperatorCsrf, validateOperatorSession } from "./shardTransferOperatorSession.js";
import { validateShardTransferHttpBoundary } from "./shardTransferRequestBoundary.js";
import { previewManualShardTransfer } from "./shardTransferDryRun.js";

/** Independent server-side gate for a preview. Never creates a transfer. */
export function authorizedShardTransferPreview(input: {
  sessionCookie: string | undefined;
  sessionSigningKey: string | undefined;
  csrfHeader: string | undefined;
  contentType: string | undefined;
  origin: string | undefined;
  expectedOrigin: string | undefined;
  fetchSite: string | undefined;
  contentLength: string | undefined;
  requestBody: unknown;
  nowMs?: number;
}): ReturnType<typeof previewManualShardTransfer> | null {
  const session = validateOperatorSession(input.sessionCookie, input.sessionSigningKey, input.nowMs);
  if (!session || !validateOperatorCsrf(session.csrf, input.csrfHeader)) return null;
  if (!validateShardTransferHttpBoundary({
    contentType: input.contentType,
    origin: input.origin,
    expectedOrigin: input.expectedOrigin,
    fetchSite: input.fetchSite,
    contentLength: input.contentLength,
  })) return null;
  return previewManualShardTransfer(input.requestBody);
}
