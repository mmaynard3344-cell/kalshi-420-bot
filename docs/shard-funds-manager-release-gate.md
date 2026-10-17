# Shawshank Funds Manager — production release gate

Status: **NOT APPROVED FOR LIVE TRANSFERS**. Keep dashboard submission button disabled and POST `/trade/shard-transfer` returning 503 until every item is verified.

## Read-only rollout
- [ ] Confirm final deployment target and branch with operator.
- [ ] Verify shard 0, 1, 2 balances and stale indicators against Kalshi independently.
- [ ] Confirm transfer history contains no private operator credentials.
- [ ] Validate responsive dashboard UI and caching behavior.
- [ ] Run standard dashboard build and deployment checks.

## Mandatory transfer security gate
- [ ] Replace public dashboard access with independent operator authentication using secure server-side session (HttpOnly, Secure, SameSite), expiration, reauthentication and CSRF protection.
- [ ] Restrict transfer route by authorized operator identity and authorization checks on every request. Public read-only proxy must remain GET/HEAD only.
- [ ] Ensure browser bundles, response payloads, logs and proxy never expose the operator secret or Kalshi API signing credential.
- [ ] Verify actual Kalshi transfer endpoint, request fields, amount units, `client_transfer_id`, response schema, and supported terminal statuses against official reference.
- [ ] Reconcile one transfer by exchange transfer ID using authenticated read; **never assume accepted = settled**.
- [ ] Apply and audit durable ledger migration explicitly; prove one-submit-only behavior across server restarts and concurrent requests.
- [ ] Verify fail-closed source available-balance checks, shard mapping 0 ↔ 2, max amount, exact confirmation, rate limit and audit events.
- [ ] Run isolated CI, DB tests, full build, security integration tests and final human-reviewed PR approval.
- [ ] Enable transfer feature only with a separate, explicit production approval; never turn it on as part of a routine read-only deploy.

No deployment, secrets changes, migration, or live transfer is authorized by this checklist.
