import { sql } from "drizzle-orm";
import type {
  A2AcquireResult,
  A2DryRunPayload,
  A2ExecutionIntent,
  A2ExecutionStore,
  A2ExecutionState,
} from "./a2ExecutionAdapter.js";

export const A2_EXECUTION_ADVISORY_LOCK = 42017012;

type DbLike = {
  execute(query: unknown): Promise<unknown>;
  transaction<T>(fn: (tx: DbLike) => Promise<T>): Promise<T>;
};

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return (result as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
}

function toIntent(row: Record<string, unknown> | undefined): A2ExecutionIntent | null {
  if (!row) return null;
  const id = String(row["id"] ?? "");
  const signalId = String(row["signal_id"] ?? "");
  const marketTicker = String(row["market_ticker"] ?? "");
  const clientOrderId = String(row["client_order_id"] ?? "");
  if (!id || !signalId || !marketTicker || !clientOrderId) return null;
  const num = (key: string): number | null => row[key] == null ? null : Number(row[key]);
  return {
    id,
    signalId,
    marketTicker,
    side: "yes",
    action: "buy",
    stakeCents: 500,
    maxEntryPriceCents: 45,
    clientOrderId,
    state: String(row["state"] ?? "") as A2ExecutionState,
    executableYesPriceCents: num("executable_yes_price_cents"),
    quantity: num("quantity"),
    maxNotionalCents: num("max_notional_cents"),
    priceCheckedAtMs: num("price_checked_at_ms"),
    kalshiOrderId: row["kalshi_order_id"] == null ? null : String(row["kalshi_order_id"]),
  };
}

