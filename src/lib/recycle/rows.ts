import {
  RECYCLE_CASE_OUTCOMES,
  RECYCLE_DEFAULT_DAYS,
  RECYCLE_MAX_DAYS,
  RECYCLE_MIN_DAYS,
  type RecycleCaseOutcome,
  type RecycleRow,
  type RecycleRpcRow,
  type RecycleSettings,
} from './types';

const DAY_MS = 86_400_000;

export function mapRecycleRow(r: RecycleRpcRow): RecycleRow {
  return {
    contactId: r.contact_id,
    name: r.name?.trim() ? r.name.trim() : null,
    phone: r.phone ?? '',
    ownerId: r.owner_id,
    ownerName: r.owner_name?.trim() ? r.owner_name.trim() : null,
    source: r.source === 'chat' ? 'chat' : 'case',
    caseId: r.case_id,
    conversationId: r.conversation_id,
    bankCode: r.bank_code,
    outcome: r.outcome,
    reasonCode: r.reason_code,
    chatTagName: r.chat_tag_name,
    endedAt: r.ended_at,
    total: Number(r.total_count ?? 0) || 0,
  };
}

/** Whole days between the ending and now; never negative. */
export function daysSince(endedAt: string, now: Date = new Date()): number {
  const t = Date.parse(endedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** A readable international number: "+971 50 123 4567" style grouping. */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return phone.trim();
  if (digits.startsWith('971') && digits.length === 12) {
    return `+971 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 9) : '';
  const rest = digits.slice(cc.length);
  const grouped = rest.replace(/(\d{3})(?=\d)/g, '$1 ');
  return `+${cc ? `${cc} ` : ''}${grouped}`.trim();
}

/**
 * Message key (under Recycle.why) saying why a row is listed: the case's
 * outcome, or a declined-type chat tag.
 */
export function whyKey(
  row: Pick<RecycleRow, 'source' | 'outcome'>
): 'caseDeclined' | 'caseWithdrawn' | 'chatTag' {
  if (row.source === 'chat') return 'chatTag';
  return row.outcome === 'Withdrawn' ? 'caseWithdrawn' : 'caseDeclined';
}

/** Clamp a typed number of days into the allowed range. */
export function clampDays(
  value: unknown,
  fallback: number = RECYCLE_DEFAULT_DAYS
): number {
  const n =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(RECYCLE_MAX_DAYS, Math.max(RECYCLE_MIN_DAYS, Math.trunc(n)));
}

/** A recycle_settings row (or none) as the settings card uses it. */
export function settingsFromRow(
  row: {
    days?: number | null;
    chat_tag_ids?: string[] | null;
    case_outcomes?: string[] | null;
  } | null
): RecycleSettings {
  if (!row) {
    return {
      days: RECYCLE_DEFAULT_DAYS,
      chatTagIds: [],
      caseOutcomes: [...RECYCLE_CASE_OUTCOMES],
    };
  }
  const outcomes = (row.case_outcomes ?? []).filter(
    (o): o is RecycleCaseOutcome =>
      (RECYCLE_CASE_OUTCOMES as readonly string[]).includes(o)
  );
  return {
    days: clampDays(row.days),
    chatTagIds: row.chat_tag_ids ?? [],
    caseOutcomes: outcomes,
  };
}

/**
 * The reference recycle_create_tasks files under (migration 251):
 * `recycle:<contact>:<YYYY-MM-DD>` with the ending's UTC date, so a rerun
 * adds nothing.
 */
export function recycleTaskRef(contactId: string, endedAt: string): string {
  const d = new Date(endedAt);
  const day = Number.isNaN(d.getTime())
    ? endedAt.slice(0, 10)
    : d.toISOString().slice(0, 10);
  return `recycle:${contactId}:${day}`;
}
