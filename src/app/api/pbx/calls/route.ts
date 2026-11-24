// ============================================================
// GET /api/pbx/calls — a call list (module 015, migration 089).
//   ?contactId=&userId=&userIds=&direction=external&scope=mine|my_missed|missed|all|unrouted&from=&to=&before=&beforeId=&limit=
//   → { calls: [{ id, pbxCallId, direction, status, startedAt,
//       answeredAt, endedAt, ringSeconds, talkSeconds, remoteNumber, didNumber, extension,
//       contactId, contactName, doNotContactAt, doNotContactReason,
//       userId, userName, rangNames, disposition, notes, recordingState,
//       recordingDeleted, legalHold, task? }],
//       truncated, numbers?: [{ didNumber, calls, lastAt }] }
// truncated: calls older than the last one exist; before/beforeId (that
// call's startedAt and id, as answered) is the page that continues.
// didNumber: the number the customer dialled (calls.did_number).
// pbxCallId: the PBX's own id (calls.pbx_call_id), the one a live call
// is known by, so the in-call window can leave the call in progress
// out of the customer's earlier calls.
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
// task: missed / my_missed only: the call's callback task, { status,
// name } or null, whoever holds it (read on the service role, for the
// calls this list returned, so a colleague's call back is seen).
// recordingDeleted: the stored audio was deleted under the retention
// period (the recording row's erased_at, migration 093); legalHold: an
// admin's legal hold keeps it.
//
// Read on the caller's client, so every row is one pbx_can_view_call
// shows them, notes included; a contact's name and do-not-contact
// stamp and reason (086) only when they can see the contact too, so
// the Calls screen disables Call back for that customer. The dial route
// still decides: it checks the number across the workspace, which this
// list does not. mine (the default): calls they were a party to,
// that rang their phone or that they answered (myCallsFilter); missed: inbound calls
// that ended missed (isMissedCall, as the reports count them); my_missed: both; all:
// every call RLS shows them (a leader's teams, an admin's workspace;
// a call reviewer's too, migration 198, whose customers RLS hides are
// named on the service role, the name only).
// userId: only the calls that person took or placed (calls.user_id),
// narrowing whatever the scope and RLS show (the Call report page's
// drill-down). userIds: the same for a comma list of people (at most
// 200). direction=external: only inbound and outbound calls, the ones
// pbx_call_stats counts. Like userId, both only narrow; RLS is not
// widened. Newest first; from/to bound started_at (from inclusive).
// Viewer+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { canViewAllCalls } from '@/lib/auth/roles';
import { internalPeerExtension } from '@/lib/pbx/call-legs';
import { reviewerContactNames, seesAllCalls } from '@/lib/pbx/call-reviewers';
import { UNROUTED_SUMMARY_DAYS } from '@/lib/pbx/call-ui';
import {
  MISSED_STATUSES,
  canListCallScope,
  fail,
  myCallsFilter,
  parseCallListQuery,
  peopleCallsFilter,
  unroutedNumbers,
  type UnroutedNumber,
} from '@/lib/pbx/calls';
import { missedCallTasks } from '@/lib/pbx/missed-tasks';

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
  pbx_call_id: string;
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

    // The Calls page shows people's calls: an agent their own, a team
    // leader their teams', an admin or a call reviewer (198) everyone's.
    // RLS also lets through the calls of every contact the caller can see
    // (113), which stays the customer page's rule, so a list for one
    // contact is not narrowed.
    const seesAll = await seesAllCalls(ctx);
    let teamFilter: string | null = null;
    if (
      !q.contactId &&
      !seesAll &&
      q.scope !== 'mine' &&
      q.scope !== 'my_missed'
    ) {
      const visible = await ctx.supabase.rpc('pbx_visible_user_ids');
      if (visible.error)
        throw new Error(`visible people read failed: ${visible.error.message}`);
      teamFilter = peopleCallsFilter(
        Array.isArray(visible.data)
          ? visible.data.filter(
              (v: unknown): v is string => typeof v === 'string'
            )
          : []
      );
      if (!teamFilter) return NextResponse.json({ calls: [] });
    }

    // The list and the unrouted numbers read the same calls.
    const scoped = (columns: string, from = q.from) => {
      let query = ctx.supabase
        .from('calls')
        .select(columns)
        .eq('account_id', ctx.accountId);
      if (q.contactId) query = query.eq('contact_id', q.contactId);
      if (q.userId) query = query.eq('user_id', q.userId);
      if (q.userIds) query = query.in('user_id', q.userIds);
      if (q.direction === 'external')
        query = query.in('direction', ['inbound', 'outbound']);
      if (q.scope === 'mine' || q.scope === 'my_missed')
        query = query.or(myCallsFilter(ctx.userId));
      if (teamFilter) query = query.or(teamFilter);
      if (q.scope === 'missed' || q.scope === 'my_missed')
        query = query
          .eq('direction', 'inbound')
          .in('status', [...MISSED_STATUSES]);
      if (q.scope === 'unrouted') query = query.eq('meta->>unrouted', 'true');
      if (from) query = query.gte('started_at', from);
      if (q.to) query = query.lt('started_at', q.to);
      return query;
    };
    let page = scoped(
      'id, pbx_call_id, direction, status, started_at, answered_at, ended_at, ring_seconds, talk_seconds, remote_number, did_number, extension, contact_id, user_id, disposition, notes, recording_state, meta'
    );
    // Past (started_at, id): at or before that instant, and not that
    // call or one listed before it.
    if (q.before)
      page = page
        .lte('started_at', q.before.startedAt)
        .or(`started_at.lt.${q.before.startedAt},id.lt.${q.before.id}`);
    const { data, error } = await page
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(q.limit + 1);
    if (error) throw new Error(`calls read failed: ${error.message}`);
    const read = (data ?? []) as unknown as CallRow[];
    const truncated = read.length > q.limit;
    const rows = read.slice(0, q.limit);

    let numbers: UnroutedNumber[] | undefined;
    // A later page's reader has them already.
    if (q.scope === 'unrouted' && !q.before) {
      // The numbers start at the request's `from`, else
      // UNROUTED_SUMMARY_DAYS ago. Reading all history on every open
      // made the tab slower each day, and a number fixed long ago
      // would still head the list.
      const since =
        q.from ??
        new Date(Date.now() - UNROUTED_SUMMARY_DAYS * DAY_MS).toISOString();
      let all: Pick<CallRow, 'did_number' | 'started_at'>[];
      if (!truncated) {
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

    // A call between colleagues is named by its two extensions, read off
    // the PBX's records and mapped to people as the extensions are mapped
    // now. Not by user_id / peer_user_id: a live frame could store the
    // callee as both (2026-10-27), and a later mapping never reached them.
    const sides = new Map(
      rows
        .filter((r) => r.direction === 'internal')
        .map((r) => [
          r.id,
          { from: r.extension, to: internalPeerExtension(r.meta, r.extension) },
        ])
    );
    const sideExts = [
      ...new Set(
        [...sides.values()]
          .flatMap((s) => [s.from, s.to])
          .filter((v): v is string => !!v)
      ),
    ];
    const extPeople = new Map<string, string>();
    if (sideExts.length) {
      const mapped = await ctx.supabase
        .from('pbx_extensions')
        .select('extension, user_id')
        .eq('account_id', ctx.accountId)
        .in('extension', sideExts);
      if (mapped.error)
        throw new Error(`pbx_extensions read failed: ${mapped.error.message}`);
      for (const e of (mapped.data ?? []) as {
        extension: string;
        user_id: string | null;
      }[])
        if (e.user_id) extPeople.set(e.extension, e.user_id);
    }
    const userIds = [
      ...new Set([
        ...ids('user_id'),
        ...extPeople.values(),
        ...rows.flatMap((r) => rangIds(r.meta)),
      ]),
    ];
    const recorded = rows
      .filter((r) => r.recording_state === 'fetched')
      .map((r) => r.id);
    const listsMissed = q.scope === 'missed' || q.scope === 'my_missed';
    const [contacts, people, recordings, tasks] = await Promise.all([
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
      // A failure fails the list: calls without badges would say nobody
      // has called back.
      listsMissed && rows.length
        ? missedCallTasks(pbxServiceDb(), ctx.accountId, rows)
        : null,
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
    // A reviewer below admin sees every call but not every customer:
    // name the rest (name only, no do-not-contact stamp).
    if (seesAll && !canViewAllCalls(ctx.role))
      for (const [id, name] of await reviewerContactNames(
        ctx.accountId,
        contactIds.filter((id) => !contactById.has(id))
      ))
        contactById.set(id, {
          id,
          name,
          do_not_contact_at: null,
          do_not_contact_reason: null,
        });
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
          pbxCallId: r.pbx_call_id,
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
          // A call between colleagues has no customer number: its two
          // extensions and their people name it (see `sides` above).
          ...(sides.has(r.id) && {
            party: (['from', 'to'] as const).reduce(
              (out, k) => {
                const ext = sides.get(r.id)![k];
                const who = ext ? extPeople.get(ext) : undefined;
                out[k] = {
                  extension: ext,
                  userId: who ?? null,
                  name: (who && userName.get(who)) || null,
                };
                return out;
              },
              {} as Record<
                'from' | 'to',
                {
                  extension: string | null;
                  userId: string | null;
                  name: string | null;
                }
              >
            ),
          }),
          rangNames: rangIds(r.meta)
            .map((u) => userName.get(u)?.trim())
            .filter((name): name is string => !!name),
          disposition: r.disposition,
          notes: r.notes,
          recordingState: r.recording_state,
          recordingDeleted: !!recording.get(r.id)?.erased_at,
          legalHold: recording.get(r.id)?.legal_hold === true,
          ...(listsMissed && { task: tasks?.get(r.id) ?? null }),
        };
      }),
      truncated,
      ...(numbers && { numbers }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
