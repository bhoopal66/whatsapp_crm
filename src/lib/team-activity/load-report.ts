// ============================================================
// Load the Team activity report for a request: parse the query, pick
// the zone (the account's saved one, else the viewer's), compute the
// range there and call `team_activity_report`. Shared by
// GET /api/team-activity and its owner-only CSV export, so both read
// exactly the same figures for the same range.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  NOT_MIGRATED_MESSAGE,
  isMissingFunction,
  viewOffHint,
  type ViewOffHint,
} from './db-errors';
import { isValidTimeZone, limitsFromRow } from './limits';
import { isRangePreset, rangeFor, type RangePreset } from './range';
import { parseTeamActivityReport, type TeamActivityReport } from './report';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportQuery {
  preset: RangePreset;
  /** A whatsapp_config id, or null for every number. */
  channel: string | null;
  /** The browser's zone, used until an admin saves one. */
  viewerZone: string | null;
}

export type ParsedReportQuery =
  | { ok: true; query: ReportQuery }
  | { ok: false; error: 'Unknown range' | 'Unknown number' };

/** `range` (default 7d), `channel` (a uuid) and `tz` from the URL. */
export function parseReportQuery(params: URLSearchParams): ParsedReportQuery {
  const preset = params.get('range') ?? '7d';
  if (!isRangePreset(preset)) return { ok: false, error: 'Unknown range' };
  const channel = params.get('channel') || null;
  if (channel && !UUID_RE.test(channel)) {
    return { ok: false, error: 'Unknown number' };
  }
  return {
    ok: true,
    query: { preset, channel, viewerZone: params.get('tz') },
  };
}

export interface ReportRange {
  preset: RangePreset;
  from: string;
  to: string;
}

export type LoadedReport =
  | { kind: 'ok'; report: TeamActivityReport; range: ReportRange }
  /** Migration 068 is not applied. */
  | { kind: 'not_migrated' }
  /** The SQL refused: this view is switched off for the caller. */
  | { kind: 'view_off'; hint: ViewOffHint }
  | { kind: 'failed' };

/**
 * The report for `query`, under the caller's RLS client (the SQL
 * decides the scope). The range is computed in the account's zone once
 * an admin has saved one, else the viewer's, else UTC.
 */
export async function loadTeamActivityReport(
  supabase: SupabaseClient,
  accountId: string,
  query: ReportQuery,
  now: Date = new Date()
): Promise<LoadedReport> {
  const { data: limitRows, error: limitsError } = await supabase.rpc(
    'team_activity_limits',
    { p_account: accountId }
  );
  if (limitsError) {
    if (isMissingFunction(limitsError)) return { kind: 'not_migrated' };
    console.error('[team-activity] limits failed:', limitsError.message);
    return { kind: 'failed' };
  }
  const saved = limitsFromRow(
    Array.isArray(limitRows) ? (limitRows[0] as Record<string, unknown>) : null
  );
  const zone = query.viewerZone;
  const tz = saved.timezone ?? (zone && isValidTimeZone(zone) ? zone : 'UTC');

  const range = rangeFor(query.preset, now, tz);
  // A request landing on the very millisecond of midnight.
  if (range.to.getTime() <= range.from.getTime()) {
    range.to = new Date(range.from.getTime() + 1000);
  }

  const { data, error } = await supabase.rpc('team_activity_report', {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_tz: tz,
    p_channel_id: query.channel,
  });
  if (error) {
    if (isMissingFunction(error)) return { kind: 'not_migrated' };
    const off = viewOffHint(error);
    if (off) return { kind: 'view_off', hint: off };
    console.error('[team-activity] report failed:', error.message);
    return { kind: 'failed' };
  }

  return {
    kind: 'ok',
    report: parseTeamActivityReport(data),
    range: {
      preset: query.preset,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    },
  };
}

/** The HTTP answer for a report that did not load. */
export function reportFailureResponse(
  result: Exclude<LoadedReport, { kind: 'ok' }>
): NextResponse {
  switch (result.kind) {
    case 'not_migrated':
      return NextResponse.json(
        { error: NOT_MIGRATED_MESSAGE },
        { status: 503 }
      );
    case 'view_off':
      return NextResponse.json(
        { error: 'This view is switched off', code: result.hint },
        { status: 403 }
      );
    case 'failed':
      return NextResponse.json(
        { error: 'Failed to load team activity' },
        { status: 500 }
      );
  }
}
