-- Read-only ETH G v1 cutover inventory; run against production with SELECT privileges only.
-- Never copy a step without reconciling the order ledger and authoritative exchange.
SELECT id,ladder_side,step,last_trigger_key,updated_at_ms
FROM eth_g_streak_reversal_state WHERE id=1;
SELECT ticker,side,step,client_order_id,kalshi_order_id,status,filled_contracts,settled_at_ms
FROM eth_g_streak_reversal_orders
ORDER BY created_at_ms DESC LIMIT 30;
SELECT version FROM eth_shared_martingale_state WHERE singleton=TRUE;
