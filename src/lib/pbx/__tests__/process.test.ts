import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  fake = createFakeDb({
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
  });
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
