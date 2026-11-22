/**
 * Hand a set of contacts from another screen (Contacts bulk bar) to the
 * new-broadcast wizard.
 *
 * Sender: `writeAudienceHandoff(storage, contacts)`, then navigate to
 * `AUDIENCE_HANDOFF_URL` (`/broadcasts/new?audience=handoff`).
 *
 * Receiver (wizard): when `?audience=handoff` is present, call
 * `readAudienceHandoff(storage)` once and, if it returns rows, start the
 * audience as `{ type: 'csv', csvContacts: handoff.rows, csvColumns }`
 * (the rows are already `CsvContactRow`-shaped: `phone`, `name`,
 * `company`, `values`). It clears the entry by default, so a reload does
 * not re-apply a stale selection.
 *
 * sessionStorage on purpose: per tab, gone when the tab closes. Pure
 * apart from the injected `storage`; every storage call is guarded.
 */

export const AUDIENCE_HANDOFF_KEY = 'taamul.broadcast.audienceHandoff';
export const AUDIENCE_HANDOFF_URL = '/broadcasts/new?audience=handoff';
/** A handoff older than this is ignored (a forgotten tab). */
export const AUDIENCE_HANDOFF_MAX_AGE_MS = 60 * 60 * 1000;
/** Same ceiling as one page of bulk selection, with generous headroom. */
export const AUDIENCE_HANDOFF_MAX_ROWS = 1000;

/** The wizard's CSV row shape (see `CsvContactRow`). */
export interface HandoffRow {
  phone: string;
  name?: string;
  company?: string;
  values: Record<string, string>;
}

export interface AudienceHandoff {
  v: 1;
  /** Where it came from, for the wizard's banner. */
  source: string;
  createdAt: number;
  rows: HandoffRow[];
}

interface SourceContact {
  id?: string;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

/** Minimal storage surface, so tests need no DOM. */
export interface HandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Contacts → rows: those without a phone are dropped, numbers deduped. */
export function buildHandoffRows(
  contacts: readonly SourceContact[]
): HandoffRow[] {
  const seen = new Set<string>();
  const rows: HandoffRow[] = [];
  for (const c of contacts) {
    const phone = (c.phone ?? '').trim();
    const digits = phone.replace(/\D/g, '');
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    const values: Record<string, string> = { phone };
    if (c.name) values.name = c.name;
    if (c.email) values.email = c.email;
    if (c.company) values.company = c.company;
    rows.push({
      phone,
      name: c.name || undefined,
      company: c.company || undefined,
      values,
    });
    if (rows.length >= AUDIENCE_HANDOFF_MAX_ROWS) break;
  }
  return rows;
}

/** Store the handoff; false when storage is unavailable or nothing to send. */
export function writeAudienceHandoff(
  storage: HandoffStorage | null | undefined,
  contacts: readonly SourceContact[],
  source = 'contacts',
  now: number = Date.now()
): boolean {
  const rows = buildHandoffRows(contacts);
  if (!storage || rows.length === 0) return false;
  const payload: AudienceHandoff = { v: 1, source, createdAt: now, rows };
  try {
    storage.setItem(AUDIENCE_HANDOFF_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function isRow(value: unknown): value is HandoffRow {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.phone === 'string' &&
    r.phone.length > 0 &&
    (r.name === undefined || typeof r.name === 'string') &&
    (r.company === undefined || typeof r.company === 'string') &&
    !!r.values &&
    typeof r.values === 'object'
  );
}

/** Validate untrusted JSON; null for anything that is not a fresh handoff. */
export function parseAudienceHandoff(
  raw: string | null,
  now: number = Date.now()
): AudienceHandoff | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<AudienceHandoff> | null;
    if (!data || data.v !== 1 || !Array.isArray(data.rows)) return null;
    if (
      typeof data.createdAt !== 'number' ||
      now - data.createdAt > AUDIENCE_HANDOFF_MAX_AGE_MS ||
      data.createdAt > now + 60_000
    ) {
      return null;
    }
    const rows = data.rows.filter(isRow).slice(0, AUDIENCE_HANDOFF_MAX_ROWS);
    if (rows.length === 0) return null;
    return {
      v: 1,
      source: typeof data.source === 'string' ? data.source : 'contacts',
      createdAt: data.createdAt,
      rows,
    };
  } catch {
    return null;
  }
}

/** Read (and by default clear) the handoff; null when there is none. */
export function readAudienceHandoff(
  storage: HandoffStorage | null | undefined,
  options: { consume?: boolean; now?: number } = {}
): AudienceHandoff | null {
  if (!storage) return null;
  try {
    const parsed = parseAudienceHandoff(
      storage.getItem(AUDIENCE_HANDOFF_KEY),
      options.now
    );
    if (options.consume !== false) storage.removeItem(AUDIENCE_HANDOFF_KEY);
    return parsed;
  } catch {
    return null;
  }
}
