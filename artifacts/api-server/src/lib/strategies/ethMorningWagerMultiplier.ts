const ET_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
export function applyEthMorningWagerMultiplier(baseCents: number, atMs = Date.now()): number {
  if (!Number.isFinite(baseCents) || baseCents < 0) return baseCents;
  const hour = Number(ET_HOUR.formatToParts(new Date(atMs)).find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) && hour >= 6 && hour < 12 ? Math.round(baseCents * 1.5) : baseCents;
}
