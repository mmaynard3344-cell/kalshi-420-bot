/** Pure Eastern calendar helpers for the Saturday investor report. */
const ET = "America/New_York";

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** UTC milliseconds for midnight on a named America/New_York calendar date. */
export function easternMidnightMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const naiveUtc = Date.UTC(year!, month! - 1, day!);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(naiveUtc));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const localAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24);
  return naiveUtc - (localAsUtc - naiveUtc);
}

/** Completed Saturday-to-Saturday Eastern calendar week. */
export function completedEasternWeek(now = new Date()): { weekStart: string; weekEndExclusive: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  const currentDate = `${part("year")}-${part("month")}-${part("day")}`;
  const weekEndExclusive = addDays(currentDate, -((weekday + 1) % 7));
  return { weekStart: addDays(weekEndExclusive, -7), weekEndExclusive };
}

export function weekStartForEnd(weekEndExclusive: string): string {
  return addDays(weekEndExclusive, -7);
}