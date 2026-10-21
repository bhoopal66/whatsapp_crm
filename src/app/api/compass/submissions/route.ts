// ============================================================
// GET /api/compass/submissions — Integrations -> Compass, Submissions
// tab (admin+): the latest 100 submission groups with their case, and
// how many webhook outbox events (migration 134) were delivered or are
// still pending over the last 7 days. The outbox has no client policy
// (service role only), so every read is on supabaseAdmin() and filtered
// by the caller's active account here.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/submission-groups/server';

/** The events 134's triggers enqueue: change one, change both. */
const OUTBOX_EVENTS = [
  'case.stage_changed',
  'case.lead_created',
  'submission_group.ready',
  'submission_group.failed',
  'submission_group.ended',
  'contact.opted_out',
] as const;

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface GroupRow {
  id: string;
  submission_ref: string;
  status: string;
  created_at: string;
  ended_at: string | null;
  contact_id: string | null;
}
interface CaseRow {
  id: string;
  group_id: string;
  stage: string;
  bank_code: string | null;
  external_changed_at: string | null;
}

function failed(what: string, error: { message?: string }): never {
  throw new Error(`${what}: ${error.message ?? 'query failed'}`);
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const db = supabaseAdmin();
    const accountId = ctx.accountId;

    const groups = await db
      .from('submission_groups')
      .select('id, submission_ref, status, created_at, ended_at, contact_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (groups.error) failed('submission_groups', groups.error);
    const rows = (groups.data ?? []) as GroupRow[];
    const groupIds = rows.map((g) => g.id);
    const contactIds = [
      ...new Set(rows.map((g) => g.contact_id).filter((id) => id !== null)),
    ];

    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const outboxCount = (event: string, delivered: boolean) => {
      const q = db
        .from('webhook_event_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('event', event)
        .gte('created_at', since);
      return delivered
        ? q.not('delivered_at', 'is', null)
        : q.is('delivered_at', null);
    };

    const [cases, contacts, counts] = await Promise.all([
      groupIds.length
        ? db
            .from('cases')
            .select('id, group_id, stage, bank_code, external_changed_at')
            .eq('account_id', accountId)
            .in('group_id', groupIds)
        : { data: [], error: null },
      contactIds.length
        ? db
            .from('contacts')
            .select('id, name')
            .eq('account_id', accountId)
            .in('id', contactIds)
        : { data: [], error: null },
      Promise.all(
        OUTBOX_EVENTS.map(async (event) => {
          const [d, p] = await Promise.all([
            outboxCount(event, true),
            outboxCount(event, false),
          ]);
          if (d.error) failed('webhook_event_outbox', d.error);
          if (p.error) failed('webhook_event_outbox', p.error);
          return { event, delivered: d.count ?? 0, pending: p.count ?? 0 };
        })
      ),
    ]);
    if (cases.error) failed('cases', cases.error);
    if (contacts.error) failed('contacts', contacts.error);

    const caseByGroup = new Map(
      ((cases.data ?? []) as CaseRow[]).map((c) => [c.group_id, c])
    );
    const nameById = new Map(
      ((contacts.data ?? []) as { id: string; name: string | null }[]).map(
        (c) => [c.id, c.name]
      )
    );

    return NextResponse.json({
      submissions: rows.map((g) => {
        const c = caseByGroup.get(g.id) ?? null;
        return {
          submissionRef: g.submission_ref,
          status: g.status,
          createdAt: g.created_at,
          endedAt: g.ended_at,
          customer: g.contact_id ? (nameById.get(g.contact_id) ?? null) : null,
          caseId: c?.id ?? null,
          stage: c?.stage ?? null,
          bankCode: c?.bank_code ?? null,
          externalChangedAt: c?.external_changed_at ?? null,
        };
      }),
      webhooks: counts,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
