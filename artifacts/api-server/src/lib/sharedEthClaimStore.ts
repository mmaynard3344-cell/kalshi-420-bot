import { nextStep, wagerCents, type EthSettlement } from "./sharedEthMartingale";

/** Review-only cross-process ETH claim store. No live callers. */
type Row = Record<string, unknown>;
export type QueryClient = {
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
};
export type TransactionProvider = {
  transaction<T>(run: (tx: QueryClient) => Promise<T>): Promise<T>;
};
export type EthClaimRequest = {
  claimId: string; service: string; ticker: string; side: "yes" | "no";
};
export type EthClaim = EthClaimRequest & { step: number; budgetCents: number };

export async function claimFirstEthSignal(
  db: TransactionProvider, req: EthClaimRequest
): Promise<EthClaim | null> {
  if (!req.claimId || !req.service || !req.ticker || !["yes","no"].includes(req.side))
    throw new Error("incomplete ETH claim");
  return db.transaction(async tx => {
    const {rows} = await tx.query<{step:number;active_claim_id:string|null}>(
      "SELECT step, active_claim_id FROM eth_shared_martingale_state WHERE singleton=TRUE FOR UPDATE"
    );
    const state = rows[0];
    if (!state) throw new Error("ETH shared ladder has not been initialized");
    if (state.active_claim_id) return null;
    const step = Number(state.step), budgetCents = wagerCents(step);
    await tx.query(
      "INSERT INTO eth_shared_martingale_claims (claim_id,service,ticker,side,step,budget_cents) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.claimId,req.service,req.ticker,req.side,step,budgetCents]
    );
    await tx.query(
      "UPDATE eth_shared_martingale_state SET active_claim_id=$1,version=version+1,updated_at=NOW() WHERE singleton=TRUE",
      [req.claimId]
    );
    return {...req,step,budgetCents};
  });
}

export async function finalizeEthClaim(
  db: TransactionProvider,
  claimId: string,
  settlementId: string,
  outcome: EthSettlement
): Promise<{step:number; alreadyApplied:boolean}> {
  if (!claimId || !settlementId) throw new Error("missing settlement identity");
  return db.transaction(async tx => {
    const {rows} = await tx.query<{step:number;active_claim_id:string|null}>(
      "SELECT step,active_claim_id FROM eth_shared_martingale_state WHERE singleton=TRUE FOR UPDATE"
    );
    const state=rows[0];
    if(!state)throw new Error("ETH shared ladder missing");
    const claimRows=await tx.query<{status:string;settlement_id:string|null;step:number;outcome:EthSettlement|null}>(
      "SELECT status,settlement_id,step,outcome FROM eth_shared_martingale_claims WHERE claim_id=$1 FOR UPDATE",
      [claimId]
    );
    const claim=claimRows.rows[0];
    if(!claim)throw new Error("unknown ETH claim");
    if(["SETTLED","ZERO_FILL"].includes(claim.status)){
      if(claim.settlement_id!==settlementId || claim.outcome!==outcome)throw new Error("conflicting settlement identity or outcome");
      return {step:nextStep(Number(claim.step),outcome),alreadyApplied:true};
    }
    if(state.active_claim_id!==claimId)throw new Error("stale ETH settlement claim");
    if(claim.status!=="SUBMITTED")throw new Error("cannot settle an unsubmitted claim");
    const step=nextStep(Number(claim.step),outcome);
    await tx.query(
      "UPDATE eth_shared_martingale_claims SET status=$2,outcome=$3,settlement_id=$4,resolved_at=NOW() WHERE claim_id=$1",
      [claimId,outcome==="ZERO_FILL"?"ZERO_FILL":"SETTLED",outcome,settlementId]
    );
    await tx.query(
      "UPDATE eth_shared_martingale_state SET step=$1,active_claim_id=NULL,version=version+1,updated_at=NOW() WHERE singleton=TRUE",
      [step]
    );
    return {step,alreadyApplied:false};
  });
}

/** Must run in the same database as all ETH executors. Claim remains held
 * between order submission and authenticated terminal settlement. */
export async function markEthClaimSubmitted(
  db: TransactionProvider, claimId: string, orderId: string
): Promise<void> {
  if (!claimId || !orderId) throw new Error("claim and exchange order IDs required");
  await db.transaction(async tx => {
    const {rows}=await tx.query<{active_claim_id:string|null}>(
      "SELECT active_claim_id FROM eth_shared_martingale_state WHERE singleton=TRUE FOR UPDATE"
    );
    if(rows[0]?.active_claim_id!==claimId)throw new Error("ETH claim not active");
    const updated=await tx.query<{claim_id:string}>(
      "UPDATE eth_shared_martingale_claims SET status='SUBMITTED',order_id=$2 WHERE claim_id=$1 AND status='RESERVED' RETURNING claim_id",
      [claimId,orderId]
    );
    if(updated.rows.length!==1)throw new Error("claim not reservable for submission");
  });
}

/** Only a verified pre-submit failure can release an ETH claim.
 * Never use this to release an order whose exchange submission is uncertain. */
export async function releaseUnsubmittedEthClaim(
  db: TransactionProvider, claimId: string
): Promise<boolean> {
  if(!claimId)throw new Error("claim ID required");
  return db.transaction(async tx=>{
    const {rows}=await tx.query<{active_claim_id:string|null}>(
      "SELECT active_claim_id FROM eth_shared_martingale_state WHERE singleton=TRUE FOR UPDATE"
    );
    if(rows[0]?.active_claim_id!==claimId)return false;
    const updated=await tx.query<{claim_id:string}>(
      "UPDATE eth_shared_martingale_claims SET status='RELEASED',resolved_at=NOW() WHERE claim_id=$1 AND status='RESERVED' RETURNING claim_id",
      [claimId]
    );
    if(updated.rows.length!==1)return false;
    await tx.query(
      "UPDATE eth_shared_martingale_state SET active_claim_id=NULL,version=version+1,updated_at=NOW() WHERE singleton=TRUE"
    );
    return true;
  });
}
