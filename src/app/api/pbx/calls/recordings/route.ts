// ============================================================
// GET /api/pbx/calls/recordings — the Team call recordings page
// (module 015; no migration of its own).
//   ?period=today|yesterday|week|last_week|month|last_month|custom
//    &from=YYYY-MM-DD&to=YYYY-MM-DD&tz=&team=<uuid>&user=<uuid>
//    &direction=all|inbound|outbound|internal&minTalk=<seconds>
//    &q=<digits>&before=<cursor>&limit=
//   → TeamRecordingsResponse (lib/pbx/team-recordings.ts):
//     { range, people, teams, summary, summaryCapped, calls, next }
//
// Team leader and up (requireRole('team_leader'); an agent is a 403).
// Browse and listen only: nothing is stored here, and a play goes
// through POST /api/pbx/calls/{id}/recording like anywhere else, which
// logs it first (download stays team leader and up there).
//
// The period is computed as GET /api/pbx/calls/stats does, in the
// account's zone (else the viewer's `tz`); a custom period is whole
// days, at most 92.
//
// Scope. people: an owner or admin every live staff profile of the
// active account; a team leader pbx_visible_user_ids() (113: themselves
// and the people of the teams they lead) among those. teams: an admin
// every team, a leader the teams they lead, each listing only members
// in scope. `team` must be one of those teams and narrows to its
// members (its leader only if a member); `user` must be one of those
// people and narrows to them. Anything else is a 403. Calls are always
// read for those people only (calls.user_id), so a call with no person
// is never here, and RLS (pbx_can_view_call, the caller's client) still
// decides every row. `people` and `teams` are the whole scope, for the
// filters, whatever the narrowing.
//
// summary: one entry per narrowed person, zero rows included, over the
// range, team/user and direction (not minTalk or q). Read light, newest
// first, SUMMARY_PAGE rows a page and at most SUMMARY_MAX_PAGES pages;
// summaryCapped says the cap cut it (the oldest calls then go
// uncounted). It reads calls only, so a recording the retention period
// has since erased (call_recordings.erased_at) still counts as recorded.
//
// calls: fetched recordings only, newest first (started_at, then id),
// also narrowed by minTalk (talk_seconds >=) and q (digits anywhere in
// remote_number), `limit` a page. `next` is the cursor of the page's
// oldest call when there is more, from a limit+1 read. A recording
// erased under retention has nothing to play and is dropped after that
// read, so a page can come back short while `next` still goes on.
// Contact names and do-not-contact stamps only for contacts RLS shows,
// as GET /api/pbx/calls does.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canViewAllCalls } from '@/lib/auth/roles';
import { fail } from '@/lib/pbx/calls';
import {
  CALL_REPORT_MAX_DAYS,
  callReportRange,
  reportTimeZone,
} from '@/lib/pbx/call-report';
import {
  SUMMARY_MAX_PAGES,
  SUMMARY_PAGE,
  cursorFilter,
  encodeCursor,
  narrowPeople,
  parseTeamRecordingsQuery,
  scopePeople,
  summarizeRecordings,
  type SummaryCallRow,
  type TeamRecordingCall,
  type TeamRecordingsResponse,
} from '@/lib/pbx/team-recordings';

