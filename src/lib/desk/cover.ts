/**
 * Desk cover (migration 232, design 035 revision A): a bank's primary
 * and second coordinator, leave, and who covers today (the primary, else
 * the second, else the lead: the desk duty owner, else the owner).
 * Types and a defensive parser for the cover list. Pure.
 */

export type CoverLevel = 'primary' | 'second' | 'lead';

export interface CoverHolder {
  userId: string;
  name: string;
  onLeave: boolean;
  leave: LeaveRange[];
}

/** One leave row (232): Asia/Dubai days, inclusive. */
export interface LeaveRange {
  id: string;
  firstDay: string;
  lastDay: string;
  note: string | null;
}

export interface BankCover {
  bankCode: string;
  bankName: string;
  primaryUser: string | null;
  secondUser: string | null;
  coverUser: string | null;
  coverLevel: CoverLevel;
  holders: CoverHolder[];
}

const s = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

export function parseCoverRow(r: Record<string, unknown>): BankCover {
  const holders = Array.isArray(r.holders) ? r.holders : [];
  return {
    bankCode: String(r.bank_code ?? ''),
    bankName: String(r.bank_name ?? ''),
    primaryUser: s(r.primary_user),
    secondUser: s(r.second_user),
    coverUser: s(r.cover_user),
    coverLevel: (['primary', 'second', 'lead'].includes(String(r.cover_level))
      ? r.cover_level
      : 'lead') as CoverLevel,
    holders: holders.flatMap((h) => {
      if (!h || typeof h !== 'object') return [];
      const o = h as Record<string, unknown>;
      if (!s(o.user_id)) return [];
      return [
        {
          userId: String(o.user_id),
          name: String(o.name ?? ''),
          onLeave: o.on_leave === true,
          leave: (Array.isArray(o.leave) ? o.leave : []).flatMap((l) => {
            const x = parseLeaveRow(l);
            return x ? [x] : [];
          }),
        },
      ];
    }),
  };
}

/** A leave row from SQL (`desk_cover_list`'s holders, `desk_my_leave`). */
export function parseLeaveRow(l: unknown): LeaveRange | null {
  const x = (l ?? {}) as Record<string, unknown>;
  return s(x.id)
    ? {
        id: String(x.id),
        firstDay: String(x.first_day ?? ''),
        lastDay: String(x.last_day ?? ''),
        note: s(x.note),
      }
    : null;
}

/** A YYYY-MM-DD date, or null. */
export function isoDay(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  // Round-trip: Date rolls 2026-02-30 over to March, and year 0000 is not
  // a date Postgres will take (it became a 500).
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v)
    return null;
  return Number(v.slice(0, 4)) >= 1 ? v : null;
}
