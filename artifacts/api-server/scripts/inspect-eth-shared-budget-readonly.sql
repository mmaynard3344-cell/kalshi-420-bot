-- Read-only diagnosis of the live ETH shared martingale budget mismatch.
-- Never modify the state or constraint merely to make the next trade pass.
SELECT conname, pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint WHERE conrelid='public.eth_shared_martingale_claims'::regclass
AND conname='eth_shared_martingale_claims_budget_cents_check';
SELECT step, version, active_claim_id, updated_at
FROM public.eth_shared_martingale_state WHERE singleton=TRUE;
SELECT claim_id, service, ticker, step, budget_cents, status, outcome, resolved_at
FROM public.eth_shared_martingale_claims
ORDER BY created_at DESC LIMIT 12;
