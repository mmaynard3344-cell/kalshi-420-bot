from pathlib import Path

p = Path("artifacts/api-server/src/lib/outcomeReconciler.ts")
s = p.read_text()

anchor = '''    recordWindowSettlementInSql(ticker, result as "yes" | "no");
    wlSetSettlementResult(ticker, result as "yes" | "no");
'''
insert = '''    recordWindowSettlementInSql(ticker, result as "yes" | "no");
    wlSetSettlementResult(ticker, result as "yes" | "no");

    // B/C settlement is accounting-only. It consumes the already-authoritative
    // market result, never mutates martingale state, and must never interrupt
    // the existing outcome reconciliation path if its own evidence is incomplete.
    if (/^KXETH15M-/.test(ticker)) {
      try {
        const { reconcilePersistedEthBigBetsForTicker } = await import(
          "./strategies/ethBigBetSettlementReconciler.js"
        );
        const bigBetAccounting = await reconcilePersistedEthBigBetsForTicker(
          ticker,
          result as "yes" | "no",
        );
        if (bigBetAccounting.settled > 0 || bigBetAccounting.unresolved > 0) {
          logger.info(
            { ticker, result, ...bigBetAccounting },
            "B/C accounting sidecar processed authoritative ETH settlement",
          );
        }
      } catch (err) {
        logger.warn(
          { err, ticker, result },
          "B/C accounting sidecar unavailable; normal outcome reconciliation continues",
        );
      }
    }
'''
if s.count(anchor) != 1:
    raise SystemExit(f"expected one authoritative settlement anchor, found {s.count(anchor)}")
s = s.replace(anchor, insert)
p.write_text(s)

# Safety assertions: sidecar appears only after authoritative YES/NO persistence,
# is ETH-only, dynamically imported, and cannot precede market-result validation.
assert s.count('reconcilePersistedEthBigBetsForTicker') == 2
persist = s.index('recordWindowSettlementInSql(ticker, result as "yes" | "no");')
sidecar = s.index('const { reconcilePersistedEthBigBetsForTicker }')
phase4 = s.index('if (process.env["PHASE4B_PASSIVE_CAPTURE_ENABLED"]')
assert persist < sidecar < phase4
assert 'if (/^KXETH15M-/.test(ticker)) {' in s[persist:sidecar]
assert 'normal outcome reconciliation continues' in s

jump = Path("artifacts/api-server/src/lib/strategies/ethJumpLiveRunner.ts").read_text()
reversal = Path("artifacts/api-server/src/lib/strategies/ethReversalLiveRunner.ts").read_text()
assert 'ETH_JUMP_SERVICE_EXECUTION_APPROVED = false' in jump
assert 'ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = false' in reversal