export async function ensureA2ExecutionSchema(db: DbLike): Promise<void> {
  await db.execute(sql\`
    CREATE TABLE IF NOT EXISTS a2_execution_intents (
      id text PRIMARY KEY,
      signal_id text NOT NULL,
      strategy text NOT NULL DEFAULT 'A2',
      market_ticker text NOT NULL,
      side text NOT NULL DEFAULT 'yes',
      action text NOT NULL DEFAULT 'buy',
      stake_cents integer NOT NULL DEFAULT 500,
      max_entry_price_cents integer NOT NULL DEFAULT 45,
      client_order_id text NOT NULL UNIQUE,
      exposure_slot_id text NOT NULL DEFAULT 'a2-singleton',
      state text NOT NULL,
      executable_yes_price_cents integer,
      quantity integer,
      max_notional_cents integer,
      price_checked_at_ms bigint,
      payload_json jsonb,
      kalshi_order_id text,
      terminal_reason text,
      realized_pnl_cents integer,
      settlement_result text,
      created_at_ms bigint NOT NULL,
      updated_at_ms bigint NOT NULL,
      settled_at_ms bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(signal_id, market_ticker)
    );
    CREATE INDEX IF NOT EXISTS a2_execution_intents_state_idx
      ON a2_execution_intents(state, updated_at_ms);
    CREATE INDEX IF NOT EXISTS a2_execution_intents_ticker_idx
      ON a2_execution_intents(market_ticker);

    CREATE TABLE IF NOT EXISTS a2_execution_settlements (
      id text PRIMARY KEY,
      intent_id text NOT NULL,
      market_ticker text NOT NULL,
      settlement_version integer NOT NULL DEFAULT 1,
      result text NOT NULL,
      realized_pnl_cents integer NOT NULL,
      settled_at_ms bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(intent_id, settlement_version)
    );
  \`);
}

export class PostgresA2ExecutionStore implements A2ExecutionStore {
  constructor(private readonly db: DbLike) {}

  async acquireExposure(input: {
    id: string;
    signalId: string;
    marketTicker: string;
    clientOrderId: string;
    nowMs: number;
  }): Promise<A2AcquireResult> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql\`SELECT pg_advisory_xact_lock(\${A2_EXECUTION_ADVISORY_LOCK})\`);

        const duplicate = await tx.execute(sql\`
          SELECT * FROM a2_execution_intents
          WHERE client_order_id=\${input.clientOrderId}
             OR (signal_id=\${input.signalId} AND market_ticker=\${input.marketTicker})
          LIMIT 1
        \`);
        const existing = toIntent(rowsOf(duplicate)[0]);
        if (existing) return { outcome: "duplicate", intent: existing } as const;

        const active = await tx.execute(sql\`
          SELECT id FROM a2_execution_intents
          WHERE state IN (
            'EXPOSURE_LOCKED','PRICE_CONFIRMED','ORDER_INTENT_CREATED','DRY_RUN_READY',
            'SUBMISSION_UNKNOWN','OPEN','PARTIALLY_FILLED','FILLED'
          )
          LIMIT 1
        \`);
        if (rowsOf(active).length > 0) {
          return { outcome: "active_exposure_limit", intent: null } as const;
        }

        const inserted = await tx.execute(sql\`
          INSERT INTO a2_execution_intents
            (id, signal_id, market_ticker, client_order_id, state, created_at_ms, updated_at_ms)
          VALUES
            (\${input.id}, \${input.signalId}, \${input.marketTicker}, \${input.clientOrderId},
             'EXPOSURE_LOCKED', \${input.nowMs}, \${input.nowMs})
          RETURNING *
        \`);
        const intent = toIntent(rowsOf(inserted)[0]);
        return intent
          ? { outcome: "acquired", intent } as const
          : { outcome: "store_unavailable", intent: null } as const;
      });
    } catch {
      return { outcome: "store_unavailable", intent: null };
    }
  }

  async markDryRunReady(input: {
    id: string;
    executableYesPriceCents: number;
    quantity: number;
    maxNotionalCents: number;
    priceCheckedAtMs: number;
    payload: A2DryRunPayload;
  }): Promise<boolean> {
    try {
      const result = await this.db.execute(sql\`
        UPDATE a2_execution_intents
        SET state='DRY_RUN_READY',
            executable_yes_price_cents=\${input.executableYesPriceCents},
            quantity=\${input.quantity},
            max_notional_cents=\${input.maxNotionalCents},
            price_checked_at_ms=\${input.priceCheckedAtMs},
            payload_json=\${JSON.stringify(input.payload)}::jsonb,
            updated_at_ms=\${input.priceCheckedAtMs},
            updated_at=now()
        WHERE id=\${input.id}
          AND state='EXPOSURE_LOCKED'
        RETURNING id
      \`);
      return rowsOf(result).length === 1;
    } catch {
      return false;
    }
  }

  async releaseUnsubmitted(input: {
    id: string;
    terminalState: "PRICE_TOO_HIGH" | "EXPIRED_UNSUBMITTED" | "REJECTED";
    reason: string;
    nowMs: number;
  }): Promise<boolean> {
    try {
      const result = await this.db.execute(sql\`
        UPDATE a2_execution_intents
        SET state='EXPOSURE_RELEASED',
            terminal_reason=\${input.terminalState + ":" + input.reason},
            updated_at_ms=\${input.nowMs},
            updated_at=now()
        WHERE id=\${input.id}
          AND state IN ('EXPOSURE_LOCKED','PRICE_CONFIRMED','ORDER_INTENT_CREATED','DRY_RUN_READY')
        RETURNING id
      \`);
      return rowsOf(result).length === 1;
    } catch {
      return false;
    }
  }

  async markSubmissionUnknown(input: { id: string; nowMs: number }): Promise<boolean> {
    try {
      const result = await this.db.execute(sql\`
        UPDATE a2_execution_intents
        SET state='SUBMISSION_UNKNOWN', updated_at_ms=\${input.nowMs}, updated_at=now()
        WHERE id=\${input.id}
          AND state='DRY_RUN_READY'
        RETURNING id
      \`);
      return rowsOf(result).length === 1;
    } catch {
      return false;
    }
  }

  async adoptExchangeOrder(input: {
    id: string;
    orderId: string;
    state: "OPEN" | "PARTIALLY_FILLED" | "FILLED";
    nowMs: number;
  }): Promise<boolean> {
    try {
      const result = await this.db.execute(sql\`
        UPDATE a2_execution_intents
        SET state=\${input.state},
            kalshi_order_id=\${input.orderId},
            updated_at_ms=\${input.nowMs},
            updated_at=now()
        WHERE id=\${input.id}
          AND state IN ('SUBMISSION_UNKNOWN','OPEN','PARTIALLY_FILLED','FILLED')
        RETURNING id
      \`);
      return rowsOf(result).length === 1;
    } catch {
      return false;
    }
  }

  async settleAndRelease(input: {
    id: string;
    result: "yes" | "no";
    realizedPnlCents: number;
    nowMs: number;
  }): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql\`SELECT pg_advisory_xact_lock(\${A2_EXECUTION_ADVISORY_LOCK})\`);
        const found = await tx.execute(sql\`
          SELECT * FROM a2_execution_intents WHERE id=\${input.id} LIMIT 1
        \`);
        const intent = toIntent(rowsOf(found)[0]);
        if (!intent) return false;
        if (intent.state === "EXPOSURE_RELEASED") return true;

        await tx.execute(sql\`
          INSERT INTO a2_execution_settlements
            (id, intent_id, market_ticker, settlement_version, result, realized_pnl_cents, settled_at_ms)
          VALUES
            (\${"settlement:" + input.id}, \${input.id}, \${intent.marketTicker}, 1,
             \${input.result}, \${input.realizedPnlCents}, \${input.nowMs})
          ON CONFLICT (intent_id, settlement_version) DO NOTHING
        \`);

        const updated = await tx.execute(sql\`
          UPDATE a2_execution_intents
          SET state='EXPOSURE_RELEASED',
              settlement_result=\${input.result},
              realized_pnl_cents=\${input.realizedPnlCents},
              settled_at_ms=\${input.nowMs},
              updated_at_ms=\${input.nowMs},
              updated_at=now()
          WHERE id=\${input.id}
          RETURNING id
        \`);
        return rowsOf(updated).length === 1;
      });
    } catch {
      return false;
    }
  }

  async getIntentByClientOrderId(clientOrderId: string): Promise<A2ExecutionIntent | null> {
    try {
      const result = await this.db.execute(sql\`
        SELECT * FROM a2_execution_intents
        WHERE client_order_id=\${clientOrderId}
        LIMIT 1
      \`);
      return toIntent(rowsOf(result)[0]);
    } catch {
      return null;
    }
  }
}
