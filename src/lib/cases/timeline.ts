/**
 * A case's timeline (module 018c): every source merged and time-ordered.
 *
 *   1. case_timeline(actor, case) (migration 124, service role): stage,
 *      task, task_status, note, document, sla and bank_contact rows, ordered
 *      in SQL. It refuses CASE_NOT_FOUND / NOT_ALLOWED, so nothing below
 *      runs for an actor who may not read the case.
 *   2. The case's submission group (115): opened, ended, and for an ENDED
 *      group one entry saying the conversation is archived. An ENDED
 *      group's messages NEVER enter the timeline: they are read only
 *      through 115's audited viewArchive (CaseConversations.read).
 *   3. Live group messages, only with `includeMessages`, only while the
 *      group is ACTIVE, and only after `store.viewCases` (view_case, the
 *      audited read) returned the case. post_end rows are left out.
 *   4. Calls of the case's contact since the case opened, read through the
 *      CALLER's RLS client, so 113's pbx_can_view_call decides which.
 *
 * Merge: by time; equal times order case row < group entry < message <
 * call, and keep each source's own order (Array.prototype.sort is stable).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { CaseStore } from './store';
import { CaseStoreError, date, fail, rows, str } from './store';
import { liveGroupMessages, loadCaseGroup } from './case-group';

export type TimelineSource = 'case' | 'group' | 'message' | 'call';

export interface CaseTimelineEntry {
  at: Date;
  /** SQL kinds, group_open, group_end, conversation_archived, group_message, call. */
  kind: string;
  refId: string;
  /** A user id; null when no staff user acted (customer messages, group events). */
  actor: string | null;
  summary: string;
  source: TimelineSource;
}

export interface CaseTimelineDeps {
  /** Service role: case_timeline, the group and its live messages. */
  db: SupabaseClient;
  /** The caller's RLS client: calls (pbx_can_view_call applies). */
  rlsDb: SupabaseClient;
  store: Pick<CaseStore, 'get' | 'viewCases'>;
}

/** At most this many calls enter one timeline (oldest first). */
export const TIMELINE_MAX_CALLS = 500;
/** As the SQL timeline does for notes and bank contacts. */
const SUMMARY_CHARS = 200;
const clip = (s: string): string =>
  Array.from(s).slice(0, SUMMARY_CHARS).join('');

const RANK: Record<TimelineSource, number> = {
  case: 0,
  group: 1,
  message: 2,
  call: 3,
};

/** Time, then case < group < message < call; stable within a source. */
export function mergeTimeline(
  entries: readonly CaseTimelineEntry[]
): CaseTimelineEntry[] {
  return [...entries].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || RANK[a.source] - RANK[b.source]
  );
}

export async function caseTimeline(
  deps: CaseTimelineDeps,
  input: { caseId: string; actor: string; includeMessages: boolean }
): Promise<CaseTimelineEntry[]> {
  const { db, rlsDb, store } = deps;
  const { caseId, actor } = input;
  const { data, error } = await db.rpc('case_timeline', {
    p_actor: actor,
    p_case: caseId,
  });
  if (error) fail('case_timeline', error);
  const entries: CaseTimelineEntry[] = rows(data).map((r) => ({
    at: date(r.at)!,
    kind: String(r.kind),
    refId: String(r.ref_id),
    actor: str(r.actor),
    summary: String(r.summary ?? ''),
    source: 'case',
  }));

  const kase = await store.get(caseId);
  if (!kase) return mergeTimeline(entries);

  const group = await loadCaseGroup(db, kase);
  if (group) {
    entries.push({
      at: group.createdAt,
      kind: 'group_open',
      refId: group.id,
      actor: null,
      summary: 'submission group opened',
      source: 'group',
    });
    if (group.endedAt) {
      entries.push({
        at: group.endedAt,
        kind: 'group_end',
        refId: group.id,
        actor: null,
        summary: `submission group ended${group.endReason ? ` (${group.endReason})` : ''}`,
        source: 'group',
      });
    }
    if (group.status === 'ENDED') {
      entries.push({
        at: group.endedAt ?? group.createdAt,
        kind: 'conversation_archived',
        refId: group.id,
        actor: null,
        summary: 'conversation archived',
        source: 'group',
      });
    } else if (input.includeMessages) {
      const readable = await store.viewCases(actor, [caseId]);
      if (readable.includes(caseId)) {
        for (const m of await liveGroupMessages(db, group.id))
          entries.push({
            at: m.createdAt,
            kind: 'group_message',
            refId: m.id,
            actor: m.senderUserId,
            summary: `${m.direction === 'in' ? 'customer' : `staff (${m.sendStatus ?? 'unknown'})`}: ${clip(m.body ?? `[${m.type}]`)}`,
            source: 'message',
          });
      }
    }
  }

  if (kase.contactId) {
    const { data: calls, error: callError } = await rlsDb
      .from('calls')
      .select('id, direction, status, started_at, talk_seconds, user_id')
      .eq('account_id', kase.accountId)
      .eq('contact_id', kase.contactId)
      .gte('started_at', kase.openedAt.toISOString())
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(TIMELINE_MAX_CALLS);
    if (callError) throw new CaseStoreError('calls', callError.code ?? null);
    for (const c of rows(calls)) {
      const talk = c.talk_seconds == null ? null : Number(c.talk_seconds);
      entries.push({
        at: date(c.started_at)!,
        kind: 'call',
        refId: String(c.id),
        actor: str(c.user_id),
        summary: `${String(c.direction)} call: ${String(c.status)}${talk ? ` (${talk}s)` : ''}`,
        source: 'call',
      });
    }
  }

  return mergeTimeline(entries);
}
