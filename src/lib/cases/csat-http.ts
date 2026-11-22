/**
 * The case CSAT routes (migration 246): body and row parsing, and
 * refusals as `{ error, code }`. Anything else is a 500 logged by
 * function and SQLSTATE only, never a message (it may carry customer
 * data).
 */
import { NextResponse } from 'next/server';

import { caseErrorResponse } from './http';
import { CSAT_DEFAULTS, type CsatSettings, type CsatTrigger } from './csat';

const REFUSALS: Readonly<Record<string, { status: number; text: string }>> = {
  NOT_ALLOWED: { status: 403, text: 'Not allowed' },
  INVALID: { status: 422, text: 'That setting is not valid' },
  STALE: {
    status: 409,
    text: 'Someone else changed these settings. Reload and try again.',
  },
};

export class CsatRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Throws CsatRefused for a known hint, else a plain error. */
export function check(
  fn: string,
  error: { code?: string; hint?: string | null } | null
): void {
  if (!error) return;
  if (typeof error.hint === 'string' && error.hint in REFUSALS)
    throw new CsatRefused(error.hint);
  throw Object.assign(new Error(`${fn} failed`), {
    sqlstate: error.code ?? null,
    fn,
  });
}

export function csatErrorResponse(err: unknown, label: string): NextResponse {
  if (err instanceof CsatRefused) {
    const r = REFUSALS[err.code]!;
    return NextResponse.json(
      { error: r.text, code: err.code },
      { status: r.status }
    );
  }
  const e = err as { fn?: string; sqlstate?: string | null };
  if (e?.fn) {
    console.error(
      `[case-csat] ${label}: ${e.fn} failed (${e.sqlstate ?? '-'})`
    );
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
  return caseErrorResponse(err, label);
}

/** case_csat_settings_get's one row, defaults where missing. */
export function settingsFromRow(data: unknown): CsatSettings {
  const r = (Array.isArray(data) ? data[0] : null) as Record<
    string,
    unknown
  > | null;
  const int = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isInteger(v) ? v : d;
  return {
    enabled: r?.enabled === true,
    askOnSubmitted: r?.ask_on_submitted !== false,
    askOnApproved: r?.ask_on_approved !== false,
    templateSubmitted:
      typeof r?.template_submitted === 'string'
        ? r.template_submitted
        : CSAT_DEFAULTS.templateSubmitted,
    templateApproved:
      typeof r?.template_approved === 'string'
        ? r.template_approved
        : CSAT_DEFAULTS.templateApproved,
    language:
      typeof r?.language === 'string' ? r.language : CSAT_DEFAULTS.language,
    replyWindowDays: int(r?.reply_window_days, CSAT_DEFAULTS.replyWindowDays),
    sendStartHour: int(r?.send_start_hour, CSAT_DEFAULTS.sendStartHour),
    sendEndHour: int(r?.send_end_hour, CSAT_DEFAULTS.sendEndHour),
    updatedAt: typeof r?.updated_at === 'string' ? r.updated_at : null,
  };
}

/**
 * A PUT body as case_csat_settings_set's arguments; INVALID when a field
 * is missing or out of range (the SQL checks again).
 */
export function settingsArgs(
  body: unknown
): Omit<CsatSettings, 'updatedAt'> & { expectedUpdatedAt: string | null } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<
    string,
    unknown
  >;
  const bool = (v: unknown) => {
    if (typeof v !== 'boolean') throw new CsatRefused('INVALID');
    return v;
  };
  const int = (v: unknown, lo: number, hi: number) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi)
      throw new CsatRefused('INVALID');
    return v;
  };
  const template = (v: unknown) => {
    const name = typeof v === 'string' ? v.trim() : '';
    if (!/^[a-z0-9_]{1,100}$/.test(name)) throw new CsatRefused('INVALID');
    return name;
  };
  const templateSubmitted = template(b.templateSubmitted);
  const templateApproved = template(b.templateApproved);
  const language = typeof b.language === 'string' ? b.language.trim() : '';
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language))
    throw new CsatRefused('INVALID');
  const sendStartHour = int(b.sendStartHour, 8, 20);
  const sendEndHour = int(b.sendEndHour, 9, 21);
  if (sendStartHour >= sendEndHour) throw new CsatRefused('INVALID');
  const expected = b.expectedUpdatedAt;
  if (
    expected !== null &&
    (typeof expected !== 'string' || Number.isNaN(Date.parse(expected)))
  )
    throw new CsatRefused('INVALID');
  return {
    enabled: bool(b.enabled),
    askOnSubmitted: bool(b.askOnSubmitted),
    askOnApproved: bool(b.askOnApproved),
    templateSubmitted,
    templateApproved,
    language,
    replyWindowDays: int(b.replyWindowDays, 1, 30),
    sendStartHour,
    sendEndHour,
    expectedUpdatedAt: expected,
  };
}

export interface CaseCsatItem {
  trigger: CsatTrigger;
  /** What the request is waiting on, for the case page's word. */
  state: 'waiting' | 'asked' | 'rated' | 'not_sent';
  score: number | null;
  comment: string | null;
  askedAt: string | null;
  respondedAt: string | null;
}

/** case_csat_for_case's rows as the case page shows them. */
export function caseCsatItems(data: unknown): CaseCsatItem[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw): CaseCsatItem[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    if (r.trigger !== 'submitted' && r.trigger !== 'approved') return [];
    const score = typeof r.score === 'number' ? r.score : null;
    const status = typeof r.status === 'string' ? r.status : '';
    const state: CaseCsatItem['state'] =
      score !== null
        ? 'rated'
        : status === 'sent' || status === 'unconfirmed'
          ? 'asked'
          : status === 'queued' || status === 'held' || status === 'sending'
            ? 'waiting'
            : 'not_sent';
    return [
      {
        trigger: r.trigger,
        state,
        score,
        comment: typeof r.comment === 'string' ? r.comment : null,
        askedAt: typeof r.sent_at === 'string' ? r.sent_at : null,
        respondedAt: typeof r.responded_at === 'string' ? r.responded_at : null,
      },
    ];
  });
}

/** The averages' look-back, days (default 90, 1-365). */
export function sinceDays(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 90;
}
