// ============================================================
// GET /api/pbx/calls — a call list (module 015, migration 089).
//   ?contactId=&userId=&scope=mine|my_missed|missed|all|unrouted&from=&to=&limit=
//   → { calls: [{ id, direction, status, startedAt, answeredAt, endedAt,
//       ringSeconds, talkSeconds, remoteNumber, didNumber, extension,
//       contactId, contactName, doNotContactAt, doNotContactReason,
//       userId, userName, rangNames, disposition, notes, recordingState,
//       recordingDeleted, legalHold }],
//       numbers?: [{ didNumber, calls, lastAt }] }
// didNumber: the number the customer dialled (calls.did_number).
// unrouted (owner/admin only, canListCallScope; 403 below): inbound
// calls to a dialled number with no route, which the PBX processor
// files under the connection's own workspace with calls.meta.unrouted
// set. The flag is filtered in the query, so the limit counts those
// calls only. `numbers` sums up every such call within the filters,
// not only the listed page (paged past PostgREST's max-rows when the
// list is cut short, up to SUMMARY_MAX_PAGES pages): which numbers
// want a route, the most recently called first. With no `from` it
// reaches back UNROUTED_SUMMARY_DAYS days; the listed page has no such
// bound. An erased call keeps the flag and its dialled number but no
// caller number.
// rangNames: who an inbound call rang, first rung first
// (calls.meta.rang_user_ids, kept by the PBX processor), named as in
// the caller's workspace: one person holds a profile per workspace.
// recordingDeleted: the stored audio was deleted under the retention
// period (the recording row's erased_at, migration 093); legalHold: an
// admin's legal hold keeps it.
//
// Read on the caller's client, so every row is one pbx_can_view_call
// shows them, notes included; a contact's name and do-not-contact
// stamp and reason (086) only when they can see the contact too, so
// the Calls screen disables Call back for that customer. The dial route
// still decides: it checks the number across the workspace, which this
// list does not. mine (the default): calls they were a party to or
// that rang their phone (myCallsFilter); missed: inbound calls nobody
// answered (as the month summary counts them); my_missed: both; all:
// every call RLS shows them (a leader's teams, an admin's workspace).
// userId: only the calls that person took or placed (calls.user_id),
// narrowing whatever the scope and RLS show (the Call report page's
// drill-down). Newest first; from/to bound started_at (from inclusive).
// Viewer+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { UNROUTED_SUMMARY_DAYS } from '@/lib/pbx/call-ui';
import {
  MISSED_STATUSES,
  canListCallScope,
  fail,
  myCallsFilter,
  parseCallListQuery,
  unroutedNumbers,
  type UnroutedNumber,
} from '@/lib/pbx/calls';

/** PostgREST's default max-rows, so a page shorter than this is the last. */
const PAGE = 1000;
/** A hard stop on the unrouted numbers' reads: PAGE calls each. */
const SUMMARY_MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ContactRow {
  id: string;
  name: string | null;
  do_not_contact_at: string | null;
  do_not_contact_reason: string | null;
}

interface CallRow {
  id: string;
  direction: string;
  status: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  ring_seconds: number | null;
  talk_seconds: number | null;
  remote_number: string | null;
  did_number: string | null;
  extension: string | null;
  contact_id: string | null;
  user_id: string | null;
  disposition: string | null;
  notes: string | null;
  recording_state: string;
  meta: Record<string, unknown> | null;
}

