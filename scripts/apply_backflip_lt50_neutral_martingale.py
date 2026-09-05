from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts"
source = path.read_text()

old = '''    const nextState = {\n      ...advanceEth420State(transitionState, result, filled),\n      // Sequence derives from the actual persisted order snapshot; P&L stays\n      // cumulative across the chronological recovery sweep.\n      realizedPnlCents: (currentState?.realizedPnlCents ?? transitionState.realizedPnlCents) + pnl,\n    };'''
new = '''    // The <50c Back Flip is an isolated $25 opposite-side trade. It owns this\n    // market, but it must not advance, reset, or flip the martingale sequence.\n    // Its immutable live-order signature is 50 requested contracts at the 50c\n    // resting limit. P&L is still accounted normally.\n    const neutralLt50BackFlip = order.requestedContracts === 50\n      && order.limitPriceCents === ETH_420_LIVE_LIMIT_PRICE_CENTS;\n    const sequenceState = neutralLt50BackFlip\n      ? transitionState\n      : advanceEth420State(transitionState, result, filled);\n    const nextState = {\n      ...sequenceState,\n      // Sequence derives from the actual persisted order snapshot; P&L stays\n      // cumulative across the chronological recovery sweep.\n      realizedPnlCents: (currentState?.realizedPnlCents ?? transitionState.realizedPnlCents) + pnl,\n    };'''

if source.count(old) != 1:
    raise SystemExit(f"lt50 neutral martingale replacement count={source.count(old)}")

path.write_text(source.replace(old, new))
