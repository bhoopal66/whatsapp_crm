/**
 * Server-side filters for Supabase Realtime `postgres_changes`.
 *
 * A subscription with no `filter` makes Realtime evaluate the table's
 * RLS policy for every subscriber on every row change, and ships every
 * change the policy lets through to every tab. A filter on a column the
 * policy already pins (the active account, the recipient) narrows that
 * to the rows the subscriber was going to receive anyway: RLS stays the
 * enforcement point, the filter only spares the work.
 *
 * DELETE is the exception, and why this returns one binding per event
 * rather than one `event: '*'` binding. Realtime cannot filter DELETEs:
 * with the default replica identity a DELETE carries only the primary
 * key, so a filter on any other column never matches and the delete is
 * silently dropped (a deleted chat would keep the unread dot lit, an
 * ended call would keep ringing). So INSERT and UPDATE are filtered and
 * DELETE stays unfiltered, exactly as it was delivered before.
 */

export type ScopedChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE';

export interface ScopedChangeBinding {
  event: ScopedChangeEvent;
  schema: 'public';
  table: string;
  filter?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `column=eq.value` filter, or null when `value` is not a UUID.
 * Every column filtered on is a uuid, and anything else (a `,` or `)`)
 * could rewrite the filter, so a non-UUID means "not known yet".
 */
export function eqUuidFilter(
  column: string,
  value: string | null | undefined
): string | null {
  if (!value || !UUID_RE.test(value)) return null;
  return `${column}=eq.${value}`;
}

/**
 * The bindings for `table` scoped to `column = value`: INSERT and
 * UPDATE filtered, DELETE unfiltered (see the module comment). Null
 * while `value` is unknown, and the caller must then not subscribe at
 * all rather than fall back to an unfiltered channel.
 */
export function scopedChangeBindings(
  table: string,
  column: string,
  value: string | null | undefined
): ScopedChangeBinding[] | null {
  const filter = eqUuidFilter(column, value);
  if (!filter) return null;
  return [
    { event: 'INSERT', schema: 'public', table, filter },
    { event: 'UPDATE', schema: 'public', table, filter },
    { event: 'DELETE', schema: 'public', table },
  ];
}
