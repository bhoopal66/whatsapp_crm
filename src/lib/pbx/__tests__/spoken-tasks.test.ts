import { beforeEach, describe, expect, it, vi } from 'vitest';

import { closeSystemTasks } from '@/lib/tasks/system';

import { ingestPbxEvent } from '../process';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

// A later call with the customer closes their missed-call tasks.

const A = 'acc';
const NOW = '2026-10-12T10:30:00.000Z';
let fake: FakeDb;

/** A 30012. The call starts 14:05 in Dubai, 10:05 UTC, unless told. */
const end = (callId: string, extra: Row = {}) => ({
  type: 30012,
  sn: 'SN1',
  msg: {
    call_id: callId,
    uid: `uid-${callId}`,
    type: 'Outbound',
    call_from: '1001',
    call_to: '0501234567',
    time_start: '2026-10-12 14:05:00',
    call_duration: 70,
    talk_duration: 60,
    status: 'ANSWERED',
    ...extra,
  },
});
const inbound = (extra: Row = {}) => ({
  type: 'Inbound',
  call_from: '0501234567',
  call_to: '1001',
  ...extra,
});
const ingest = (payload: unknown, o: { historical?: boolean } = {}) =>
  ingestPbxEvent({
    db: fake.db,
    connectionId: 'c1',
    payload,
    receivedAt: NOW,
    ...o,
  });
const task = (p: Row = {}): Row => ({
  id: 't1',
  account_id: A,
  source: 'pbx',
  kind: 'missed_call',
  status: 'open',
  assigned_to: 'u2',
  contact_id: 'k1',
  note: 'Missed call (no answer)',
  source_ref: 'call:m1',
  created_at: '2026-10-12T09:00:30.000Z',
  updated_at: '2026-10-12T09:00:30.000Z',
  meta: { call_id: 'm1', call_ids: ['m1'], remote_number: '971501234567' },
  ...p,
});
const statusOf = (id = 't1') =>
  fake.tables.tasks.find((t) => t.id === id)?.status;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = createFakeDb(
    {
      pbx_connections: [{ id: 'c1', account_id: A, status: 'ok' }],
      pbx_extensions: [
        {
          connection_id: 'c1',
          extension: '1001',
          account_id: A,
          user_id: 'u1',
        },
        {
          connection_id: 'c1',
          extension: '1009',
          account_id: A,
          user_id: null,
        },
      ],
      contacts: [
        {
          id: 'k1',
          account_id: A,
          name: 'Ahmed',
          phone: '971501234567',
          phone_normalized: '971501234567',
          user_id: null,
        },
      ],
      profiles: [
        {
          user_id: 'u1',
          account_id: A,
          full_name: 'Sara',
          account_role: 'agent',
          deactivated_at: null,
        },
      ],
      calls: [
        {
          id: 'm1',
          account_id: A,
          connection_id: 'c1',
          pbx_call_id: 'm1',
          started_at: '2026-10-12T09:00:00.000Z',
        },
      ],
      tasks: [task()],
    },
    {},
    { calls: { updated_at: '1' } }
  );
});

