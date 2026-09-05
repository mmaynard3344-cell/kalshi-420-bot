from pathlib import Path

p = Path('artifacts/api-server/src/lib/autoTrader.ts')
s = p.read_text()

b_import = 'import { runEthJumpServiceWhenExplicitlyEnabled } from "./strategies/ethJumpLiveRunner.js";'
c_import = 'import { runEthReversalServiceWhenExplicitlyEnabled } from "./strategies/ethReversalLiveRunner.js";'
if c_import not in s:
    if b_import not in s:
        raise SystemExit('Service B import anchor not found')
    s = s.replace(b_import, b_import + '\n' + c_import, 1)

if 'await runEthReversalServiceWhenExplicitlyEnabled({' not in s:
    b_call_end = '''    // Dormant wiring only. A later separately reviewed capital snapshot
    // provider is required before the hard B execution fence can change.
    capital: null,
  });'''
    c_call = '''    // Dormant wiring only. C shares the same market identity but has its own
    // independent signal, ledger identity, and hard execution fence.
    await runEthReversalServiceWhenExplicitlyEnabled({
      store: tradeStore,
      market: {
        ticker: state.ticker,
        easternDate: jumpOpenTimeMs != null && Number.isFinite(jumpOpenTimeMs)
          ? easternDay(new Date(jumpOpenTimeMs)) : easternDay(new Date()),
        observedAtMs: Date.now(),
        floorStrike: state.floorStrike ?? null,
        openTimeMs: jumpOpenTimeMs,
      },
      exchangeIndex: state.exchangeIndex ?? null,
      // No capital provider is wired in this staging commit, so C remains
      // fail-closed even independently of its hard code approval fence.
      capital: null,
    });'''
    if b_call_end not in s:
        raise SystemExit('Service B call anchor not found')
    s = s.replace(b_call_end, b_call_end + '\n' + c_call, 1)

p.write_text(s)

b = Path('artifacts/api-server/src/lib/strategies/ethJumpLiveRunner.ts').read_text()
c = Path('artifacts/api-server/src/lib/strategies/ethReversalLiveRunner.ts').read_text()
auto = p.read_text()
assert auto.count('runEthJumpServiceWhenExplicitlyEnabled({') == 1
assert auto.count('runEthReversalServiceWhenExplicitlyEnabled({') == 1
block_start = auto.index('await runEthJumpServiceWhenExplicitlyEnabled({')
block_end = auto.index('\n  }\n  // The retired BTC/SOL/DOGE', block_start)
service_block = auto[block_start:block_end]
assert service_block.count('capital: null') == 2
assert 'export const ETH_JUMP_SERVICE_EXECUTION_APPROVED = false;' in b
assert 'export const ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = false;' in c
assert 'EXECUTION_APPROVED = true' not in b
assert 'EXECUTION_APPROVED = true' not in c
