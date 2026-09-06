from pathlib import Path

p = Path("artifacts/api-server/src/index.ts")
s = p.read_text()

old_import = '''import { refreshEth420RunawayResearch } from "./lib/eth420RunawayResearch.js";
import {
  WEEK_2_PRODUCTION_NEW_ENTRY_SERIES,
} from "./lib/week2EntryPolicy.js";
'''
new_import = '''import { refreshEth420RunawayResearch } from "./lib/eth420RunawayResearch.js";
import { runEthBigBetAccountingSweepSingleFlight } from "./lib/strategies/ethBigBetAccountingSweep.js";
import {
  WEEK_2_PRODUCTION_NEW_ENTRY_SERIES,
} from "./lib/week2EntryPolicy.js";
'''
if s.count(old_import) != 1:
    raise SystemExit(f"expected one accounting sweep import anchor, found {s.count(old_import)}")
s = s.replace(old_import, new_import)

old_const = '''const ETH_420_RUNAWAY_RESEARCH_REFRESH_INTERVAL_MS = 60_000;
const ETH_MARKET_WINDOW_MS = 15 * 60_000;
'''
new_const = '''const ETH_420_RUNAWAY_RESEARCH_REFRESH_INTERVAL_MS = 60_000;
const ETH_BIG_BET_ACCOUNTING_SWEEP_INTERVAL_MS = 5 * 60_000;
const ETH_MARKET_WINDOW_MS = 15 * 60_000;
'''
if s.count(old_const) != 1:
    raise SystemExit(f"expected one accounting interval anchor, found {s.count(old_const)}")
s = s.replace(old_const, new_const)

anchor = '''    runEth420CandidateLifecycleSweep();

    // Every ETH 15-minute close gets the same fast lifecycle treatment. This
'''
insert = '''    runEth420CandidateLifecycleSweep();

    // B/C settlement is accounting-only and never controls future strategy
    // evaluation. Retry incomplete authenticated fill evidence at startup and
    // on a low-cadence single-flight timer so resolved rows release reserved
    // capital without coupling B/C to martingale settlement state.
    const runEthBigBetAccountingSweep = () => {
      void runEthBigBetAccountingSweepSingleFlight().then((result) => {
        if (result.settledRows > 0 || result.unresolvedRows > 0 || result.errors > 0) {
          logger.info(result, "B/C accounting retry sweep completed");
        }
      }).catch((err) => logger.warn({ err }, "B/C accounting retry sweep failed"));
    };
    runEthBigBetAccountingSweep();
    const ethBigBetAccountingSweepTimer = setInterval(
      runEthBigBetAccountingSweep,
      ETH_BIG_BET_ACCOUNTING_SWEEP_INTERVAL_MS,
    );
    ethBigBetAccountingSweepTimer.unref();

    // Every ETH 15-minute close gets the same fast lifecycle treatment. This
'''
if s.count(anchor) != 1:
    raise SystemExit(f"expected one candidate lifecycle scheduling anchor, found {s.count(anchor)}")
s = s.replace(anchor, insert)
p.write_text(s)

# Safety assertions: scheduler is production-only by placement, accounting-only,
# bounded by the sweep module, unref'd, and does not alter B/C execution fences.
prod = s.index('if (isProductionRuntime()) {')
sweep = s.index('const runEthBigBetAccountingSweep = () => {')
else_branch = s.index('  } else {', sweep)
assert prod < sweep < else_branch
assert 'ETH_BIG_BET_ACCOUNTING_SWEEP_INTERVAL_MS = 5 * 60_000' in s
assert 'ethBigBetAccountingSweepTimer.unref();' in s
assert 'startAutoTrader();' in s[prod:sweep]

jump = Path("artifacts/api-server/src/lib/strategies/ethJumpLiveRunner.ts").read_text()
reversal = Path("artifacts/api-server/src/lib/strategies/ethReversalLiveRunner.ts").read_text()
assert 'ETH_JUMP_SERVICE_EXECUTION_APPROVED = false' in jump
assert 'ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = false' in reversal
