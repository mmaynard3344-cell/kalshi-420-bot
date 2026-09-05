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
store_path.write_text(store)
