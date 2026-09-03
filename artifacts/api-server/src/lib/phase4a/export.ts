import type { ReplayResult } from "./types.js";

/** Stable machine-readable replay result; no live data, clocks, or random identifiers. */
export function replayResultToJson(result: ReplayResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function replaySummaryToText(result: ReplayResult): string {
  const { summary } = result;
  return [
    `Experiment: ${result.experiment.id}`,
    `Accepted: ${summary.accepted}/${summary.totalCaptures} (deduped ${summary.deduped}, rejected ${summary.rejected})`,
    `Resolved: ${summary.resolved}; unresolved: ${summary.unresolved}; wins/losses: ${summary.wins}/${summary.losses}`,
    `Entry cost: $${summary.entryCostDollars.toFixed(2)}; fees: $${summary.feeDollars.toFixed(2)}; net P&L: $${summary.netPnlDollars.toFixed(2)}`,
    `Net ROI: ${summary.roi == null ? "unresolved" : `${(summary.roi * 100).toFixed(2)}%`}`,
  ].join("\n");
}