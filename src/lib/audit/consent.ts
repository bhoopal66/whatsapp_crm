/**
 * Settings → Consent and retention: the per-bank guest and recording
 * policy (migration 088's bank_guest_policies). RLS lets members read
 * and admins write, and a CHECK refuses guests without a DSA date; these
 * keep the form's requests inside those rules before it asks.
 */

/** bank_code's CHECK wants it non-empty, trimmed and upper case. */
export function normaliseBankCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code) ? code : null;
}

/** bank_guest_policies.note is at most 2,000 characters. */
export const NOTE_MAX = 2000;

export type GuestsOnError = 'dateRequired' | 'dateInFuture' | 'noteTooLong';

/**
 * The update that turns a bank's guests on: the date its DSA terms were
 * checked (required, not after `today`), who checked them, and a note.
 * The date is stored at 12:00 UTC so it reads as the same calendar day
 * in every time zone from UTC-11 to UTC+11.
 */
export function guestsOnPatch(input: {
  checkedOn: string;
  note: string;
  userId: string;
  today: string;
}):
  | {
      ok: true;
      patch: {
        guests_allowed: true;
        dsa_checked_at: string;
        dsa_checked_by: string;
        note: string | null;
      };
    }
  | { ok: false; error: GuestsOnError } {
  const day = input.checkedOn.trim();
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(`${day}T12:00:00Z`)) &&
    new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;
  if (!valid) return { ok: false, error: 'dateRequired' };
  if (day > input.today) return { ok: false, error: 'dateInFuture' };
  const note = input.note.trim();
  if ([...note].length > NOTE_MAX) return { ok: false, error: 'noteTooLong' };
  return {
    ok: true,
    patch: {
      guests_allowed: true,
      dsa_checked_at: `${day}T12:00:00.000Z`,
      dsa_checked_by: input.userId,
      note: note || null,
    },
  };
}

/** A date as the `YYYY-MM-DD` of the viewer's own calendar. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The audit filter's day range as instants: `from` at the start of its
 * local day, `to` at the start of the day after (exclusive), so a
 * one-day range covers that whole day.
 */
export function dayRange(
  from: string,
  to: string
): { from: string | null; to: string | null } {
  const start = (day: string, plusDays = 0) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const [y, m, d] = day.split('-').map(Number);
    const at = new Date(y, m - 1, d + plusDays);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  };
  return { from: start(from), to: start(to, 1) };
}
