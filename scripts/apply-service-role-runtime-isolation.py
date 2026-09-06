from pathlib import Path

p = Path("artifacts/api-server/src/lib/autoTrader.ts")
s = p.read_text()

old_import = '''import { runEthJumpServiceWhenExplicitlyEnabled } from "./strategies/ethJumpLiveRunner.js";
import { runEthReversalServiceWhenExplicitlyEnabled } from "./strategies/ethReversalLiveRunner.js";
'''
new_import = '''import { runEthJumpServiceWhenExplicitlyEnabled } from "./strategies/ethJumpLiveRunner.js";
import { runEthReversalServiceWhenExplicitlyEnabled } from "./strategies/ethReversalLiveRunner.js";
import { currentEthServiceRole, serviceMayRunMartingale } from "./strategies/ethServiceRole.js";
'''
if s.count(old_import) != 1:
    raise SystemExit(f"expected exactly one B/C import block, found {s.count(old_import)}")
s = s.replace(old_import, new_import)

old_a = '''  if (isEthTicker(state.ticker)) {
    await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
      ticker: state.ticker,
      exchangeIndex: state.exchangeIndex ?? null,
      openTime: state.openTime,
      closeTime: state.closeTime,
      status: state.status,
    });
    await evaluateEth420Candidate(state, _timing);
  const jumpOpenTimeMs = state.openTime == null ? null : Date.parse(state.openTime);
'''
new_a = '''  if (isEthTicker(state.ticker)) {
    const ethServiceRole = currentEthServiceRole();
    if (serviceMayRunMartingale(ethServiceRole)) {
      await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)({
        ticker: state.ticker,
        exchangeIndex: state.exchangeIndex ?? null,
        openTime: state.openTime,
        closeTime: state.closeTime,
        status: state.status,
      });
      await evaluateEth420Candidate(state, _timing);
    }
  const jumpOpenTimeMs = state.openTime == null ? null : Date.parse(state.openTime);
'''
if s.count(old_a) != 1:
    raise SystemExit(f"expected exactly one A evaluator block, found {s.count(old_a)}")
s = s.replace(old_a, new_a)
p.write_text(s)

# Exact isolation assertions.
assert 'import { currentEthServiceRole, serviceMayRunMartingale } from "./strategies/ethServiceRole.js";' in s
assert 'const ethServiceRole = currentEthServiceRole();' in s
assert 'if (serviceMayRunMartingale(ethServiceRole)) {' in s
role_gate = s.index('if (serviceMayRunMartingale(ethServiceRole)) {')
legacy_a = s.index('await (_evaluateEthNoMartingaleImpl ?? evaluateEthNoMartingale)', role_gate)
candidate_a = s.index('await evaluateEth420Candidate(state, _timing);', role_gate)
jump_call = s.index('await runEthJumpServiceWhenExplicitlyEnabled', candidate_a)
assert role_gate < legacy_a < candidate_a < jump_call

role_file = Path("artifacts/api-server/src/lib/strategies/ethServiceRole.ts").read_text()
assert 'return role == null || role === "martingale";' in role_file
jump = Path("artifacts/api-server/src/lib/strategies/ethJumpLiveRunner.ts").read_text()
reversal = Path("artifacts/api-server/src/lib/strategies/ethReversalLiveRunner.ts").read_text()
assert 'ETH_JUMP_SERVICE_EXECUTION_APPROVED = false' in jump
assert 'ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = false' in reversal
