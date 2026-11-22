/**
 * Hands the selected customers from /recycle to the broadcast wizard.
 *
 * Nothing is sent from here: the wizard still plans the audience and
 * re-checks opt-out (resolveAudience / finalAudience). The rows travel as
 * the wizard's existing CSV audience (a phone, a name), so no audience
 * type was added. Session storage is per tab and dies with it; the
 * handoff also expires after an hour and is only read when the URL says
 * `?audience=recycle`.
 */
import type { AudienceConfig } from '@/hooks/use-broadcast-sending';

export const RECYCLE_HANDOFF_KEY = 'recycle.audience.v1';
export const RECYCLE_HANDOFF_QUERY = 'audience=recycle';
export const RECYCLE_HANDOFF_TTL_MS = 3_600_000;
export const RECYCLE_HANDOFF_MAX = 1000;

export interface RecycleHandoffContact {
  phone: string;
  name?: string | null;
}

interface StoredContact {
  phone: string;
  name?: string;
}

interface Stored {
  at: number;
  contacts: StoredContact[];
}

export function buildRecycleHandoff(
  contacts: RecycleHandoffContact[],
  now: number = Date.now()
): string {
  const seen = new Set<string>();
  const out: StoredContact[] = [];
  for (const c of contacts) {
    const phone = c.phone.trim();
    const key = phone.replace(/\D/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ phone, ...(c.name?.trim() ? { name: c.name.trim() } : {}) });
    if (out.length >= RECYCLE_HANDOFF_MAX) break;
  }
  const stored: Stored = { at: now, contacts: out };
  return JSON.stringify(stored);
}

function isStoredContact(c: unknown): c is StoredContact {
  if (!c || typeof c !== 'object') return false;
  const phone = (c as { phone?: unknown }).phone;
  return typeof phone === 'string' && phone.trim() !== '';
}

/** Parse defensively: anything unexpected or stale is "no handoff". */
export function parseRecycleHandoff(
  raw: string | null,
  now: number = Date.now()
): AudienceConfig | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const { at, contacts } = v as Partial<Stored>;
  if (
    typeof at !== 'number' ||
    now - at > RECYCLE_HANDOFF_TTL_MS ||
    at > now + 60_000
  ) {
    return null;
  }
  if (!Array.isArray(contacts)) return null;
  const rows = contacts
    .filter(isStoredContact)
    .slice(0, RECYCLE_HANDOFF_MAX)
    .map((c) => ({
      phone: c.phone,
      name: typeof c.name === 'string' ? c.name : undefined,
      values: (typeof c.name === 'string' ? { name: c.name } : {}) as Record<
        string,
        string
      >,
    }));
  if (rows.length === 0) return null;
  return { type: 'csv', csvContacts: rows, csvColumns: ['phone', 'name'] };
}

export function saveRecycleHandoff(contacts: RecycleHandoffContact[]): boolean {
  try {
    sessionStorage.setItem(RECYCLE_HANDOFF_KEY, buildRecycleHandoff(contacts));
    return true;
  } catch {
    return false;
  }
}

/**
 * The wizard's starting audience when it was opened from /recycle, else
 * null. Not removed on read (a dev double-render would lose it); the
 * next /recycle handoff overwrites it and it expires.
 */
export function readRecycleAudience(): AudienceConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!window.location.search.includes(RECYCLE_HANDOFF_QUERY)) return null;
    return parseRecycleHandoff(sessionStorage.getItem(RECYCLE_HANDOFF_KEY));
  } catch {
    return null;
  }
}
