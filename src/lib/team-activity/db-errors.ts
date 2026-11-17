// ============================================================
// Postgres / PostgREST errors the Team activity routes answer
// specially. Kept out of the route files, which may export only
// handlers.
// ============================================================

/** PostgREST "no such function" / Postgres "undefined function". */
export function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883';
}

/** PostgREST "no such table" / Postgres "undefined table". */
export function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}

export const UNLOCKS_UNAVAILABLE_MESSAGE =
  'Unlock requests are not available yet';

/** Any of the "table or function is not there" codes. */
export function isMissingObject(error: { code?: string } | null): boolean {
  return isMissingTable(error) || isMissingFunction(error);
}

export const NOT_MIGRATED_MESSAGE =
  'Team activity needs database migration 068.';

/** Why an agent's or leader's view of the report is switched off (205). */
export const VIEW_OFF_HINTS = ['agent_view_off', 'leader_view_off'] as const;
export type ViewOffHint = (typeof VIEW_OFF_HINTS)[number];

/** The view-off hint of a PostgREST error, else null. */
export function viewOffHint(error: unknown): ViewOffHint | null {
  const hint =
    error && typeof error === 'object' && 'hint' in error
      ? (error as { hint: unknown }).hint
      : null;
  return (VIEW_OFF_HINTS as readonly unknown[]).includes(hint)
    ? (hint as ViewOffHint)
    : null;
}
