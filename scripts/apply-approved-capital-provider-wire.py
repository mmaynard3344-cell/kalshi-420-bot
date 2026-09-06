from pathlib import Path

p = Path("artifacts/api-server/src/lib/autoTrader.ts")
s = p.read_text()

old_b = '''    exchangeIndex: state.exchangeIndex ?? null,
    // Dormant wiring only. A later separately reviewed capital snapshot
    // provider is required before the hard B execution fence can change.
    capital: null,
'''
new_b = '''    exchangeIndex: state.exchangeIndex ?? null,
'''
old_c = '''      exchangeIndex: state.exchangeIndex ?? null,
      // No capital provider is wired in this staging commit, so C remains
      // fail-closed even independently of its hard code approval fence.
      capital: null,
'''
new_c = '''      exchangeIndex: state.exchangeIndex ?? null,
'''

if s.count(old_b) != 1:
    raise SystemExit(f"expected exactly one dormant B capital block, found {s.count(old_b)}")
if s.count(old_c) != 1:
    raise SystemExit(f"expected exactly one dormant C capital block, found {s.count(old_c)}")

s = s.replace(old_b, new_b).replace(old_c, new_c)
p.write_text(s)

# Safety assertions: the auto-trader may reach the dormant runners, but it must
# not contain ad-hoc reserve values or any direct capital-provider call.
assert "capital: null" not in s[s.index("runEthJumpServiceWhenExplicitlyEnabled"):s.index("The retired BTC/SOL/DOGE")]
assert "43_470" not in s
assert "51_750" not in s
assert "readApprovedEthBigBetCapitalBase" not in s

jump = Path("artifacts/api-server/src/lib/strategies/ethJumpLiveRunner.ts").read_text()
reversal = Path("artifacts/api-server/src/lib/strategies/ethReversalLiveRunner.ts").read_text()
provider = Path("artifacts/api-server/src/lib/strategies/ethBigBetApprovedCapitalProvider.ts").read_text()
assert "ETH_JUMP_SERVICE_EXECUTION_APPROVED = false" in jump
assert "ETH_REVERSAL_SERVICE_EXECUTION_APPROVED = false" in reversal
assert "readApprovedEthBigBetCapitalBase" in jump
assert "readApprovedEthBigBetCapitalBase" in reversal
assert "ETH_BIG_BET_MARTINGALE_RESERVE_CENTS = 43_470" in provider
assert "ETH_BIG_BET_SAFETY_RESERVE_CENTS = 51_750" in provider
