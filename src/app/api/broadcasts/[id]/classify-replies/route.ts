// ============================================================
// POST /api/broadcasts/[id]/classify-replies   (migration 148)
//
// Campaign reply sorting's backfill: classifies this broadcast's
// replied recipients that have no class yet — replies that came in
// before the switch was on, or whose inbound judgment ran out of time.
//
//   body { after?: string }   (optional; the previous call's nextCursor)
//   -> { classified: number, processed: number,
//        nextCursor: string | null, remaining: number }
//
// The reply judged is the contact's first customer message at or after
// the recipient's send time. Recipients are walked in id order after
// `after`: at most 500 per call, four at a time, inside a 25 s budget.
// Call again with `nextCursor` until it is null, however many a call
// classified: a reply that can never be sorted (a voice note, no local
// template) stays unclassified, and without the cursor the same oldest
// 500 of those would be picked on every call and block every later one.
// `classified` counts only classes actually written.
//
// Reads go through the caller's RLS client; the class is written by
// classifyCampaignReply on the service role (148's guard). Admin and
// up, like the broadcasts screens (their layout is AdminOnlyLayout).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  classifyCampaignReply,
  replyClassOn,
} from '@/lib/broadcasts/reply-class';
import { mapLimit } from '@/lib/typesafe/checks/common';

export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BACKFILL_MAX_PER_CALL = 500;
const CONCURRENCY = 4;
const BUDGET_MS = 25_000;
/** Per-judgment deadline; shortened to what is left of the budget. */
const JUDGMENT_DEADLINE_MS = 2500;
/** Below this much budget, no new judgment starts. */
const MIN_JUDGMENT_MS = 300;

interface RecipientRow {
  id: string;
  contact_id: string;
  sent_at: string | null;
  created_at: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const started = Date.now();
    const { id } = await params;
    if (!UUID.test(id))
      return NextResponse.json(
        { error: 'Invalid broadcast id' },
        { status: 400 }
      );

    const body = (await request.json().catch(() => null)) as {
      after?: unknown;
    } | null;
    const after = body?.after ?? null;
    if (after !== null && (typeof after !== 'string' || !UUID.test(after)))
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });

    const { data: broadcast, error: bErr } = await supabase
      .from('broadcasts')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!broadcast)
      return NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      );

    if (!(await replyClassOn(accountId)))
      return NextResponse.json(
        { error: 'Campaign reply sorting is off for this workspace.' },
        { status: 409 }
      );

    let rowsQuery = supabase
      .from('broadcast_recipients')
      .select('id, contact_id, sent_at, created_at')
      .eq('broadcast_id', id)
      .eq('status', 'replied')
      .is('reply_class', null);
    if (after) rowsQuery = rowsQuery.gt('id', after);
    const { data: rows, error: rErr } = await rowsQuery
      .order('id', { ascending: true })
      .limit(BACKFILL_MAX_PER_CALL);
    if (rErr) throw new Error(rErr.message);
    const recipients = (rows ?? []) as RecipientRow[];

    /** The contact's first customer message at or after `since`. */
    const firstReply = async (
      contactId: string,
      since: string
    ): Promise<{ text: string; tapped: boolean } | null> => {
      const { data: conv, error: cErr } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .limit(1)
        .maybeSingle();
      if (cErr) throw new Error(cErr.message);
      if (!conv) return null;
      const { data: msg, error: mErr } = await supabase
        .from('messages')
        .select('content_text, interactive_reply_id')
        .eq('conversation_id', (conv as { id: string }).id)
        .eq('sender_type', 'customer')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (mErr) throw new Error(mErr.message);
      const m = msg as {
        content_text: string | null;
        interactive_reply_id: string | null;
      } | null;
      const text = m?.content_text?.trim();
      return text ? { text, tapped: Boolean(m?.interactive_reply_id) } : null;
    };

    // Per row: 'classified', 'done' (looked at, nothing written: no
    // reply text, no template, Jev declined, or an error) or 'skipped'
    // (out of budget, so the cursor must not pass it).
    type Outcome = 'classified' | 'done' | 'skipped';
    const results = await mapLimit<RecipientRow, Outcome>(
      recipients,
      CONCURRENCY,
      async (r) => {
        const left = BUDGET_MS - (Date.now() - started);
        if (left < MIN_JUDGMENT_MS) return 'skipped';
        try {
          const reply = await firstReply(
            r.contact_id,
            r.sent_at ?? r.created_at
          );
          if (!reply) return 'done';
          const deadlineMs = Math.min(
            JUDGMENT_DEADLINE_MS,
            BUDGET_MS - (Date.now() - started)
          );
          if (deadlineMs < MIN_JUDGMENT_MS) return 'skipped';
          const cls = await classifyCampaignReply({
            accountId,
            recipientId: r.id,
            broadcastId: id,
            replyText: reply.text,
            tappedButton: reply.tapped ? reply.text : null,
            deadlineMs,
          });
          return cls !== null ? 'classified' : 'done';
        } catch (err) {
          console.error(
            '[reply-class] backfill item failed:',
            err instanceof Error ? err.message : String(err)
          );
          return 'done';
        }
      }
    );

    // The cursor advances over the leading run of rows looked at; a row
    // skipped for budget (and everything after it) is retried next call.
    let processed = 0;
    while (processed < results.length && results[processed] !== 'skipped')
      processed += 1;
    const nextCursor =
      processed < recipients.length
        ? (recipients[processed - 1]?.id ?? after)
        : recipients.length === BACKFILL_MAX_PER_CALL
          ? recipients[recipients.length - 1]!.id
          : null;

    const { count, error: nErr } = await supabase
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', id)
      .eq('status', 'replied')
      .is('reply_class', null);
    if (nErr) throw new Error(nErr.message);

    return NextResponse.json({
      classified: results.filter((o) => o === 'classified').length,
      processed,
      nextCursor,
      remaining: count ?? 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
