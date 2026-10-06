import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { activityCursor, parseActivityQuery } from '@/lib/typesafe/admin';
import type {
  TsActivityItem,
  TsActivityResponse,
  TsActivitySummary,
} from '@/lib/typesafe/admin-types';

/** ts_activity_summary (migration 064): numerics may arrive as strings. */
interface SummaryRow {
  decisions: number | string;
  interventions: number | string;
  triage_handoffs: number | string;
  opt_outs: number | string;
  replies_held: number | string;
  replies_blocked: number | string;
  passages_dropped: number | string;
  fallbacks: number | string;
  est_usd: number | string | null;
  p95_latency_ms: number | string | null;
  last_decision_at: string | null;
}

interface LogRow {
  id: string;
  created_at: string;
  check_name: TsActivityItem['check'];
  decision: string;
  reason_codes: string[] | null;
  acted: boolean;
  intervened: boolean;
  fallback_used: boolean;
  language: string | null;
  latency_ms: number | null;
  error_code: string | null;
  conversation_id: string | null;
  contact_id: string | null;
}

/**
 * GET /api/typesafe/activity?days=7&check=&acted=&limit=50&before=  (admin+)
 *
 * What the TypeSafe layer did for the account: a summary over the last
 * `days` (1–90) and one page of decisions, newest first. Reads the
 * decision log through the caller's RLS (admins see the account's log).
 * Customer text is never in the log, only a keyed hash of it.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const q = parseActivityQuery(new URL(request.url).searchParams);
    const since = new Date(Date.now() - q.days * 86_400_000).toISOString();

    let page = supabase
      .from('ts_decision_log')
      .select(
        'id, created_at, check_name, decision, reason_codes, acted, intervened, fallback_used, language, latency_ms, error_code, conversation_id, contact_id'
      )
      .eq('account_id', accountId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(q.limit + 1);
    if (q.check) page = page.eq('check_name', q.check);
    // ?acted=true: the decisions that changed something (the "Acted on"
    // tile); ?acted=false: everything else.
    if (q.acted !== null) page = page.eq('intervened', q.acted);
    // Keyset pagination on (created_at, id), newest first. The timestamp
    // is passed back exactly as stored: rounding it to milliseconds would
    // skip rows between the rounded and the real value.
    if (q.before)
      page = q.before.id
        ? page.or(
            `created_at.lt."${q.before.at}",and(created_at.eq."${q.before.at}",id.lt.${q.before.id})`
          )
        : page.lt('created_at', q.before.at);

    const [pageRes, summaryRes] = await Promise.all([
      page,
      // One statement over the whole window, whatever the page filters.
      supabase.rpc('ts_activity_summary', { p_since: since }).single(),
    ]);
    const failed = pageRes.error ?? summaryRes.error;
    if (failed) {
      console.error('[typesafe/activity GET] fetch error:', failed.message);
      return NextResponse.json(
        { error: 'Failed to load the AI safety activity' },
        { status: 500 }
      );
    }

    const rows = (pageRes.data ?? []) as LogRow[];
    const more = rows.length > q.limit;
    const pageRows = more ? rows.slice(0, q.limit) : rows;

    // Contact names through the caller's contacts RLS.
    const contactIds = [
      ...new Set(pageRows.map((r) => r.contact_id).filter(Boolean)),
    ] as string[];
    const names = new Map<string, string>();
    if (contactIds.length) {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .in('id', contactIds);
      for (const c of (contacts ?? []) as {
        id: string;
        name: string | null;
        phone: string | null;
      }[])
        names.set(c.id, c.name?.trim() || c.phone || '');
    }

    const sum = (summaryRes.data ?? {}) as Partial<SummaryRow>;
    const num = (v: unknown): number => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    const summary: TsActivitySummary = {
      days: q.days,
      decisions: num(sum.decisions),
      acted: num(sum.interventions),
      triageHandoffs: num(sum.triage_handoffs),
      optOuts: num(sum.opt_outs),
      repliesHeld: num(sum.replies_held),
      repliesBlocked: num(sum.replies_blocked),
      passagesDropped: num(sum.passages_dropped),
      fallbacks: num(sum.fallbacks),
      estUsd: num(sum.est_usd),
      p95LatencyMs:
        sum.p95_latency_ms === null || sum.p95_latency_ms === undefined
          ? null
          : Math.round(num(sum.p95_latency_ms)),
      lastDecisionAt: sum.last_decision_at ?? null,
    };

    const items: TsActivityItem[] = pageRows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      check: r.check_name,
      decision: r.decision,
      reasonCodes: r.reason_codes ?? [],
      acted: r.acted,
      intervened: r.intervened,
      fallbackUsed: r.fallback_used,
      language: r.language,
      latencyMs: r.latency_ms,
      errorCode: r.error_code,
      conversationId: r.conversation_id,
      contactId: r.contact_id,
      contactName: r.contact_id ? (names.get(r.contact_id) ?? null) : null,
    }));

    const body: TsActivityResponse = {
      summary,
      items,
      nextBefore: more ? activityCursor(pageRows[pageRows.length - 1]!) : null,
    };
    return NextResponse.json(body);
  } catch (err) {
    return toErrorResponse(err);
  }
}
