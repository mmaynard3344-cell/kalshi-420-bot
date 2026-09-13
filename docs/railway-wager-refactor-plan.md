# Railway wager refactor plan

Non-production helper plan only. No Railway service is switched or deployed by this file.

Target services: B, C, D, E, F, H, I. G remains disabled. A and J are unchanged.

Each service should read a dedicated Railway environment variable in cents and fall back to its current hard-coded wager when the variable is absent or invalid:

- B: ETH_B_WAGER_CENTS
- C: ETH_C_WAGER_CENTS
- D: ETH_D_WAGER_CENTS
- E: ETH_E_WAGER_CENTS
- F: ETH_F_WAGER_CENTS
- H: ETH_H_WAGER_CENTS
- I: ETH_I_WAGER_CENTS

Temporary $50 target would be 5000 cents for each variable.

Safety constraints:
- Do not change signal thresholds, sides, timing windows, order tags, settlement logic, capital guards, or service enablement.
- G stays disabled.
- J keeps its existing validation cap.
- No production branch switch or Railway deploy is performed as part of this plan.
