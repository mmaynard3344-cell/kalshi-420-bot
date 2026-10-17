/**
 * Independent, fail-closed checks for a money-moving HTTP request.
 * No secrets, database connection or network activity in this module.
 */
export function validateShardTransferHttpBoundary(input: {
  contentType: string | undefined;
  origin: string | undefined;
  expectedOrigin: string | undefined;
  fetchSite: string | undefined;
  contentLength: string | undefined;
}): boolean {
  if (!input.expectedOrigin) return false;
  let expected: URL;
  try {
    expected = new URL(input.expectedOrigin);
    if (expected.protocol !== "https:" || expected.pathname !== "/" || expected.search || expected.hash) return false;
  } catch { return false; }
  if (input.origin !== expected.origin) return false;
  if (input.fetchSite !== "same-origin") return false;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(input.contentType ?? "")) return false;
  if (!/^(?:[1-9][0-9]{0,3})$/.test(input.contentLength ?? "")) return false;
  return Number(input.contentLength) <= 4096;
}
