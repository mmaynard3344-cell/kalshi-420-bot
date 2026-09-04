from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
store_path = ROOT / "artifacts/api-server/src/lib/tradeStore.ts"
source = store_path.read_text()

regular_old = '''    return await _db.transaction(async (tx) => {
      if (params.claimProofFence) {'''
regular_new = '''    return await _db.transaction(async (tx) => {
      // One ETH ticker may have exactly one execution owner across Regular,
      // 420 Jump, and Back Flip. Serialize cross-ledger reservation and fail
      // closed if the candidate ledger already owns this ticker.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth-three-road:" + params.ticker}))`);
      const candidateOwner = await tx.execute(sql`
        SELECT 1 FROM eth420_candidate_live_orders WHERE ticker=${params.ticker} LIMIT 1`);
      if ((candidateOwner as unknown as { rows: unknown[] }).rows.length > 0) {
        throw new EthMartingaleReservationRollback("ETH ticker already candidate-owned");
      }
      if (params.claimProofFence) {'''
if source.count(regular_old) != 1:
    raise SystemExit(f"regular cross-road insertion count={source.count(regular_old)}")
source = source.replace(regular_old, regular_new)

candidate_old = '''    return await _db.transaction(async (tx) => {
      // Serialize the immutable activation boundary with each primary
      // reservation. The boundary timestamp is created under the same lock, so
      // a row cannot race from "already existed" into post-cutover eligibility.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-secondary-activation-cutover"}))`);'''
candidate_new = '''    return await _db.transaction(async (tx) => {
      // Share one durable ticker-ownership fence with the Regular martingale.
      // This is intentionally before candidate-specific locks so concurrent
      // Regular and special-road reservations cannot both commit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth-three-road:" + params.ticker}))`);
      const regularOwner = await tx.execute(sql`
        SELECT 1 FROM eth_martingale_claims
        WHERE generation=${ETH_MARTINGALE_ACTIVE_GENERATION_KEY} AND ticker=${params.ticker}
        LIMIT 1`);
      if ((regularOwner as unknown as { rows: unknown[] }).rows.length > 0) return false;
      // Serialize the immutable activation boundary with each primary
      // reservation. The boundary timestamp is created under the same lock, so
      // a row cannot race from "already existed" into post-cutover eligibility.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"eth420-secondary-activation-cutover"}))`);'''
if source.count(candidate_old) != 1:
    raise SystemExit(f"candidate cross-road insertion count={source.count(candidate_old)}")
source = source.replace(candidate_old, candidate_new)

store_path.write_text(source)
