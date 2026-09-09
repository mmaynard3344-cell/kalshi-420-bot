import type { EthBigBetOrderIntent, EthBigBetStrategy } from "./ethBigBetLifecycle.js";

export type EthDownfadeRole = "downfade_e" | "downfade_f" | "downfade_g";
export type EthDownfadeBand = "p80_p99" | "p90_p99" | "probe_5m_30c";

export interface EthDownfadeEvidence {
  ticker: string;
  marketOpenTimeMs: number;
  currentMove: number | null;
  direction: "up" | "down" | "flat" | null;
  p80: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

export interface EthDownfadeConfig {
  role: EthDownfadeRole;
  strategy: EthBigBetStrategy;
  band: EthDownfadeBand;
  wagerCents: number;
  orderTag: string;
  lower: "p80" | "p90" | "p95";
  upper: "p99";
}

export const ETH_DOWNFADE_CONFIG: Record<EthDownfadeRole, EthDownfadeConfig> = {
  downfade_e: {
    role: "downfade_e",
    strategy: "downfade_p80_p90",
    band: "p80_p99",
    wagerCents: 5_000,
    orderTag: "eth-downfade-p80-p99-v2",
    lower: "p80",
    upper: "p99",
  },
  downfade_f: {
    role: "downfade_f",
    strategy: "downfade_p90_p95",
    band: "p90_p99",
    wagerCents: 10_000,
    orderTag: "eth-downfade-p90-p99-v2",
    lower: "p90",
    upper: "p99",
  },
  downfade_g: {
    role: "downfade_g",
    strategy: "probe_g",
    band: "probe_5m_30c",
    wagerCents: 500,
    orderTag: "eth-probe-g-5m-30c-v1",
    lower: "p95",
    upper: "p99",
  },
};

export function isEthDownfadeRole(role: string | null | undefined): role is EthDownfadeRole {
  return role === "downfade_e" || role === "downfade_f" || role === "downfade_g";
}

export function buildEthDownfadeIntent(
  role: EthDownfadeRole,
  evidence: EthDownfadeEvidence,
): EthBigBetOrderIntent | null {
  if (role === "downfade_g") return null;
  const config = ETH_DOWNFADE_CONFIG[role];
  if (!/^KXETH15M-/.test(evidence.ticker)
    || !Number.isInteger(evidence.marketOpenTimeMs)
    || evidence.direction !== "down") return null;

  const values = [evidence.currentMove, evidence.p80, evidence.p90, evidence.p95, evidence.p99];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;

  const lower = evidence[config.lower];
  const upper = evidence[config.upper];
  if (evidence.currentMove! < lower! || evidence.currentMove! >= upper!) return null;

  return {
    strategy: config.strategy,
    orderTag: config.orderTag,
    ticker: evidence.ticker,
    side: "yes",
    wagerCents: config.wagerCents,
    limitPriceCents: 50,
    marketOpenTimeMs: evidence.marketOpenTimeMs,
  };
}
