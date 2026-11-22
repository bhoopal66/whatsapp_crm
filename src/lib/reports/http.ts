// ============================================================
// Shared by the report routes (route files may export only handlers):
// the period and time zone, and the SQL refusals they answer.
// ============================================================

import { NextResponse } from 'next/server';

import { isMissingFunction } from '@/lib/team-activity/db-errors';
import { isValidTimeZone, limitsFromRow } from '@/lib/team-activity/limits';
import {
  isRangePreset,
  rangeFor,
  type RangePreset,
} from '@/lib/team-activity/range';

export const TAG_REPORT_NOT_MIGRATED =
  'The chat tag report needs database migration 255.';

/** HINTs migration 255's functions raise. */
export const REPORT_HINTS = [
  'NOT_ALLOWED',
  'BAD_RANGE',
  'BAD_REPORT',
  'BAD_USERS',
] as const;
export type ReportHint = (typeof REPORT_HINTS)[number];

/** The 255 hint of a PostgREST error, else null. */
export function reportHint(error: unknown): ReportHint | null {
  const hint =
    error && typeof error === 'object' && 'hint' in error
      ? (error as { hint: unknown }).hint
      : null;
  return (REPORT_HINTS as readonly unknown[]).includes(hint)
    ? (hint as ReportHint)
    : null;
}

export const notMigrated = () =>
  NextResponse.json({ error: TAG_REPORT_NOT_MIGRATED }, { status: 503 });

/** The answer for a failed 255 call: 503, 403, 400 or 500. */
export function reportErrorResponse(
  error: { code?: string; message?: string } | null,
  what: string
): NextResponse {
  if (isMissingFunction(error)) return notMigrated();
  switch (reportHint(error)) {
    case 'NOT_ALLOWED':
      return NextResponse.json(
        { error: 'You do not have access to this report', code: 'not_allowed' },
        { status: 403 }
      );
    case 'BAD_RANGE':
      return NextResponse.json(
        { error: 'The period is not valid', code: 'bad_range' },
        { status: 400 }
      );
    case 'BAD_REPORT':
      return NextResponse.json(
        { error: 'Unknown report', code: 'bad_report' },
        { status: 400 }
      );
    case 'BAD_USERS':
      return NextResponse.json(
        {
          error: 'Someone in the list is not live staff of this workspace',
          code: 'bad_users',
        },
        { status: 400 }
      );
    case null:
      break;
  }
  console.error(`[reports] ${what} failed:`, error?.message);
  return NextResponse.json({ error: `Failed to ${what}` }, { status: 500 });
}

interface RpcClient {
  rpc: (
    fn: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export interface ReportPeriod {
  preset: RangePreset;
  tz: string;
  from: Date;
  to: Date;
}

/**
 * The period of `?range=&tz=`, computed exactly as Team activity does:
 * the account's saved zone (`team_activity_limits`), else the viewer's,
 * else UTC; presets from `lib/team-activity/range.ts`. Answers a
 * Response when the request or the zone lookup fails.
 */
export async function resolveReportPeriod(
  supabase: RpcClient,
  accountId: string,
  params: URLSearchParams
): Promise<ReportPeriod | NextResponse> {
  const preset = params.get('range') ?? '30d';
  if (!isRangePreset(preset)) {
    return NextResponse.json({ error: 'Unknown range' }, { status: 400 });
  }
  const viewerZone = params.get('tz');

  const { data: limitRows, error: limitsError } = await supabase.rpc(
    'team_activity_limits',
    { p_account: accountId }
  );
  if (limitsError) {
    if (isMissingFunction(limitsError)) {
      return NextResponse.json(
        { error: 'The report needs database migration 068.' },
        { status: 503 }
      );
    }
    console.error('[reports] limits failed:', limitsError.message);
    return NextResponse.json(
      { error: 'Failed to load the report' },
      { status: 500 }
    );
  }
  const saved = limitsFromRow(
    Array.isArray(limitRows) ? (limitRows[0] as Record<string, unknown>) : null
  );
  const tz =
    saved.timezone ??
    (viewerZone && isValidTimeZone(viewerZone) ? viewerZone : 'UTC');

  const range = rangeFor(preset, new Date(), tz);
  // A request landing on the very millisecond of midnight.
  if (range.to.getTime() <= range.from.getTime()) {
    range.to = new Date(range.from.getTime() + 1000);
  }
  return { preset, tz, from: range.from, to: range.to };
}
