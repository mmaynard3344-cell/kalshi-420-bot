from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} replacement count={count}")
    return text.replace(old, new)


# Midnight ET starts a fresh accounting/risk day, but the martingale sequence is continuous.
regular_path = ROOT / "artifacts/api-server/src/lib/strategies/ethOnlyMartingale.ts"
regular = regular_path.read_text()
old_preflight = '''    // Day-change reset: sequence.easternDate mismatch means the store will reset on first
    // reservation. Compute effective values for this fresh day.
    const isNewDay = sequence.easternDate !== date;
    const effectivePnl = requestedRealizedPnlCents == null
      ? (isNewDay ? 0 : sequence.realizedPnlCents)
      : Math.trunc(requestedRealizedPnlCents);
    const effectiveStep = requestedStep == null
      ? (isNewDay ? 0 : sequence.martingaleStep)
      : Math.max(0, Math.trunc(requestedStep));
    // Side also resets to "no" at the start of each fresh ET day.
    const effectiveSide: "yes" | "no" = requestedSide ?? (isNewDay ? "no" : sequence.side);'''
new_preflight = '''    // Day change resets daily accounting/risk only. The martingale sequence is continuous
    // across midnight ET, so side and rung always come from the durable sequence unless
    // an explicitly approved caller override is supplied.
    const isNewDay = sequence.easternDate !== date;
    const effectivePnl = requestedRealizedPnlCents == null
      ? (isNewDay ? 0 : sequence.realizedPnlCents)
      : Math.trunc(requestedRealizedPnlCents);
    const effectiveStep = requestedStep == null
      ? sequence.martingaleStep
      : Math.max(0, Math.trunc(requestedStep));
    const effectiveSide: "yes" | "no" = requestedSide ?? sequence.side;'''
regular = replace_once(regular, old_preflight, new_preflight, "midnight preflight carry")
regular_path.write_text(regular)


# The first reservation after midnight advances the date and clears only daily counters.
# It must not reset the durable sequence side/rung.
store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
store = store_path.read_text()
old_reservation = '''      // Reset day if eastern_date changed before adding cost.
      // Note: the state table's side/step/pnl are only reset when eastern_date changes;
      // within the same day they are left as-is (settlement drives those transitions).
      const budget = await tx.execute(sql`
        UPDATE eth_martingale_state
        SET eastern_date = ${params.easternDate},
            spent_cents = CASE WHEN eastern_date = ${params.easternDate} THEN spent_cents + ${cost} ELSE ${cost} END,
            realized_pnl_cents = CASE WHEN eastern_date = ${params.easternDate} THEN realized_pnl_cents ELSE 0 END,
            side = CASE WHEN eastern_date = ${params.easternDate} THEN side ELSE 'no' END,
            martingale_step = CASE WHEN eastern_date = ${params.easternDate} THEN martingale_step ELSE 0 END,
            updated_at_ms = ${now}
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        RETURNING spent_cents`);'''
new_reservation = '''      // A new Eastern date starts a fresh daily accounting/risk bucket only.
      // Sequence side and rung are deliberately untouched across midnight; settlement
      // remains the only normal mechanism that changes those durable fields.
      const budget = await tx.execute(sql`
        UPDATE eth_martingale_state
        SET eastern_date = ${params.easternDate},
            spent_cents = CASE WHEN eastern_date = ${params.easternDate} THEN spent_cents + ${cost} ELSE ${cost} END,
            realized_pnl_cents = CASE WHEN eastern_date = ${params.easternDate} THEN realized_pnl_cents ELSE 0 END,
            updated_at_ms = ${now}
        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
        RETURNING spent_cents`);'''
store = replace_once(store, old_reservation, new_reservation, "midnight durable carry")


# Settlement chronology ownership: a late older filled Regular order must still
# book its exact P&L once, but it must never overwrite side/rung after a newer
# officially settled filled Regular order has already become authoritative.
old_returning = '''        RETURNING martingale_step, side, eastern_date, no_price_cents,
                  requested_contracts, filled_contracts, actual_notional_dollars, actual_fee_dollars`);
      const row = (settled as unknown as {
        rows: Array<{
          martingale_step: number; side: string; eastern_date: string;
          no_price_cents: number; requested_contracts: number;
          filled_contracts: number; actual_notional_dollars: string | number; actual_fee_dollars: string | number;
        }>;
      }).rows[0];'''
new_returning = '''        RETURNING martingale_step, side, eastern_date, ticker, created_at_ms, no_price_cents,
                  requested_contracts, filled_contracts, actual_notional_dollars, actual_fee_dollars`);
      const row = (settled as unknown as {
        rows: Array<{
          martingale_step: number; side: string; eastern_date: string; ticker: string; created_at_ms: number;
          no_price_cents: number; requested_contracts: number;
          filled_contracts: number; actual_notional_dollars: string | number; actual_fee_dollars: string | number;
        }>;
      }).rows[0];'''
store = replace_once(store, old_returning, new_returning, "settlement chronology returning")

old_state_transition = '''      // Old-date guard: only advance the sequence when the state table is still
      // on the same ET day as the order. If the day has rolled over, the fresh
      // day's state is correct as-is and must not be corrupted by a stale order.
      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET side=${nextSide}, martingale_step=${nextStep},
            realized_pnl_cents=realized_pnl_cents + ${pnlDelta},
            updated_at_ms=${now}
          WHERE strategy_key=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}`);
      // Note: if the WHERE above matches zero rows (day rolled over), we have
      // still settled the order row, which is correct — the accounting for that
      // old order is preserved in the order's own record.'''
new_state_transition = '''      // Financial accounting is order-idempotent because the order transition above
      // requires settlement_result IS NULL. Book that exact P&L even when this order
      // is chronologically stale; chronology ownership applies only to side/rung.
      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET realized_pnl_cents=realized_pnl_cents + ${pnlDelta},
            updated_at_ms=${now}
        WHERE strategy_key=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}`);

      // Sequence ownership is chronological. A newer officially settled filled
      // Regular order on the same ET day already owns the authoritative side/rung,
      // so this older settlement may not overwrite it. Zero-fill, rejected,
      // unresolved, and manual-recovery rows do not become chronology owners.
      await tx.execute(sql`
        UPDATE eth_martingale_state
        SET side=${nextSide}, martingale_step=${nextStep}, updated_at_ms=${now}
        WHERE strategy_key=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
          AND eastern_date=${row.eastern_date}
          AND NOT EXISTS (
            SELECT 1
            FROM eth_martingale_orders newer
            WHERE newer.generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}
              AND newer.eastern_date=${row.eastern_date}
              AND newer.created_at_ms > ${row.created_at_ms}
              AND newer.settlement_result IN ('yes','no')
              AND newer.manual_settlement_override=false
              AND COALESCE(newer.filled_contracts, 0) > 0
              AND newer.outcome IN ('full_fill','partial_fill')
          )`);
      // If the state row has rolled to a different ET accounting day, neither
      // update matches; the settled order row remains the durable historical record.'''
store = replace_once(store, old_state_transition, new_state_transition, "settlement chronology ownership")

# Fail the build if an earlier transform did not produce the intended six-step
# Regular transition before this final chronology patch runs.
if 'const nextStep = won ? 0 : orderStep >= 5 ? 0 : orderStep + 1;' not in store:
    raise SystemExit("final Regular six-step settlement transition missing")
if 'newer.created_at_ms > ${row.created_at_ms}' not in store:
    raise SystemExit("final Regular settlement chronology guard missing")

store_path.write_text(store)
