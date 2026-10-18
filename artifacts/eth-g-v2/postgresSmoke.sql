\set ON_ERROR_STOP on
BEGIN;
INSERT INTO eth_g_v2_orders(client_order_id,ticker,side,verified_filled_contracts)
VALUES ('test-cid-1','KXETH15M-26OCT181530-30','yes',2);
UPDATE eth_g_v2_state SET step=2,pending_client_order_id='test-cid-1',last_trigger_key='t1',version=version+1 WHERE id=1;
DO $$
BEGIN
 IF (SELECT step FROM eth_g_v2_state WHERE id=1) <> 2 THEN RAISE EXCEPTION 'step mismatch'; END IF;
 IF (SELECT pending_client_order_id FROM eth_g_v2_state WHERE id=1) <> 'test-cid-1' THEN RAISE EXCEPTION 'pending mismatch'; END IF;
END $$;
SAVEPOINT invalid_step;
\set ON_ERROR_STOP off
UPDATE eth_g_v2_state SET step=6 WHERE id=1;
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT invalid_step;
UPDATE eth_g_v2_orders SET exchange_order_id='ex-1' WHERE client_order_id='test-cid-1';
INSERT INTO eth_g_v2_settlements(settlement_id,client_order_id,outcome,previous_step,next_step)
VALUES ('ex-1','test-cid-1','loss',2,3);
UPDATE eth_g_v2_state SET step=3,pending_client_order_id=NULL,last_settlement_id='ex-1',version=version+1 WHERE id=1;
DO $$
BEGIN
 IF (SELECT step FROM eth_g_v2_state WHERE id=1) <> 3 THEN RAISE EXCEPTION 'verified loss ladder mismatch'; END IF;
 IF (SELECT count(*) FROM eth_g_v2_settlements) <> 1 THEN RAISE EXCEPTION 'settlement record missing'; END IF;
END $$;
ROLLBACK;
