const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * Apply the approved 1.5x wager multiplier only from 06:00:00 through
 * 11:59:59 America/New_York. Signals and all other order semantics are unchanged.
 */
export function applyEthMorningWagerMultiplier(baseCents: number, atMs = Date.now()): number {
  if (!Number.isFinite(baseCents) || baseCents < 0) return baseCents;
  const hourPart = ET_HOUR.formatToParts(new Date(atMs)).find((part) => part.type === "hour")?.value;
  const hour = Number(hourPart);
  return Number.isInteger(hour) && hour >= 6 && hour < 12
    ? Math.round(baseCents * 1.5)
    : baseCents;
}
