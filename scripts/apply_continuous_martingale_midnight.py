from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} replacement count={count}")
    return text.replace(old, new)


# This patch runs after the final two-road patch. ET midnight resets only
# per-day accounting. The durable martingale side/rung remains continuous.
regular_path = ROOT / "artifacts/api-server/src/lib/strategies/ethOnlyMartingale.ts"
regular = regular_path.read_text()

regular = replace_once(
    regular,
    '''    // Day-change reset: sequence.easternDate mismatch means the store will reset on first\n    // reservation. Compute effective values for this fresh day.\n    const isNewDay = sequence.easternDate !== date;\n    const effectivePnl = requestedRealizedPnlCents == null\n      ? (isNewDay ? 0 : sequence.realizedPnlCents)\n      : Math.trunc(requestedRealizedPnlCents);\n    const effectiveStep = requestedStep == null\n      ? (isNewDay ? 0 : sequence.martingaleStep)\n      : Math.max(0, Math.trunc(requestedStep));\n    // Side also resets to "no" at the start of each fresh ET day.\n    const effectiveSide: "yes" | "no" = requestedSide ?? (isNewDay ? "no" : sequence.side);''',
    '''    // ET-day rollover resets accounting only. The martingale sequence is\n    // continuous across midnight: side/rung change only from an actual filled\n    // settlement (or the existing final-rung reset), never from the calendar.\n    const isNewDay = sequence.easternDate !== date;\n    const effectivePnl = requestedRealizedPnlCents == null\n      ? (isNewDay ? 0 : sequence.realizedPnlCents)\n      : Math.trunc(requestedRealizedPnlCents);\n    const effectiveStep = requestedStep == null\n      ? sequence.martingaleStep\n      : Math.max(0, Math.trunc(requestedStep));\n    const effectiveSide: "yes" | "no" = requestedSide ?? sequence.side;''',
    "regular midnight sequence carry",
)

regular_path.write_text(regular)


# The reservation transaction is the durable owner of the state row. On a new
# ET date it still moves eastern_date forward and resets spent/P&L accounting,
# but must not reset side or martingale_step underneath the gateway.
store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
store = store_path.read_text()

store = replace_once(
    store,
    '''      // Reset day if eastern_date changed before adding cost.\n      // Note: the state table's side/step/pnl are only reset when eastern_date changes;\n      // within the same day they are left as-is (settlement drives those transitions).\n      const budget = await tx.execute(sql`\n        UPDATE eth_martingale_state\n        SET eastern_date = ${params.easternDate},\n            spent_cents = CASE WHEN eastern_date = ${params.easternDate} THEN spent_cents + ${cost} ELSE ${cost} END,\n            realized_pnl_cents = CASE WHEN eastern_date = ${params.easternDate} THEN realized_pnl_cents ELSE 0 END,\n            side = CASE WHEN eastern_date = ${params.easternDate} THEN side ELSE 'no' END,\n            martingale_step = CASE WHEN eastern_date = ${params.easternDate} THEN martingale_step ELSE 0 END,\n            updated_at_ms = ${now}\n        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\n        RETURNING spent_cents`);''',
    '''      // ET-day rollover resets only per-day accounting. The martingale\n      // side/rung remain durable and continuous across midnight.\n      const budget = await tx.execute(sql`\n        UPDATE eth_martingale_state\n        SET eastern_date = ${params.easternDate},\n            spent_cents = CASE WHEN eastern_date = ${params.easternDate} THEN spent_cents + ${cost} ELSE ${cost} END,\n            realized_pnl_cents = CASE WHEN eastern_date = ${params.easternDate} THEN realized_pnl_cents ELSE 0 END,\n            updated_at_ms = ${now}\n        WHERE strategy_key = ${ETH_MARTINGALE_ACTIVE_GENERATION_KEY}\n        RETURNING spent_cents`);''',
    "durable midnight sequence carry",
)

store = replace_once(
    store,
    '  /** Which side we are betting next. Starts "no" each day. */',
    '  /** Which side we are betting next. Initialized to "no"; then continuous across ET-day boundaries. */',
    "state side documentation",
)

store_path.write_text(store)