const PROBLEMS = {
  missing: 'A custom period needs from and to dates (YYYY-MM-DD)',
  order: 'The period ends before it starts',
  span: `A custom period spans at most ${CALL_REPORT_MAX_DAYS} days`,
} as const;

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
    const ctx = await requireRole('team_leader');
    const params = new URL(request.url).searchParams;
    const q = parseTeamRecordingsQuery(params);
    if (typeof q === 'string') return fail(q);

    // The zone is presentation: a failed read falls back to the viewer's.
    const zone = await ctx.supabase.rpc('team_activity_limits', {
      p_account: ctx.accountId,
    });
    if (zone.error)
      console.error('[pbx] call recordings zone:', zone.error.message);
    const saved = Array.isArray(zone.data)
      ? (zone.data[0] as { timezone?: unknown } | undefined)?.timezone
      : null;
    const timeZone = reportTimeZone(saved, q.tz);
    const range = callReportRange(q.period, new Date(), timeZone, {
      from: q.from,
      to: q.to,
    });
    if (!range.ok) return fail(PROBLEMS[range.problem]);
    const from = range.from.toISOString();
    const to = range.to.toISOString();

    // ---- Scope: people and teams ----
    const all = canViewAllCalls(ctx.role);
    let visibleIds: string[] | null = null;
    if (!all) {
      const visible = await ctx.supabase.rpc('pbx_visible_user_ids');
      if (visible.error)
        throw new Error(`visible people read failed: ${visible.error.message}`);
      visibleIds = Array.isArray(visible.data)
        ? visible.data.filter(
            (v: unknown): v is string => typeof v === 'string'
          )
        : [];
    }
    let profilesQuery = ctx.supabase
      .from('profiles')
      .select('user_id, full_name, account_role')
      .eq('account_id', ctx.accountId)
      .is('deactivated_at', null)
      .neq('account_role', 'bank_guest');
    if (visibleIds) profilesQuery = profilesQuery.in('user_id', visibleIds);
    let teamsQuery = ctx.supabase
      .from('teams')
      .select('id, name')
      .eq('account_id', ctx.accountId);
    if (!all) teamsQuery = teamsQuery.eq('leader_user_id', ctx.userId);
    const [profiles, teams] = await Promise.all([
      visibleIds && !visibleIds.length
        ? { data: [], error: null }
        : profilesQuery,
      teamsQuery,
    ]);
    if (profiles.error)
      throw new Error(`profiles read failed: ${profiles.error.message}`);
    if (teams.error)
      throw new Error(`teams read failed: ${teams.error.message}`);
    const teamRows = (teams.data ?? []) as { id: string; name: string }[];
    const members = teamRows.length
      ? await ctx.supabase
          .from('team_members')
          .select('team_id, user_id')
          .eq('account_id', ctx.accountId)
          .in(
            'team_id',
            teamRows.map((t) => t.id)
          )
      : { data: [], error: null };
    if (members.error)
      throw new Error(`team_members read failed: ${members.error.message}`);

    const scope = scopePeople({
      profiles: (profiles.data ?? []) as {
        user_id: string;
        full_name: string | null;
        account_role: string;
      }[],
      visibleIds,
      teams: teamRows,
      memberships: (members.data ?? []) as {
        team_id: string;
        user_id: string;
      }[],
    });
    const narrowed = narrowPeople(scope, q);
    if (!narrowed.ok) return fail(narrowed.error, 403);
    const userIds = narrowed.userIds;

    const respond = (
      rest: Pick<
        TeamRecordingsResponse,
        'summary' | 'summaryCapped' | 'calls' | 'next'
      >
    ) =>
      NextResponse.json({
        range: { period: q.period, from, to, timeZone },
        people: scope.people,
        teams: scope.teams,
        ...rest,
      } satisfies TeamRecordingsResponse);
    if (!userIds.length)
      return respond({
        summary: [],
        summaryCapped: false,
        calls: [],
        next: null,
      });

    // The summary and the list read the same people, range and direction.
    const scoped = (columns: string) => {
      let query = ctx.supabase
        .from('calls')
        .select(columns)
        .eq('account_id', ctx.accountId)
        .in('user_id', userIds)
        .gte('started_at', from)
        .lt('started_at', to);
      if (q.direction !== 'all') query = query.eq('direction', q.direction);
      return query;
    };

    // ---- Summary ----
    const summaryRows: SummaryCallRow[] = [];
    let summaryCapped = false;
    for (let page = 0; ; page++) {
      if (page === SUMMARY_MAX_PAGES) {
        summaryCapped = true;
        break;
      }
      const res = await scoped(
        'user_id, answered_at, recording_state, talk_seconds, started_at'
      )
        .order('started_at', { ascending: false })
        .order('id', { ascending: false })
        .range(page * SUMMARY_PAGE, (page + 1) * SUMMARY_PAGE - 1);
      if (res.error) throw new Error(`calls read failed: ${res.error.message}`);
      const chunk = (res.data ?? []) as unknown as SummaryCallRow[];
      summaryRows.push(...chunk);
      if (chunk.length < SUMMARY_PAGE) break;
    }
    const summary = summarizeRecordings(userIds, summaryRows);

    // ---- The page of recordings ----
    let list = scoped(
      'id, pbx_call_id, direction, status, started_at, answered_at, ended_at, ring_seconds, talk_seconds, remote_number, did_number, extension, contact_id, user_id, disposition, notes, recording_state, meta'
    ).eq('recording_state', 'fetched');
    if (q.minTalk > 0) list = list.gte('talk_seconds', q.minTalk);
    if (q.q) list = list.ilike('remote_number', `%${q.q}%`);
    if (q.before) list = list.or(cursorFilter(q.before));
    const { data, error } = await list
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(q.limit + 1);
    if (error) throw new Error(`calls read failed: ${error.message}`);
    const read = (data ?? []) as unknown as CallRow[];
    const rows = read.slice(0, q.limit);
    const next =
      read.length > q.limit && rows.length
        ? encodeCursor(rows[rows.length - 1])
        : null;

    const contactIds = [
      ...new Set(rows.map((r) => r.contact_id).filter((v): v is string => !!v)),
    ];
    const nameIds = [
      ...new Set(
        rows.flatMap((r) => [
          ...(r.user_id ? [r.user_id] : []),
          ...rangIds(r.meta),
        ])
      ),
    ];
    const callIds = rows.map((r) => r.id);
    const [contacts, people, recordings] = await Promise.all([
      contactIds.length
        ? ctx.supabase
            .from('contacts')
            .select('id, name, do_not_contact_at, do_not_contact_reason')
            .in('id', contactIds)
        : { data: [], error: null },
      nameIds.length
        ? ctx.supabase
            .from('profiles')
            .select('user_id, full_name')
            .eq('account_id', ctx.accountId)
            .in('user_id', nameIds)
        : { data: [], error: null },
      callIds.length
        ? ctx.supabase
            .from('call_recordings')
            .select('call_id, legal_hold, erased_at')
            .in('call_id', callIds)
        : { data: [], error: null },
    ]);
    if (recordings.error)
      throw new Error(
        `call_recordings read failed: ${recordings.error.message}`
      );
    if (contacts.error)
      throw new Error(`contacts read failed: ${contacts.error.message}`);
    if (people.error)
      throw new Error(`profiles read failed: ${people.error.message}`);
    const recording = new Map(
      (
        (recordings.data ?? []) as {
          call_id: string;
          legal_hold: boolean;
          erased_at: string | null;
        }[]
      ).map((r) => [r.call_id, r])
    );
    const contactById = new Map(
      ((contacts.data ?? []) as ContactRow[]).map((c) => [c.id, c])
    );
    const userName = new Map(
      (
        (people.data ?? []) as { user_id: string; full_name: string | null }[]
      ).map((p) => [p.user_id, p.full_name])
    );

    const calls: TeamRecordingCall[] = rows
      // Erased under the retention period: nothing to play.
      .filter((r) => !recording.get(r.id)?.erased_at)
      .map((r) => {
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
          rangNames: rangIds(r.meta)
            .map((u) => userName.get(u)?.trim())
            .filter((name): name is string => !!name),
          disposition: r.disposition,
          notes: r.notes,
          recordingState: r.recording_state,
          recordingDeleted: false,
          legalHold: recording.get(r.id)?.legal_hold === true,
        };
      });

    return respond({ summary, summaryCapped, calls, next });
  } catch (err) {
    return toErrorResponse(err);
  }
}