describe('speaking to the customer closes their missed-call task', () => {
  it('a call back they picked up, whoever holds the task, with who and when', async () => {
    await ingest(end('call-1'));
    const row = fake.tables.calls.find((c) => c.pbx_call_id === 'call-1');
    expect(fake.tables.tasks).toEqual([
      expect.objectContaining({
        status: 'done',
        assigned_to: 'u2',
        note: 'Spoke at 14:05 (Sara)\nMissed call (no answer)',
        meta: expect.objectContaining({
          call_ids: ['m1'],
          spoke_call_id: row?.id,
          spoke_user_id: 'u1',
        }),
      }),
    ]);
    // Redelivered under another hash: nothing left to close or say.
    await ingest({ ...end('call-1'), sn: 'SN-again' });
    expect(fake.tables.tasks[0].note).toBe(
      'Spoke at 14:05 (Sara)\nMissed call (no answer)'
    );
  });

  it('their next call, answered; an unmapped extension is named by number', async () => {
    await ingest(end('call-1', inbound({ call_to: '1009' })));
    expect(fake.tables.tasks[0]).toMatchObject({
      status: 'done',
      note: expect.stringContaining('(ext. 1009)'),
    });
  });

  it('matches the number when no contact is known, and no other number', async () => {
    const other = { remote_number: '971509999999', call_ids: ['m1'] };
    fake.tables.contacts.length = 0;
    fake.tables.tasks = [
      task({ contact_id: null }),
      task({ id: 't2', contact_id: null, source_ref: 'call:m2', meta: other }),
    ];
    await ingest(end('call-1'));
    expect([statusOf('t1'), statusOf('t2')]).toEqual(['done', 'open']);
  });

  it('a contact made since takes the number’s task, not another contact’s', async () => {
    fake.tables.tasks = [
      task({ contact_id: null }),
      task({ id: 't2', contact_id: 'k2', source_ref: 'call:m2' }),
    ];
    await ingest(end('call-1'));
    expect([statusOf('t1'), statusOf('t2')]).toEqual(['done', 'open']);
  });

  it('never a task opened after the call began, or of another account or source', async () => {
    const late = '2026-10-12T10:05:00.000Z';
    fake.tables.tasks = [
      task({ created_at: late }),
      task({ id: 't2', account_id: 'elsewhere' }),
      task({ id: 't3', source: 'automation' }),
      task({ id: 't4', kind: 'callback' }),
    ];
    await ingest(end('call-1'));
    for (const t of fake.tables.tasks) expect(t.status).toBe('open');
  });

  it('not one holding a call missed since the call began', async () => {
    fake.tables.calls.push({
      id: 'm2',
      account_id: A,
      started_at: '2026-10-12T10:05:30.000Z',
    });
    fake.tables.tasks = [task({ meta: { call_ids: ['m1', 'm2'] } })];
    await ingest(end('call-1'));
    expect(statusOf()).toBe('open');
  });

  it('one holding a later call that was answered after all', async () => {
    fake.tables.calls.push({
      id: 'm2',
      account_id: A,
      status: 'answered',
      started_at: '2026-10-12T10:05:30.000Z',
    });
    fake.tables.tasks = [task({ meta: { call_ids: ['m1', 'm2'] } })];
    await ingest(end('call-1'));
    expect(statusOf()).toBe('done');
  });

  // A ring group's legs: one extension did not pick up, the other did.
  const missedLeg = () =>
    end('call-1', inbound({ status: 'NO ANSWER', talk_duration: 0 }));
  const answeredLeg = () => end('call-1', inbound({ call_to: '1009' }));

  it('the NO ANSWER leg folded into the task first, then the ANSWERED leg', async () => {
    await ingest(missedLeg());
    expect(fake.tables.tasks).toHaveLength(1);
    expect((fake.tables.tasks[0].meta as Row).call_ids).toHaveLength(2);
    await ingest(answeredLeg());
    expect(statusOf()).toBe('done');
  });

  it('the ANSWERED leg first: the NO ANSWER leg folds and opens nothing', async () => {
    await ingest(answeredLeg());
    await ingest(missedLeg());
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.tasks[0]).toMatchObject({
      status: 'done',
      meta: { call_ids: ['m1'] },
    });
  });

  // updated_at moves on every write of a task, as tasks_guard stamps it.
  const stampTasks = () => {
    let n = 0;
    const from = fake.db.from.bind(fake.db);
    fake.db.from = ((table: string) => {
      const q = from(table);
      if (table !== 'tasks') return q;
      const update = q.update.bind(q);
      q.update = ((v: Row) =>
        update({ ...v, updated_at: `w${++n}` })) as unknown as typeof q.update;
      return q;
    }) as typeof fake.db.from;
  };
  // `run` just before the first read `hit` picks.
  const before = (
    hit: (table: string, columns: string | undefined) => boolean,
    run: () => Promise<unknown> | void
  ) => {
    const from = fake.db.from.bind(fake.db);
    let done = false;
    fake.db.from = ((table: string) => {
      const q = from(table);
      const select = q.select.bind(q);
      q.select = ((columns?: string) => {
        const s = select(columns as never);
        if (done || !hit(table, columns)) return s;
        done = true;
        const then = s.then.bind(s);
        s.then = ((ok: never, ko: never) =>
          Promise.resolve(run()).then(() =>
            then(ok, ko)
          )) as unknown as typeof s.then;
        return s;
      }) as unknown as typeof q.select;
      return q;
    }) as typeof fake.db.from;
    return () => done;
  };

  it('answered while its NO ANSWER leg reads the task to fold into', async () => {
    // A call missed since the call began keeps the task open, so only the
    // fold's own check keeps the answered call out of it.
    fake.tables.calls.push({
      id: 'm2',
      account_id: A,
      status: 'no_answer',
      started_at: '2026-10-12T10:05:30.000Z',
    });
    fake.tables.tasks = [task({ meta: { call_ids: ['m1', 'm2'] } })];
    stampTasks();
    const raced = before(
      (table, columns) =>
        table === 'tasks' && columns === 'id, assigned_to, meta, updated_at',
      () => ingest(answeredLeg())
    );
    await ingest(missedLeg());
    expect(raced()).toBe(true);
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.tasks[0]).toMatchObject({
      status: 'open',
      meta: { call_ids: ['m1', 'm2'] },
    });
  });

  it('closes the task again after the NO ANSWER leg folded in while it closed', async () => {
    stampTasks();
    const raced = before(
      (table, columns) => table === 'profiles' && columns === 'full_name',
      () => {
        const row = fake.tables.calls.find((c) => c.pbx_call_id === 'call-1');
        Object.assign(fake.tables.tasks[0], {
          meta: { call_ids: ['m1', row?.id] },
          updated_at: 'folded',
        });
      }
    );
    await ingest(end('call-1', inbound()));
    expect(raced()).toBe(true);
    expect(statusOf()).toBe('done');
  });

  it('a number several contacts share: only the task of no contact', async () => {
    fake.tables.contacts.push({
      id: 'k2',
      account_id: A,
      name: 'Aisha',
      phone: '971501234567',
      phone_normalized: '971501234567',
      user_id: null,
    });
    fake.tables.tasks = [
      task(),
      task({ id: 't2', contact_id: 'k2', source_ref: 'call:m2' }),
      task({ id: 't3', contact_id: null, source_ref: 'call:m3' }),
    ];
    await ingest(end('call-1'));
    expect(['t1', 't2', 't3'].map(statusOf)).toEqual(['open', 'open', 'done']);
  });

  it('a task a person opened again stays open when the end comes again', async () => {
    await ingest(end('call-1'));
    expect(statusOf()).toBe('done');
    fake.tables.tasks[0].status = 'open';
    await ingest({ ...end('call-1'), sn: 'SN-again' });
    expect(statusOf()).toBe('open');
    // A later call closes it.
    await ingest(end('call-2', { time_start: '2026-10-12 14:20:00' }));
    expect(statusOf()).toBe('done');
  });

  it.each([
    ['not picked up', { status: 'NO ANSWER', talk_duration: 0 }],
    ['between colleagues', { type: 'Internal', call_to: '1009' }],
    ['answered by an IVR or queue', inbound({ call_to: '6300' })],
    ['a voicemail only', inbound({ status: 'VOICEMAIL', talk_duration: 20 })],
  ])('not a call %s', async (_, extra) => {
    await ingest(end('call-1', extra));
    expect(statusOf()).toBe('open');
  });

  it('not the backfill of an old call', async () => {
    await ingest(end('call-1'), { historical: true });
    expect(statusOf()).toBe('open');
  });

  it('a failure is logged and the call stays recorded', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const from = fake.db.from.bind(fake.db);
    let closing = false;
    vi.spyOn(fake.db, 'from').mockImplementation(((table: string) => {
      if (table === 'profiles' && !closing) {
        closing = true;
        fake.fail('profiles', 'select', { message: 'down' });
      }
      return from(table);
    }) as typeof fake.db.from);
    await ingest(end('call-1'));
    expect(closing).toBe(true);
    expect(statusOf()).toBe('open');
    expect(
      fake.tables.calls.find((c) => c.pbx_call_id === 'call-1')
    ).toMatchObject({ status: 'answered' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('missed-call tasks not closed')
    );
    // Not stamped as a failed event.
    expect(
      (fake.tables.pbx_events_raw ?? []).some((e) => e.process_error)
    ).toBe(false);
  });

  it('closes nothing once the task was written since it was read', async () => {
    const close = (updatedAt: string) =>
      closeSystemTasks(
        fake.db,
        { accountId: A, source: 'pbx', sourceRef: 'call:m1' },
        { note: 'Spoke', meta: {}, updatedAt }
      );
    expect(await close('2026-10-12T09:00:00.000Z')).toBe(0);
    expect(statusOf()).toBe('open');
    expect(await close('2026-10-12T09:00:30.000Z')).toBe(1);
  });
});
