import { beforeEach, describe, expect, it, vi } from 'vitest';

import { missedCallOwner } from '../missed-call';
import { ingestPbxEvent } from '../process';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

const A1 = 'acc-conn'; // the connection's own workspace
const A2 = 'acc-sales'; // where the DID routes
const NOW = '2026-10-12T10:00:00.000Z';
let fake: FakeDb;

const member = (kind: string, m: Row) => ({ [kind]: m });
const ring = (callId: string, members: Row[], sn = 'SN1') => ({
  type: 30011,
  sn,
  msg: JSON.stringify({ call_id: callId, members }),
});
const inbound = (status: string) =>
  member('inbound', {
    from: '0501234567',
    to: '043334444',
    trunk_name: 'T1',
    channel_id: 'in-1',
    member_status: status,
  });
const ext = (number: string, status: string) =>
  member('extension', {
    number,
    channel_id: `ch-${number}`,
    member_status: status,
  });
const end = (callId: string, status: string, extra: Row = {}) => ({
  type: 30012,
  sn: 'SN1',
  msg: {
    call_id: callId,
    uid: `uid-${callId}`,
    type: 'Inbound',
    call_from: '0501234567',
    call_to: '6300',
    time_start: '2026-10-12 14:00:00',
    call_duration: 30,
    talk_duration: status === 'ANSWERED' ? 20 : 0,
    status,
    did_number: '043334444',
    ...extra,
  },
});
const ingest = (payload: unknown) =>
  ingestPbxEvent({ db: fake.db, connectionId: 'c1', payload, receivedAt: NOW });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = createFakeDb(
    {
      pbx_connections: [{ id: 'c1', account_id: A1, status: 'unknown' }],
      pbx_did_routes: [
        { connection_id: 'c1', did_number: '97143334444', account_id: A2 },
      ],
      pbx_extensions: [
        {
          connection_id: 'c1',
          extension: '1001',
          account_id: A2,
          user_id: 'u1',
          presence_monitor: true,
        },
        {
          connection_id: 'c1',
          extension: '1002',
          account_id: A2,
          user_id: 'u2',
          presence_monitor: true,
        },
        {
          connection_id: 'c1',
          extension: '1003',
          account_id: A2,
          user_id: 'u3',
          presence_monitor: false,
        },
      ],
      contacts: [
        {
          id: 'k1',
          account_id: A2,
          name: 'Sara',
          phone: '971501234567',
          phone_normalized: '971501234567',
          user_id: 'u1',
        },
        {
          id: 'kX',
          account_id: A1,
          name: 'Other',
          phone: '971509999999',
          phone_normalized: '971509999999',
          user_id: null,
        },
      ],
      conversations: [
        {
          id: 'cv1',
          account_id: A2,
          contact_id: 'k1',
          assigned_agent_id: null,
          created_at: '1',
        },
      ],
      profiles: [
        {
          user_id: 'u1',
          account_id: A2,
          account_role: 'agent',
          deactivated_at: null,
        },
        {
          user_id: 'u2',
          account_id: A2,
          account_role: 'agent',
          deactivated_at: null,
        },
      ],
    },
    {},
    { tasks: { status: 'open' } }
  );
});

