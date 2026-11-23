/**
 * The day a document's expiry is counted from, and the day a file is dated
 * with: Dubai's (UTC+4 all year). Counted in UTC, a document that expired
 * yesterday still passed between midnight and 04:00, and files were dated
 * the day before.
 */
export function dubaiDay(now: Date): string {
  return new Date(now.getTime() + 4 * 60 * 60_000).toISOString().slice(0, 10);
}
