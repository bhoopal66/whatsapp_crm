/**
 * Contacts list state in the URL (`?sort=name&dir=asc`). Pure string
 * helpers; the page calls `history.replaceState` with the result so a
 * reload or a shared link keeps the view without a Next navigation.
 */

/** `search` with `updates` applied: null/'' removes a key. Order kept. */
export function withParams(
  search: string,
  updates: Record<string, string | null | undefined>
): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
