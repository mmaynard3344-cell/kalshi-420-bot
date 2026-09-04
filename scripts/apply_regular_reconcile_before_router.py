from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
auto_path = ROOT / "artifacts/api-server/src/lib/autoTrader.ts"
source = auto_path.read_text()

old = '''  if (isEthTicker(state.ticker)) {
    const candidateRoad = await evaluateEth420Candidate(state, _timing);
    if (candidateRoad === "regular") {
      await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
        ticker: state.ticker,
        exchangeIndex: state.exchangeIndex ?? null,
        openTime: state.openTime,
        closeTime: state.closeTime,
        status: state.status,
      });
    }
    return;
  }'''
new = '''  if (isEthTicker(state.ticker)) {
    // Settle/cancel the immediately prior Regular lifecycle before choosing
    // ownership for this window. A verified Regular zero-fill arms the existing
    // one-window Back Flip in that same durable settlement transaction.
    if (!await reconcileEthMartingaleSettlements()) return;
    const candidateRoad = await evaluateEth420Candidate(state, _timing);
    if (candidateRoad === "regular") {
      await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
        ticker: state.ticker,
        exchangeIndex: state.exchangeIndex ?? null,
        openTime: state.openTime,
        closeTime: state.closeTime,
        status: state.status,
      });
    }
    return;
  }'''

count = source.count(old)
if count != 1:
    raise SystemExit(f"regular-before-router replacement count={count}")
auto_path.write_text(source.replace(old, new))
