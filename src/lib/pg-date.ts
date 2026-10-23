/**
 * Whether a parsed date is one Postgres `timestamptz` accepts.
 * `Date.parse` takes extended years (`+010000-01-01`, `-000001-…`) and
 * `toISOString()` writes them back in that form, which Postgres refuses
 * ("time zone displacement out of range"): unchecked, such a date reached
 * the query and the route answered 500 instead of 400.
 */
export function inPostgresRange(d: Date): boolean {
  const y = d.getUTCFullYear();
  return !Number.isNaN(d.getTime()) && y >= 1 && y <= 9999;
}
