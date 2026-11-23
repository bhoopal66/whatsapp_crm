/**
 * Reads a settings screen's GET. Throws unless the answer is a success
 * that carries a `settings` object: a screen must never fall back to
 * default values it could then save over the real ones.
 */
export async function readSettings(
  url: string
): Promise<Record<string, unknown> & { settings: object }> {
  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as {
    settings?: unknown;
  } | null;
  if (!res.ok || !body?.settings || typeof body.settings !== 'object') {
    throw new Error(`settings read failed (${res.status})`);
  }
  return body as Record<string, unknown> & { settings: object };
}
