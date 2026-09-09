import pg from "../../../lib/db/node_modules/pg/lib/index.js";
const { Client } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for account daily loss guard installation");
const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS eth_account_daily_loss_locks (
      eastern_date text PRIMARY KEY, threshold_cents bigint NOT NULL,
      triggered_realized_pnl_cents bigint NOT NULL, triggered_at_ms bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS eth_account_daily_loss_blocks (
      id bigserial PRIMARY KEY, eastern_date text NOT NULL, source_table text NOT NULL,
      realized_pnl_cents bigint NOT NULL, open_risk_cents bigint NOT NULL,
      proposed_risk_cents bigint NOT NULL, projected_worst_case_cents bigint NOT NULL,
      reason text NOT NULL, blocked_at_ms bigint NOT NULL);
    CREATE OR REPLACE FUNCTION eth_account_realized_pnl_cents(p_eastern_date text) RETURNS bigint LANGUAGE plpgsql AS $$
    DECLARE regular_pnl bigint := 0; big_bet_pnl bigint := 0;
    BEGIN
      SELECT COALESCE(SUM(CASE WHEN settlement_result = side THEN
        ROUND(COALESCE(filled_contracts,0)*100-COALESCE(actual_notional_dollars,0)*100-COALESCE(actual_fee_dollars,0)*100)::bigint
        ELSE ROUND(-COALESCE(actual_notional_dollars,0)*100-COALESCE(actual_fee_dollars,0)*100)::bigint END),0)::bigint
      INTO regular_pnl FROM eth_martingale_orders
      WHERE ticker LIKE 'KXETH15M-%' AND eastern_date=p_eastern_date
        AND settlement_result IN ('yes','no') AND COALESCE(filled_contracts,0)>0 AND actual_notional_dollars IS NOT NULL;
      IF to_regclass('public.eth_big_bet_orders') IS NOT NULL THEN
        EXECUTE $q$SELECT COALESCE(SUM(realized_pnl_cents),0)::bigint FROM eth_big_bet_orders
          WHERE status='settled' AND realized_pnl_cents IS NOT NULL
          AND to_char(to_timestamp(market_open_time_ms/1000.0) AT TIME ZONE 'America/New_York','YYYY-MM-DD')=$1$q$
        INTO big_bet_pnl USING p_eastern_date;
      END IF;
      RETURN COALESCE(regular_pnl,0)+COALESCE(big_bet_pnl,0);
    END; $$;
    CREATE OR REPLACE FUNCTION eth_account_open_risk_cents(p_eastern_date text) RETURNS bigint LANGUAGE plpgsql AS $$
    DECLARE regular_risk bigint := 0; big_bet_risk bigint := 0;
    BEGIN
      SELECT COALESCE(SUM(ROUND(COALESCE(requested_contracts,0)*no_price_cents)::bigint+COALESCE(reserved_fee_cents,0)::bigint),0)::bigint
      INTO regular_risk FROM eth_martingale_orders
      WHERE ticker LIKE 'KXETH15M-%' AND eastern_date=p_eastern_date AND settlement_result IS NULL
        AND outcome IN ('pending','post_started','resting','full_fill','partial_fill','unresolved');
      IF to_regclass('public.eth_big_bet_orders') IS NOT NULL THEN
        EXECUTE $q$SELECT COALESCE(SUM(wager_cents::bigint+CEIL(0.07*requested_contracts*limit_price_cents*(100-limit_price_cents)/100.0)::bigint),0)::bigint
          FROM eth_big_bet_orders WHERE status NOT IN ('rejected','settled')
          AND to_char(to_timestamp(market_open_time_ms/1000.0) AT TIME ZONE 'America/New_York','YYYY-MM-DD')=$1$q$
        INTO big_bet_risk USING p_eastern_date;
      END IF;
      RETURN COALESCE(regular_risk,0)+COALESCE(big_bet_risk,0);
    END; $$;
    CREATE OR REPLACE FUNCTION enforce_eth_account_daily_loss_on_entry() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE d text; realized bigint; open_risk bigint; proposed_risk bigint; projected bigint;
      threshold bigint := -120000; now_ms bigint := (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint;
    BEGIN
      IF TG_TABLE_NAME='eth_martingale_orders' THEN d:=NEW.eastern_date;
        proposed_risk:=ROUND(COALESCE(NEW.requested_contracts,0)*NEW.no_price_cents)::bigint+COALESCE(NEW.reserved_fee_cents,0)::bigint;
      ELSIF TG_TABLE_NAME='eth_big_bet_orders' THEN
        d:=to_char(to_timestamp(NEW.market_open_time_ms/1000.0) AT TIME ZONE 'America/New_York','YYYY-MM-DD');
        proposed_risk:=NEW.wager_cents::bigint+CEIL(0.07*NEW.requested_contracts*NEW.limit_price_cents*(100-NEW.limit_price_cents)/100.0)::bigint;
      ELSE RETURN NULL; END IF;
      PERFORM pg_advisory_xact_lock(hashtext('eth-account-daily-loss:'||d));
      realized:=eth_account_realized_pnl_cents(d); open_risk:=eth_account_open_risk_cents(d); projected:=realized-open_risk-proposed_risk;
      IF EXISTS(SELECT 1 FROM eth_account_daily_loss_locks WHERE eastern_date=d) THEN
        INSERT INTO eth_account_daily_loss_blocks(eastern_date,source_table,realized_pnl_cents,open_risk_cents,proposed_risk_cents,projected_worst_case_cents,reason,blocked_at_ms)
        VALUES(d,TG_TABLE_NAME,realized,open_risk,proposed_risk,projected,'daily_loss_latched',now_ms); RETURN NULL; END IF;
      IF realized<=threshold THEN
        INSERT INTO eth_account_daily_loss_locks(eastern_date,threshold_cents,triggered_realized_pnl_cents,triggered_at_ms)
        VALUES(d,threshold,realized,now_ms) ON CONFLICT(eastern_date) DO NOTHING;
        INSERT INTO eth_account_daily_loss_blocks(eastern_date,source_table,realized_pnl_cents,open_risk_cents,proposed_risk_cents,projected_worst_case_cents,reason,blocked_at_ms)
        VALUES(d,TG_TABLE_NAME,realized,open_risk,proposed_risk,projected,'realized_loss_limit',now_ms); RETURN NULL; END IF;
      IF projected<threshold THEN
        INSERT INTO eth_account_daily_loss_blocks(eastern_date,source_table,realized_pnl_cents,open_risk_cents,proposed_risk_cents,projected_worst_case_cents,reason,blocked_at_ms)
        VALUES(d,TG_TABLE_NAME,realized,open_risk,proposed_risk,projected,'projected_loss_limit',now_ms); RETURN NULL; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS eth_account_daily_loss_regular_guard ON eth_martingale_orders;
    CREATE TRIGGER eth_account_daily_loss_regular_guard BEFORE INSERT ON eth_martingale_orders
      FOR EACH ROW EXECUTE FUNCTION enforce_eth_account_daily_loss_on_entry();
  `);
  const bigBetExists=await client.query(`SELECT to_regclass('public.eth_big_bet_orders') AS regclass`);
  if(bigBetExists.rows[0]?.regclass) await client.query(`DROP TRIGGER IF EXISTS eth_account_daily_loss_big_bet_guard ON eth_big_bet_orders; CREATE TRIGGER eth_account_daily_loss_big_bet_guard BEFORE INSERT ON eth_big_bet_orders FOR EACH ROW EXECUTE FUNCTION enforce_eth_account_daily_loss_on_entry();`);
  const day=(await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS d`)).rows[0].d;
  const status=await client.query(`SELECT eth_account_realized_pnl_cents($1) realized, eth_account_open_risk_cents($1) open_risk, EXISTS(SELECT 1 FROM eth_account_daily_loss_locks WHERE eastern_date=$1) latched`,[day]);
  const realized=Number(status.rows[0].realized);
  if(realized<=-120000&&!status.rows[0].latched) await client.query(`INSERT INTO eth_account_daily_loss_locks(eastern_date,threshold_cents,triggered_realized_pnl_cents,triggered_at_ms) VALUES($1,-120000,$2,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint) ON CONFLICT(eastern_date) DO NOTHING`,[day,realized]);
  await client.query("COMMIT");
  console.log(JSON.stringify({accountDailyLossGuard:"installed",thresholdCents:-120000,easternDate:day,realizedPnlCents:realized,openRiskCents:Number(status.rows[0].open_risk),latched:realized<=-120000||Boolean(status.rows[0].latched)}));
} catch(err){try{await client.query("ROLLBACK");}catch{} throw err;} finally {await client.end();}