describe('ingestPbxEvent', () => {
  it('stores each payload once and ignores a duplicate', async () => {
    const frame = ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]);
    expect(await ingest(frame)).toEqual({
      duplicate: false,
      kind: 'call_state',
    });
    expect(await ingest({ ...frame })).toEqual({ duplicate: true });
    expect(fake.tables.pbx_events_raw).toHaveLength(1);
    expect(fake.tables.pbx_events_raw[0]).toMatchObject({
      event_type: 30011,
      error: null,
    });
    expect(fake.tables.pbx_events_raw[0].processed_at).toBeTruthy();
    expect(fake.tables.pbx_connections[0]).toMatchObject({
      last_event_at: NOW,
      status: 'connected',
    });
    // No path given (the retry sweep): the stored one is left alone.
    expect(fake.tables.pbx_connections[0]).not.toHaveProperty('last_event_via');
  });

  it('stamps the path that carried the event', async () => {
    await ingestPbxEvent({
      db: fake.db,
      connectionId: 'c1',
      payload: ring('call-1', [inbound('ALERT')]),
      receivedAt: NOW,
      via: 'gateway',
    });
    expect(fake.tables.pbx_connections[0]).toMatchObject({
      last_event_at: NOW,
      last_event_via: 'gateway',
    });
  });

  it('an inbound ring pops for the ringing people, with the routed contact', async () => {
    await ingest(
      ring('call-1', [
        inbound('ALERT'),
        ext('1001', 'RING'),
        ext('1002', 'RING'),
      ])
    );
    expect(fake.tables.call_live).toHaveLength(1);
    expect(fake.tables.call_live[0]).toMatchObject({
      account_id: A2,
      contact_id: 'k1',
      remote_number: '971501234567',
      did_number: '97143334444',
      ringing_user_ids: ['u1', 'u2'],
      answered_by: null,
      state: 'ringing',
    });
    expect(fake.tables.calls[0]).toMatchObject({
      account_id: A2,
      direction: 'inbound',
      status: 'ringing',
      contact_id: 'k1',
      conversation_id: 'cv1',
    });
  });

  it('several matching contacts link none and keep the candidates', async () => {
    fake.tables.contacts.push({
      id: 'k2',
      account_id: A2,
      name: 'Dup',
      phone: '9710501234567',
      phone_normalized: '9710501234567',
      user_id: null,
    });
    await ingest(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
    expect(fake.tables.call_live[0].contact_id).toBeNull();
    expect(fake.tables.calls[0].contact_id).toBeNull();
    expect((fake.tables.calls[0].meta as Row).contact_candidates).toEqual([
      'k1',
      'k2',
    ]);
    const legs = fake.tables.call_live[0].members as Row[];
    expect(legs.find((m) => m.kind === 'inbound')?.contactCandidates).toEqual([
      'k1',
      'k2',
    ]);
  });

  it('never matches a contact of another workspace', async () => {
    fake.tables.contacts = fake.tables.contacts.filter((c) => c.id !== 'k1');
    fake.tables.contacts.push({
      id: 'kA1',
      account_id: A1,
      name: 'Elsewhere',
      phone: '971501234567',
      phone_normalized: '971501234567',
      user_id: null,
    });
    await ingest(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
    await ingest(end('call-1', 'NO ANSWER'));
    expect(fake.tables.calls[0]).toMatchObject({
      account_id: A2,
      contact_id: null,
    });
    expect(
      (fake.tables.calls[0].meta as Row).contact_candidates
    ).toBeUndefined();
    expect(fake.tables.tasks[0]).toMatchObject({
      account_id: A2,
      contact_id: null,
      title: 'Call back +971501234567',
    });
  });

  it('an unrouted number files the call under the connection, flagged', async () => {
    fake.tables.pbx_did_routes = [];
    await ingest(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
    expect(fake.tables.calls[0]).toMatchObject({
      account_id: A1,
      did_number: '043334444',
      contact_id: null,
    });
    expect((fake.tables.calls[0].meta as Row).unrouted).toBe(true);
  });

  it('30012 answered writes the final row and clears the screen pop', async () => {
    await ingest(
      ring('call-1', [inbound('ANSWERED'), ext('1001', 'ANSWERED')])
    );
    expect(fake.tables.call_live[0]).toMatchObject({
      answered_by: 'u1',
      state: 'answered',
    });
    await ingest(end('call-1', 'ANSWERED', { recording: 'rec-1.wav' }));
    expect(fake.tables.call_live).toHaveLength(0);
    expect(fake.tables.calls).toHaveLength(1);
    expect(fake.tables.calls[0]).toMatchObject({
      status: 'answered',
      extension: '1001',
      user_id: 'u1',
      contact_id: 'k1',
      talk_seconds: 20,
      ring_seconds: 10,
      started_at: '2026-10-12T10:00:00.000Z',
      ended_at: '2026-10-12T10:00:30.000Z',
      recording_state: 'pending',
      recording_file: 'rec-1.wav',
      pbx_uid: 'uid-call-1',
    });
    // A late frame does not reopen it.
    await ingest(
      ring('call-1', [inbound('ANSWERED'), ext('1001', 'ANSWERED')], 'SN2')
    );
    expect(fake.tables.call_live).toHaveLength(0);
    expect(fake.tables.calls[0].status).toBe('answered');
    expect(fake.tables.tasks ?? []).toHaveLength(0);
  });

  it('a missed call opens one task and one bell, also when re-sent', async () => {
    await ingest(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
    await ingest(end('call-1', 'NO ANSWER'));
    await ingest(end('call-1', 'NO ANSWER'));
    await ingest({ ...end('call-1', 'NO ANSWER'), sn: 'SN-again' });
    const callId = fake.tables.calls[0].id;
    expect(fake.tables.calls[0].status).toBe('no_answer');
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.tasks[0]).toMatchObject({
      kind: 'missed_call',
      source: 'pbx',
      source_ref: `call:${callId}`,
      title: 'Call back Sara',
      assigned_to: 'u1',
      contact_id: 'k1',
      due_at: '2026-10-12T10:30:00.000Z',
    });
    expect(fake.tables.notifications).toHaveLength(1);
    expect(fake.tables.notifications[0]).toMatchObject({
      user_id: 'u1',
      type: 'call_missed',
      meta: { call_id: callId, contact_id: 'k1' },
    });
  });

  it('a new caller missed goes to the first ringing person', async () => {
    fake.tables.contacts = [];
    await ingest(
      ring('call-1', [
        inbound('ALERT'),
        ext('1002', 'RING'),
        ext('1001', 'RING'),
      ])
    );
    await ingest(end('call-1', 'NO ANSWER'));
    expect(fake.tables.tasks[0]).toMatchObject({
      assigned_to: 'u2',
      contact_id: null,
    });
  });

  it('a ring-group call answered by a colleague is not missed', async () => {
    await ingest(
      ring('call-1', [
        inbound('ALERT'),
        ext('1001', 'RING'),
        ext('1002', 'RING'),
      ])
    );
    await ingest(
      ring('call-1', [
        inbound('ANSWERED'),
        ext('1001', 'BYE'),
        ext('1002', 'ANSWERED'),
      ])
    );
    await ingest(ring('call-1', [inbound('BYE'), ext('1002', 'BYE')]));
    expect(fake.tables.call_live).toHaveLength(0);
    await ingest(end('call-1', 'ANSWERED'));
    expect(fake.tables.calls[0]).toMatchObject({
      status: 'answered',
      extension: '1002',
      user_id: 'u2',
    });
    expect(fake.tables.tasks ?? []).toHaveLength(0);
    expect(fake.tables.notifications ?? []).toHaveLength(0);
  });

  it('keeps everyone a missed call rang on the row, past the screen pop', async () => {
    fake.tables.contacts = [];
    // A hunt group: Faisal (1002) rings first, then Sara (1001).
    await ingest(ring('call-1', [inbound('ALERT'), ext('1002', 'RING')]));
    await ingest(
      ring('call-1', [
        inbound('ALERT'),
        ext('1002', 'BYE'),
        ext('1001', 'RING'),
      ])
    );
    // An all-BYE frame deletes the screen pop before the 30012 lands.
    await ingest(ring('call-1', [inbound('BYE'), ext('1001', 'BYE')]));
    expect(fake.tables.call_live).toHaveLength(0);
    await ingest(end('call-1', 'NO ANSWER'));
    expect(fake.tables.calls[0]).toMatchObject({
      status: 'no_answer',
      meta: { rang_user_ids: ['u2', 'u1'] },
    });
    // The first person it rang holds the task.
    expect(fake.tables.tasks[0]).toMatchObject({ assigned_to: 'u2' });
  });

  it('a direct-dialled missed call keeps the extension it rang', async () => {
    await ingest(end('call-1', 'NO ANSWER', { call_to: '1003' }));
    expect(fake.tables.calls[0].meta).toMatchObject({
      rang_user_ids: ['u3'],
    });
  });

  it('points the missed-call task at the WhatsApp draft only when the workspace offers one', async () => {
    const hint = (i: number) =>
      String(fake.tables.tasks[i].note).includes('WhatsApp draft');
    // No settings row: the draft is off.
    // Each call is called back before the next, so none folds into
    // the one before (repeat calls fold: see below).
    const missed = async (callId: string) => {
      for (const t of fake.tables.tasks ?? []) t.status = 'done';
      await ingest(end(callId, 'NO ANSWER'));
    };
    await missed('call-1');
    expect(fake.tables.tasks[0].note).toBe(
      'Missed call (no answer) on 97143334444.'
    );
    fake.tables.pbx_settings = [
      { account_id: A2, missed_call_whatsapp_draft: true },
    ];
    await missed('call-2');
    expect(hint(1)).toBe(true);
    // Never for a do-not-contact or opted-out customer.
    fake.tables.contacts[0].do_not_contact_at = '2026-10-01T09:00:00Z';
    await missed('call-3');
    expect(hint(2)).toBe(false);
    fake.tables.contacts[0].do_not_contact_at = null;
    fake.tables.contacts[0].opted_out_at = '2026-10-02T09:00:00Z';
    await missed('call-4');
    expect(hint(3)).toBe(false);
    // Nor for a caller with no contact to draft to.
    fake.tables.contacts = [];
    await missed('call-5');
    expect(hint(4)).toBe(false);
    expect(fake.tables.tasks).toHaveLength(5);
  });

  describe('who holds a missed call', () => {
    // k1 was created by u1; u9 is the owner who imported it.
    const bells = () =>
      (fake.tables.notifications ?? []).filter((n) => n.type === 'call_missed');

    it('the person it rang, not the contact creator', async () => {
      await ingest(ring('call-1', [inbound('ALERT'), ext('1002', 'RING')]));
      await ingest(end('call-1', 'NO ANSWER'));
      expect(fake.tables.tasks[0]).toMatchObject({
        assigned_to: 'u2',
        contact_id: 'k1',
      });
      expect(bells().map((n) => n.user_id)).toEqual(['u2']);
    });

    it('nobody: unassigned and no bell, never the importer', async () => {
      fake.tables.contacts[0].user_id = 'u9';
      fake.tables.profiles.push({
        user_id: 'u9',
        account_id: A2,
        account_role: 'owner',
        deactivated_at: null,
      });
      await ingest(end('call-1', 'NO ANSWER'));
      expect(fake.tables.tasks[0]).toMatchObject({
        assigned_to: null,
        contact_id: 'k1',
      });
      expect(bells()).toHaveLength(0);
    });

    it("nobody rang: the chat's assigned agent when they can hold it", async () => {
      fake.tables.conversations[0].assigned_agent_id = 'u2';
      await ingest(end('call-1', 'NO ANSWER'));
      expect(fake.tables.tasks[0].assigned_to).toBe('u2');
      fake.tables.profiles[1].deactivated_at = '2026-10-01T00:00:00Z';
      fake.tables.tasks[0].status = 'done';
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks[1].assigned_to).toBeNull();
    });

    it('several rang: the chat agent or contact owner among them first', async () => {
      const both = () =>
        ring('call-1', [
          inbound('ALERT'),
          ext('1002', 'RING'),
          ext('1001', 'RING'),
        ]);
      // u1 created the contact and was rung second.
      await ingest(both());
      await ingest(end('call-1', 'NO ANSWER'));
      expect(fake.tables.tasks[0].assigned_to).toBe('u1');
      // The chat's agent beats the contact's owner.
      fake.tables.tasks[0].status = 'done';
      fake.tables.conversations[0].assigned_agent_id = 'u2';
      await ingest({ ...both(), msg: both().msg.replace('call-1', 'call-2') });
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks[1].assigned_to).toBe('u2');
    });

    it('missedCallOwner: the rule on its own', () => {
      const holders = new Set(['a', 'b', 'c']);
      const base = { holders, assignedAgentId: null, contactOwnerId: null };
      expect(missedCallOwner({ ...base, rang: ['x', 'b', 'a'] })).toBe('b');
      expect(
        missedCallOwner({ ...base, rang: ['b', 'a'], contactOwnerId: 'a' })
      ).toBe('a');
      expect(
        missedCallOwner({
          rang: ['b', 'a', 'c'],
          holders,
          assignedAgentId: 'c',
          contactOwnerId: 'a',
        })
      ).toBe('c');
      // Neither preferred person was rung: the first rung.
      expect(
        missedCallOwner({
          rang: ['b'],
          holders,
          assignedAgentId: 'c',
          contactOwnerId: 'a',
        })
      ).toBe('b');
      // Nobody rang.
      expect(missedCallOwner({ ...base, rang: [], assignedAgentId: 'c' })).toBe(
        'c'
      );
      expect(
        missedCallOwner({ ...base, rang: [], assignedAgentId: 'x' })
      ).toBeNull();
      expect(
        missedCallOwner({ ...base, rang: [], contactOwnerId: 'a' })
      ).toBeNull();
    });
  });

  describe('repeat missed calls', () => {
    it('fold into the open task: one task, one bell, re-sends ignored', async () => {
      await ingest(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
      await ingest(end('call-1', 'NO ANSWER'));
      await ingest(end('call-2', 'BUSY'));
      await ingest(end('call-3', 'NO ANSWER'));
      // call-2's end again, under another hash.
      await ingest({ ...end('call-2', 'BUSY'), sn: 'SN-again' });
      const ids = (fake.tables.calls as Row[]).map((c) => c.id);
      expect(ids).toHaveLength(3);
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.tasks[0]).toMatchObject({
        assigned_to: 'u1',
        source_ref: `call:${ids[0]}`,
        due_at: '2026-10-12T10:30:00.000Z',
        note: '3 missed calls, the latest (no answer) on 97143334444.',
        meta: {
          call_id: ids[0],
          call_ids: ids,
          missed_count: 3,
          remote_number: '971501234567',
        },
      });
      expect(fake.tables.notifications).toHaveLength(1);
    });

    it('hands an unassigned task to the person a later call rang, without our own bell', async () => {
      await ingest(end('call-1', 'NO ANSWER'));
      expect(fake.tables.tasks[0].assigned_to).toBeNull();
      await ingest(ring('call-2', [inbound('ALERT'), ext('1002', 'RING')]));
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.tasks[0]).toMatchObject({
        assigned_to: 'u2',
        meta: { missed_count: 2 },
      });
      // tasks_notify_assigned rings u2 on that UPDATE (089).
      expect(fake.tables.notifications ?? []).toHaveLength(0);
    });

    it('keeps an assigned task with its holder', async () => {
      await ingest(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
      await ingest(end('call-1', 'NO ANSWER'));
      await ingest(ring('call-2', [inbound('ALERT'), ext('1002', 'RING')]));
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.tasks[0].assigned_to).toBe('u1');
      expect(fake.tables.notifications).toHaveLength(1);
    });

    it('a task already dealt with is not reopened: the next call opens one', async () => {
      await ingest(end('call-1', 'NO ANSWER'));
      fake.tables.tasks[0].status = 'done';
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks).toHaveLength(2);
      expect(fake.tables.tasks[1].note).toBe(
        'Missed call (no answer) on 97143334444.'
      );
    });

    it('a call already counted in a closed task is not counted again', async () => {
      await ingest(end('call-1', 'NO ANSWER'));
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks).toHaveLength(1);
      fake.tables.tasks[0].status = 'done';
      // call-2's end again, under another hash, after the task was closed.
      await ingest({ ...end('call-2', 'NO ANSWER'), sn: 'SN-again' });
      expect(fake.tables.tasks).toHaveLength(1);
      // Nor does it fold into a newer open task for the same caller.
      await ingest(end('call-3', 'NO ANSWER'));
      await ingest({ ...end('call-2', 'NO ANSWER'), sn: 'SN-third' });
      expect(fake.tables.tasks).toHaveLength(2);
      expect(fake.tables.tasks[1].meta).toMatchObject({ missed_count: 1 });
    });

    it('a fold that loses a race reads again and keeps both calls', async () => {
      await ingest(end('call-1', 'NO ANSWER'));
      const task = fake.tables.tasks[0];
      task.updated_at = 't0';
      // Another delivery folds 'other' in between our read and our write.
      const from = fake.db.from.bind(fake.db);
      let raced = false;
      (fake.db as unknown as { from: typeof from }).from = (table: string) => {
        const q = from(table);
        if (table !== 'tasks' || raced) return q;
        const update = q.update.bind(q);
        q.update = ((values: Row) => {
          raced = true;
          const ids = (task.meta as Row).call_ids as string[];
          task.meta = { ...(task.meta as Row), call_ids: [...ids, 'other'] };
          task.updated_at = 't1';
          return update(values);
        }) as typeof q.update;
        return q;
      };
      await ingest(end('call-2', 'NO ANSWER'));
      expect(raced).toBe(true);
      expect(fake.tables.tasks).toHaveLength(1);
      const ids = (fake.tables.calls as Row[]).map((c) => c.id);
      expect(task.meta).toMatchObject({
        call_ids: [ids[0], 'other', ids[1]],
        missed_count: 3,
      });
    });

    it("with no contact, fold on the caller's number only", async () => {
      fake.tables.contacts = [];
      await ingest(end('call-1', 'NO ANSWER'));
      await ingest(end('call-2', 'NO ANSWER'));
      await ingest(end('call-3', 'NO ANSWER', { call_from: '0507777777' }));
      expect(fake.tables.tasks).toHaveLength(2);
      expect(fake.tables.tasks[0].meta).toMatchObject({
        remote_number: '971501234567',
        missed_count: 2,
      });
      expect(fake.tables.tasks[1].meta).toMatchObject({
        remote_number: '971507777777',
        missed_count: 1,
      });
    });
  });

  describe('a call sent as several PBX records', () => {
    // One 30012 per leg, each its own POST and hash. Arrival order on
    // live (2026-10-27) decided the row: the last leg overwrote it.
    const leg = (
      callId: string,
      uid: string,
      status: string,
      o: {
        to?: string;
        from?: string;
        type?: string;
        start?: string;
        dur?: number;
        talk?: number;
      } = {}
    ) => ({
      type: 30012,
      sn: `SN-${uid}`,
      msg: {
        call_id: callId,
        uid,
        type: o.type ?? 'Inbound',
        call_from: o.from ?? '0501234567',
        call_to: o.to ?? '6300',
        time_start: o.start ?? '2026-10-12 14:00:00',
        call_duration: o.dur ?? 30,
        talk_duration: o.talk ?? 0,
        status,
        did_number: '043334444',
      },
    });
    const pick = (r: Row) => ({
      status: r.status,
      talk_seconds: r.talk_seconds,
      ring_seconds: r.ring_seconds,
      started_at: r.started_at,
      ended_at: r.ended_at,
      answered_at: r.answered_at,
      extension: r.extension,
      user_id: r.user_id,
      pbx_uid: r.pbx_uid,
      direction: r.direction,
      remote_number: r.remote_number,
      cdr_legs: (r.meta as Row).cdr_legs,
    });
    const callRow = (callId: string) =>
      (fake.tables.calls as Row[]).find((c) => c.pbx_call_id === callId)!;
    const ringGroup = (callId: string) => [
      leg(callId, `${callId}-a`, 'ANSWERED', { to: '1002', talk: 20 }),
      leg(callId, `${callId}-b`, 'NO ANSWER', {
        to: '1001',
        start: '2026-10-12 14:00:05',
        dur: 12,
      }),
    ];

    it('gives the same row whichever leg arrives first', async () => {
      const [a, b] = ringGroup('call-1');
      await ingest(a);
      await ingest(b);
      const [c, d] = ringGroup('call-2');
      await ingest(d);
      await ingest(c);
      const one = pick(callRow('call-1'));
      const two = pick(callRow('call-2'));
      expect(one).toMatchObject({
        status: 'answered',
        talk_seconds: 20,
        ring_seconds: 10,
        started_at: '2026-10-12T10:00:00.000Z',
        ended_at: '2026-10-12T10:00:30.000Z',
        answered_at: '2026-10-12T10:00:10.000Z',
        extension: '1002',
        user_id: 'u2',
        pbx_uid: 'call-1-a',
        direction: 'inbound',
        remote_number: '971501234567',
      });
      expect(one.cdr_legs).toHaveLength(2);
      const uidless = (r: typeof one) => ({
        ...r,
        pbx_uid: null,
        cdr_legs: (r.cdr_legs as Row[]).map((l) => ({ ...l, uid: null })),
      });
      expect(uidless(two)).toEqual(uidless(one));
      // Neither was ever missed for good: no task left open, one row each.
      expect(fake.tables.calls).toHaveLength(2);
      expect(
        (fake.tables.tasks ?? []).filter((t) => t.status === 'open')
      ).toHaveLength(0);
    });

    it('a redelivered leg changes nothing', async () => {
      const [a, b] = ringGroup('call-1');
      await ingest(a);
      await ingest(b);
      const before = { ...callRow('call-1') };
      const writes = () =>
        fake.log.filter((e) => e.table === 'calls' && e.op !== 'select').length;
      const n = writes();
      // The same leg under another hash.
      await ingest({ ...a, sn: 'SN-again' });
      expect(writes()).toBe(n);
      expect(callRow('call-1')).toEqual(before);
    });

    it('keeps every leg when they share one uid, as Yeastar sends them (live)', async () => {
      // On live every leg of a call carried the call's uid; keying on it
      // dropped every leg after the first.
      const shared = (status: string, o: Parameters<typeof leg>[3]) =>
        leg('call-1', 'uid-shared', status, o);
      await ingest(shared('NO ANSWER', { to: '1001', dur: 12 }));
      await ingest(
        shared('ANSWERED', {
          to: '1002',
          talk: 20,
          start: '2026-10-12 14:00:05',
        })
      );
      expect(callRow('call-1')).toMatchObject({
        status: 'answered',
        talk_seconds: 20,
        user_id: 'u2',
      });
      expect((callRow('call-1').meta as Row).cdr_legs).toHaveLength(2);
      // The identical record again is still a redelivery.
      await ingest({
        ...shared('ANSWERED', {
          to: '1002',
          talk: 20,
          start: '2026-10-12 14:00:05',
        }),
        sn: 'SN-again',
      });
      expect((callRow('call-1').meta as Row).cdr_legs).toHaveLength(2);
    });

    it('NO ANSWER then ANSWERED closes the task and is not missed', async () => {
      const [answered, missed] = ringGroup('call-1');
      await ingest(missed);
      expect(callRow('call-1').status).toBe('no_answer');
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.tasks[0]).toMatchObject({
        status: 'open',
        assigned_to: 'u1',
      });
      expect(fake.tables.notifications).toHaveLength(1);
      await ingest(answered);
      expect(callRow('call-1')).toMatchObject({
        status: 'answered',
        user_id: 'u2',
      });
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.tasks[0].status).toBe('done');
      // No second bell; the first one cannot be taken back.
      expect(fake.tables.notifications).toHaveLength(1);
      // A later missed call from the same caller opens a task of its own.
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks).toHaveLength(2);
      expect(fake.tables.tasks[1].meta).toMatchObject({ missed_count: 1 });
    });

    it('leaves a task other calls were folded into open', async () => {
      await ingest(leg('call-1', 'c1-a', 'NO ANSWER', { to: '1001' }));
      await ingest(end('call-2', 'NO ANSWER'));
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.tasks[0].meta).toMatchObject({ missed_count: 2 });
      await ingest(leg('call-1', 'c1-b', 'ANSWERED', { to: '1002', talk: 9 }));
      expect(callRow('call-1').status).toBe('answered');
      expect(fake.tables.tasks[0]).toMatchObject({
        status: 'open',
        meta: { missed_count: 2 },
      });
    });

    it('NO ANSWER then FAILED stays no answer, ringing 55 s (live)', async () => {
      const out = (uid: string, status: string, dur: number) =>
        leg('call-1', uid, status, {
          type: 'Outbound',
          from: '1001',
          to: '0501234567',
          dur,
        });
      await ingest(out('o-a', 'NO ANSWER', 55));
      await ingest(out('o-b', 'FAILED', 0));
      expect(callRow('call-1')).toMatchObject({
        direction: 'outbound',
        status: 'no_answer',
        ring_seconds: 55,
        talk_seconds: 0,
        extension: '1001',
        user_id: 'u1',
        remote_number: '971501234567',
      });
    });

    it('a voicemail leg keeps the first ring as the start (live)', async () => {
      await ingest(
        leg('call-1', 'v-a', 'NO ANSWER', {
          to: '2000',
          start: '2026-10-27 14:47:26',
          dur: 24,
        })
      );
      await ingest(
        leg('call-1', 'v-b', 'VOICEMAIL', {
          to: '2000',
          start: '2026-10-27 14:47:50',
          dur: 27,
          talk: 27,
        })
      );
      expect(callRow('call-1')).toMatchObject({
        status: 'voicemail',
        started_at: '2026-10-27T10:47:26.000Z',
        ended_at: '2026-10-27T10:48:17.000Z',
        talk_seconds: 27,
        ring_seconds: 24,
      });
      // Missed either way: the first leg's task, counted once.
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.tasks[0].status).toBe('open');
    });

    it('a write that loses a race reads again and keeps every leg', async () => {
      const [, b] = ringGroup('call-1');
      await ingest(b);
      const row = callRow('call-1');
      row.updated_at = 't0';
      // Another delivery writes its own leg between our read and our write.
      const from = fake.db.from.bind(fake.db);
      let raced = false;
      (fake.db as unknown as { from: typeof from }).from = (table: string) => {
        const q = from(table);
        if (table !== 'calls' || raced) return q;
        const update = q.update.bind(q);
        q.update = ((values: Row) => {
          raced = true;
          const meta = row.meta as Row;
          row.meta = {
            ...meta,
            cdr_legs: [
              ...(meta.cdr_legs as Row[]),
              {
                uid: 'call-1-a',
                status: 'ANSWERED',
                started_at: '2026-10-12T10:00:00.000Z',
                call_seconds: 30,
                talk_seconds: 20,
                extension: '1002',
                direction: 'inbound',
              },
            ],
          };
          row.updated_at = 't1';
          return update(values);
        }) as typeof q.update;
        return q;
      };
      await ingest(leg('call-1', 'call-1-c', 'NO ANSWER', { to: '1003' }));
      expect(raced).toBe(true);
      const legs = (callRow('call-1').meta as Row).cdr_legs as Row[];
      expect(legs.map((l) => l.uid).sort()).toEqual([
        'call-1-a',
        'call-1-b',
        'call-1-c',
      ]);
      // The rival's ANSWERED leg decides the merged row.
      expect(callRow('call-1')).toMatchObject({
        status: 'answered',
        user_id: 'u2',
        talk_seconds: 20,
      });
    });

    // B is ingested whole just before the first query on a table `at`
    // picks, while A (the NO ANSWER leg) is part way through its end.
    const interleave = (b: unknown, at: (table: string) => boolean) => {
      const from = fake.db.from.bind(fake.db);
      let raced = false;
      (fake.db as unknown as { from: typeof from }).from = (table: string) => {
        const q = from(table);
        if (raced || !at(table)) return q;
        raced = true;
        // The fake's query is itself the thenable the code awaits.
        const p = q as unknown as PromiseLike<unknown>;
        const then = p.then.bind(p);
        p.then = ((ok, ko) =>
          ingest(b).then(() => then(ok, ko))) as typeof p.then;
        return q;
      };
      return () => raced;
    };

    it.each([
      ['before A opens its task', (t: string) => t === 'profiles'],
      [
        'after A opened its task',
        (t: string) =>
          (t === 'calls' || t === 'notifications') &&
          (fake.tables.tasks ?? []).length > 0,
      ],
    ])(
      'an ANSWERED leg racing a NO ANSWER leg %s leaves no task or bell',
      async (_when, at) => {
        const [answered, missed] = ringGroup('call-1');
        const raced = interleave(answered, at);
        await ingest(missed);
        expect(raced()).toBe(true);
        expect(callRow('call-1')).toMatchObject({
          status: 'answered',
          user_id: 'u2',
        });
        expect(
          (fake.tables.tasks ?? []).filter((t) => t.status === 'open')
        ).toHaveLength(0);
        expect(fake.tables.notifications ?? []).toHaveLength(0);
      }
    );

    it.each([
      ['the transfer leg first', true],
      ['the customer leg first', false],
    ])(
      'an inbound call keeps its customer with %s',
      async (_order, transferFirst) => {
        await ingest(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
        expect(callRow('call-1')).toMatchObject({
          direction: 'inbound',
          contact_id: 'k1',
        });
        const transfer = leg('call-1', 'call-1-t', 'ANSWERED', {
          type: 'Internal',
          from: '1001',
          to: '1002',
          start: '2026-10-12 14:00:20',
          dur: 40,
          talk: 38,
        });
        const customer = leg('call-1', 'call-1-c', 'ANSWERED', {
          to: '1001',
          dur: 25,
          talk: 20,
        });
        const kept = {
          direction: 'inbound',
          contact_id: 'k1',
          conversation_id: 'cv1',
          remote_number: '971501234567',
        };
        await ingest(transferFirst ? transfer : customer);
        // In between too: a transfer leg alone must not clear the customer.
        expect(callRow('call-1')).toMatchObject(kept);
        await ingest(transferFirst ? customer : transfer);
        expect(callRow('call-1')).toMatchObject({
          ...kept,
          status: 'answered',
        });
        expect((callRow('call-1').meta as Row).cdr_legs).toHaveLength(2);
      }
    );

    it('a call from an unmapped extension never puts the callee on both sides (live)', async () => {
      // The live frame sees both extensions answered and keeps the first,
      // here the callee's; the end then names the caller's extension,
      // synced from the PBX but mapped to nobody (2122 on live).
      fake.tables.pbx_extensions.push({
        connection_id: 'c1',
        extension: '2122',
        account_id: A2,
        user_id: null,
      });
      await ingest(
        ring('call-9', [ext('1002', 'ANSWERED'), ext('2122', 'ANSWERED')])
      );
      expect(callRow('call-9')).toMatchObject({ user_id: 'u2' });
      await ingest(
        leg('call-9', 'uid-9', 'ANSWERED', {
          type: 'Internal',
          from: '2122',
          to: '1002',
          talk: 20,
        })
      );
      expect(callRow('call-9')).toMatchObject({
        direction: 'internal',
        extension: '2122',
        user_id: null,
        peer_user_id: 'u2',
      });
    });

    it('an insert that loses a race merges into the winner', async () => {
      const [a, b] = ringGroup('call-1');
      // Our read finds no row; the other leg inserts before our insert.
      const from = fake.db.from.bind(fake.db);
      let raced = false;
      (fake.db as unknown as { from: typeof from }).from = (table: string) => {
        const q = from(table);
        if (table !== 'calls' || raced) return q;
        const upsert = q.upsert.bind(q);
        q.upsert = ((values: Row, o: never) => {
          raced = true;
          (fake.db as unknown as { from: typeof from }).from = from;
          return {
            select: async (cols: string) => {
              await ingest(a);
              return upsert(values, o).select(cols);
            },
          };
        }) as unknown as typeof q.upsert;
        return q;
      };
      await ingest(b);
      expect(raced).toBe(true);
      expect(fake.tables.calls).toHaveLength(1);
      expect((callRow('call-1').meta as Row).cdr_legs).toHaveLength(2);
      expect(callRow('call-1')).toMatchObject({
        status: 'answered',
        user_id: 'u2',
      });
    });
  });

  describe('historical (an import of past calls from the CDR)', () => {
    const past = (payload: unknown, historical = true) =>
      ingestPbxEvent({
        db: fake.db,
        connectionId: 'c1',
        payload,
        receivedAt: NOW,
        historical,
      });
    const missed = (callId: string) =>
      end(callId, 'NO ANSWER', { call_to: '1001', recording: 'rec.wav' });

    it('writes a missed call as a live end would, with no task and no bell', async () => {
      expect(await past(missed('call-1'))).toEqual({
        duplicate: false,
        kind: 'call_end',
      });
      expect(fake.tables.calls).toHaveLength(1);
      expect(fake.tables.calls[0]).toMatchObject({
        account_id: A2,
        status: 'no_answer',
        direction: 'inbound',
        extension: '1001',
        user_id: 'u1',
        contact_id: 'k1',
        conversation_id: 'cv1',
        recording_state: 'pending',
      });
      expect(fake.tables.tasks ?? []).toHaveLength(0);
      expect(fake.tables.notifications ?? []).toHaveLength(0);
      // Nor does it move the link clock: it says nothing about now.
      expect(fake.tables.pbx_connections[0].last_event_at).toBeUndefined();
      expect(fake.tables.pbx_events_raw[0].processed_at).toBeTruthy();

      // The same end, live, opens both.
      await past(missed('call-2'), false);
      expect(fake.tables.tasks).toHaveLength(1);
      expect(fake.tables.notifications).toHaveLength(1);
    });

    it('settles no call-back', async () => {
      const dialing = (id: string, callId: string) => ({
        id,
        account_id: A2,
        pbx_call_id: callId,
        status: 'dialing',
        attempts: 1,
        task_id: null,
      });
      fake.tables.callback_requests = [
        dialing('r1', 'call-1'),
        dialing('r2', 'call-2'),
      ];
      await past(missed('call-1'));
      expect(fake.tables.callback_requests[0].status).toBe('dialing');
      await past(missed('call-2'), false);
      expect(fake.tables.callback_requests[1].status).toBe('pending');
    });

    it('a failed frame is removed, never left for the retry sweep to run live', async () => {
      fake.fail('calls', 'upsert', { message: 'boom' });
      const out = await past(missed('call-1'));
      expect(out.error).toMatch(/boom/);
      expect(fake.tables.pbx_events_raw ?? []).toHaveLength(0);
      // A rerun of the import is not a duplicate: it tries again.
      expect(await past(missed('call-1'))).toEqual({
        duplicate: false,
        kind: 'call_end',
      });
      expect(fake.tables.calls).toHaveLength(1);
    });

    it('applies only call ends: past presence would overwrite the present', async () => {
      await past(ring('call-1', [inbound('ALERT'), ext('1001', 'RING')]));
      expect(fake.tables.calls ?? []).toHaveLength(0);
      expect(fake.tables.call_live ?? []).toHaveLength(0);
    });
  });

  it('keeps a bank number unrecorded while the workspace excludes them', async () => {
    fake.tables.pbx_bank_numbers = [
      { account_id: A2, number: '0501234567', bank_code: 'ADCB' },
    ];
    await ingest(end('call-1', 'ANSWERED', { recording: 'rec-1.wav' }));
    expect(fake.tables.calls[0]).toMatchObject({
      recording_state: 'held',
      account_id: A2,
    });
    fake.tables.pbx_settings = [
      {
        account_id: A2,
        exclude_bank_numbers: false,
        missed_call_due_minutes: 5,
      },
    ];
    await ingest(end('call-2', 'ANSWERED', { recording: 'rec-2.wav' }));
    expect(fake.tables.calls[1]).toMatchObject({ recording_state: 'pending' });
  });

  it('marks a recording not stored while the workspace pauses storing', async () => {
    // No settings row: stored.
    await ingest(end('call-1', 'ANSWERED', { recording: 'rec-1.wav' }));
    expect(fake.tables.calls[0]).toMatchObject({
      recording_state: 'pending',
      recording_file: 'rec-1.wav',
    });
    fake.tables.pbx_settings = [
      {
        account_id: A2,
        exclude_bank_numbers: true,
        missed_call_due_minutes: 30,
        store_recordings: false,
      },
    ];
    await ingest(end('call-2', 'ANSWERED', { recording: 'rec-2.wav' }));
    expect(fake.tables.calls[1]).toMatchObject({
      recording_state: 'not_stored',
      recording_file: 'rec-2.wav',
      account_id: A2,
    });
    // A bank number's call is still held.
    fake.tables.pbx_bank_numbers = [
      { account_id: A2, number: '0501234567', bank_code: 'ADCB' },
    ];
    await ingest(end('call-3', 'ANSWERED', { recording: 'rec-3.wav' }));
    expect(fake.tables.calls[2]).toMatchObject({
      recording_state: 'held',
      recording_file: 'rec-3.wav',
    });
  });

  it('updates presence, call state and registration from the mapping', async () => {
    await ingest({ type: 30009, msg: { extension: '1001', status: 'away' } });
    await ingest({
      type: 30008,
      msg: { extension: '1001', status: 'ringing' },
    });
    await ingest({ type: 30008, msg: { extension: '1003', status: 'busy' } });
    await ingest({
      type: 30007,
      msg: { extension: '1002', status: 'registered', kind: 'mobile' },
    });
    expect(fake.tables.pbx_presence).toEqual([
      expect.objectContaining({
        extension: '1001',
        account_id: A2,
        user_id: 'u1',
        presence: 'away',
        call_state: 'ringing',
      }),
    ]);
    expect(fake.tables.pbx_extensions[1]).toMatchObject({
      registration_state: 'registered',
      client_kind: 'mobile',
    });
  });

  it('records a bad event instead of throwing', async () => {
    const r = await ingest('not json');
    expect(r).toMatchObject({ duplicate: false, error: 'frame is not JSON' });
    expect(fake.tables.pbx_events_raw[0]).toMatchObject({
      error: 'frame is not JSON',
      event_type: null,
    });
    expect(fake.tables.pbx_events_raw[0].processed_at).toBeUndefined();
  });
});
