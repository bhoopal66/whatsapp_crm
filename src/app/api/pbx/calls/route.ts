// ============================================================
// GET /api/pbx/calls — a call list (module 015, migration 089).
//   ?contactId=&scope=mine|missed|all&from=&to=&limit=
//   → { calls: [{ id, direction, status, startedAt, answeredAt, endedAt,
//       ringSeconds, talkSeconds, remoteNumber, extension, contactId,
//       contactName, userId, userName, disposition, notes,
//       recordingState }] }
//
// Read on the caller's client, so every row is one pbx_can_view_call
// shows them, notes included; a contact's name only when they can see
// the contact too. mine: calls they were a party to; missed: inbound
// calls nobody answered (as the month summary counts them). Newest
// first; from/to bound started_at (from inclusive). Viewer+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { MISSED_STATUSES, fail, parseCallListQuery } from '@/lib/pbx/calls';

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
  extension: string | null;
  contact_id: string | null;
  user_id: string | null;
  disposition: string | null;
  notes: string | null;
  recording_state: string;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const q = parseCallListQuery(new URL(request.url).searchParams);
    if (typeof q === 'string') return fail(q);

    let query = ctx.supabase
      .from('calls')
      .select(
        'id, direction, status, started_at, answered_at, ended_at, ring_seconds, talk_seconds, remote_number, extension, contact_id, user_id, disposition, notes, recording_state'
      )
      .eq('account_id', ctx.accountId);
    if (q.contactId) query = query.eq('contact_id', q.contactId);
    if (q.scope === 'mine')
      query = query.or(
        `user_id.eq.${ctx.userId},peer_user_id.eq.${ctx.userId}`
      );
    if (q.scope === 'missed')
      query = query
        .eq('direction', 'inbound')
        .in('status', [...MISSED_STATUSES])
        .is('answered_at', null);
    if (q.from) query = query.gte('started_at', q.from);
    if (q.to) query = query.lt('started_at', q.to);
    const { data, error } = await query
      .order('started_at', { ascending: false })
      .limit(q.limit);
    if (error) throw new Error(`calls read failed: ${error.message}`);
    const rows = (data ?? []) as CallRow[];

    const ids = (k: 'contact_id' | 'user_id') => [
      ...new Set(rows.map((r) => r[k]).filter((v): v is string => !!v)),
    ];
    const [contactIds, userIds] = [ids('contact_id'), ids('user_id')];
    const [contacts, people] = await Promise.all([
      contactIds.length
        ? ctx.supabase.from('contacts').select('id, name').in('id', contactIds)
        : { data: [], error: null },
      userIds.length
        ? ctx.supabase
            .from('profiles')
            .select('user_id, full_name')
            .in('user_id', userIds)
        : { data: [], error: null },
    ]);
    if (contacts.error)
      throw new Error(`contacts read failed: ${contacts.error.message}`);
    if (people.error)
      throw new Error(`profiles read failed: ${people.error.message}`);
    const contactName = new Map(
      ((contacts.data ?? []) as { id: string; name: string | null }[]).map(
        (c) => [c.id, c.name]
      )
    );
    const userName = new Map(
      (
        (people.data ?? []) as { user_id: string; full_name: string | null }[]
      ).map((p) => [p.user_id, p.full_name])
    );

    return NextResponse.json({
      calls: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        status: r.status,
        startedAt: r.started_at,
        answeredAt: r.answered_at,
        endedAt: r.ended_at,
        ringSeconds: r.ring_seconds,
        talkSeconds: r.talk_seconds,
        remoteNumber: r.remote_number,
        extension: r.extension,
        contactId: r.contact_id,
        contactName: (r.contact_id && contactName.get(r.contact_id)) || null,
        userId: r.user_id,
        userName: (r.user_id && userName.get(r.user_id)) || null,
        disposition: r.disposition,
        notes: r.notes,
        recordingState: r.recording_state,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
