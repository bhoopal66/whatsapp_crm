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

export const NOT_MIGRATED_MESSAGE =
  'Team activity needs database migration 068.';