const rangIds = (meta: CallRow['meta']): string[] =>
  Array.isArray(meta?.rang_user_ids)
    ? meta.rang_user_ids.filter((u): u is string => typeof u === 'string')
    : [];

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const q = parseCallListQuery(new URL(request.url).searchParams);
    if (typeof q === 'string') return fail(q);
    if (!canListCallScope(ctx.role, q.scope))
      return fail('Only an owner or admin can list unrouted calls', 403);

    // The list and the unrouted numbers read the same calls.
    const scoped = (columns: string, from = q.from) => {
      let query = ctx.supabase
        .from('calls')
        .select(columns)
        .eq('account_id', ctx.accountId);
      if (q.contactId) query = query.eq('contact_id', q.contactId);
      if (q.userId) query = query.eq('user_id', q.userId);
      if (q.scope === 'mine' || q.scope === 'my_missed')
        query = query.or(myCallsFilter(ctx.userId));
      if (q.scope === 'missed' || q.scope === 'my_missed')
        query = query
          .eq('direction', 'inbound')
          .in('status', [...MISSED_STATUSES])
          .is('answered_at', null);
      if (q.scope === 'unrouted') query = query.eq('meta->>unrouted', 'true');
      if (from) query = query.gte('started_at', from);
      if (q.to) query = query.lt('started_at', q.to);
      return query;
    };
    const { data, error } = await scoped(
      'id, direction, status, started_at, answered_at, ended_at, ring_seconds, talk_seconds, remote_number, did_number, extension, contact_id, user_id, disposition, notes, recording_state, meta'
    )
      .order('started_at', { ascending: false })
      .limit(q.limit);
    if (error) throw new Error(`calls read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as CallRow[];

    let numbers: UnroutedNumber[] | undefined;
    if (q.scope === 'unrouted') {
      // The numbers start at the request's `from`, else
      // UNROUTED_SUMMARY_DAYS ago. Reading all history on every open
      // made the tab slower each day, and a number fixed long ago
      // would still head the list.
      const since =
        q.from ??
        new Date(Date.now() - UNROUTED_SUMMARY_DAYS * DAY_MS).toISOString();
      let all: Pick<CallRow, 'did_number' | 'started_at'>[];
      if (rows.length < q.limit) {
        // A short list is every unrouted call, the older ones included.
        const sinceAt = Date.parse(since);
        all = rows.filter((r) => Date.parse(r.started_at) >= sinceAt);
      } else {
        // A full one may not be. Newest first, so that if the cap cuts
        // the read it is the oldest calls that go and every number keeps
        // its latest call.
        all = [];
        for (let page = 0; page < SUMMARY_MAX_PAGES; page++) {
          const res = await scoped('did_number, started_at', since)
            .order('started_at', { ascending: false })
            .order('id', { ascending: false })
            .range(page * PAGE, (page + 1) * PAGE - 1);
          if (res.error)
            throw new Error(`calls read failed: ${res.error.message}`);
          const chunk = (res.data ?? []) as unknown as typeof all;
          all.push(...chunk);
          if (chunk.length < PAGE) break;
        }
      }
      numbers = unroutedNumbers(all);
    }

    const ids = (k: 'contact_id' | 'user_id') => [
      ...new Set(rows.map((r) => r[k]).filter((v): v is string => !!v)),
    ];
    const contactIds = ids('contact_id');
    const userIds = [
      ...new Set([...ids('user_id'), ...rows.flatMap((r) => rangIds(r.meta))]),
    ];
    const recorded = rows
      .filter((r) => r.recording_state === 'fetched')
      .map((r) => r.id);
    const [contacts, people, recordings] = await Promise.all([
      contactIds.length
        ? ctx.supabase
            .from('contacts')
            .select('id, name, do_not_contact_at, do_not_contact_reason')
            .in('id', contactIds)
        : { data: [], error: null },
      userIds.length
        ? ctx.supabase
            .from('profiles')
            .select('user_id, full_name')
            .eq('account_id', ctx.accountId)
            .in('user_id', userIds)
        : { data: [], error: null },
      recorded.length
        ? ctx.supabase
            .from('call_recordings')
            .select('call_id, legal_hold, erased_at')
            .in('call_id', recorded)
        : { data: [], error: null },
    ]);
    if (recordings.error)
      throw new Error(
        `call_recordings read failed: ${recordings.error.message}`
      );
    const recording = new Map(
      (
        (recordings.data ?? []) as {
          call_id: string;
          legal_hold: boolean;
          erased_at: string | null;
        }[]
      ).map((r) => [r.call_id, r])
    );
    if (contacts.error)
      throw new Error(`contacts read failed: ${contacts.error.message}`);
    if (people.error)
      throw new Error(`profiles read failed: ${people.error.message}`);
    const contactById = new Map(
      ((contacts.data ?? []) as ContactRow[]).map((c) => [c.id, c])
    );
    const userName = new Map(
      (
        (people.data ?? []) as { user_id: string; full_name: string | null }[]
      ).map((p) => [p.user_id, p.full_name])
    );

    return NextResponse.json({
      calls: rows.map((r) => {
        const contact = r.contact_id ? contactById.get(r.contact_id) : null;
        const dncAt = contact?.do_not_contact_at ?? null;
        return {
          id: r.id,
          direction: r.direction,
          status: r.status,
          startedAt: r.started_at,
          answeredAt: r.answered_at,
          endedAt: r.ended_at,
          ringSeconds: r.ring_seconds,
          talkSeconds: r.talk_seconds,
          remoteNumber: r.remote_number,
          didNumber: r.did_number,
          extension: r.extension,
          contactId: r.contact_id,
          contactName: contact?.name || null,
          doNotContactAt: dncAt,
          doNotContactReason: (dncAt && contact?.do_not_contact_reason) || null,
          userId: r.user_id,
          userName: (r.user_id && userName.get(r.user_id)) || null,
          rangNames: rangIds(r.meta)
            .map((u) => userName.get(u)?.trim())
            .filter((name): name is string => !!name),
          disposition: r.disposition,
          notes: r.notes,
          recordingState: r.recording_state,
          recordingDeleted: !!recording.get(r.id)?.erased_at,
          legalHold: recording.get(r.id)?.legal_hold === true,
        };
      }),
      ...(numbers && { numbers }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
