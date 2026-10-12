import { afterEach, describe, expect, it, vi } from 'vitest';
import { newFile } from '../engine';
import type { Action } from '../types';
import { fakeDb } from './fake-db';
import {
  JourneyDbError,
  SupabaseJourneyStore,
  ensureOpenFile,
  rpcScalar,
} from './store';

const FILE = newFile({ id: 'f1', contactId: 'c1', workspaceId: 'a1' });
const DENIED = { message: 'permission denied for table x', code: '42501' };

/** Expects `p` to reject with a JourneyDbError for `source` carrying `err`. */
async function rejectsWith(
  p: Promise<unknown>,
  source: string,
  err: { message: string; code: string }
) {
  const e = await p.then(
    () => expect.fail('expected a rejection'),
    (x: unknown) => x
  );
  expect(e).toBeInstanceOf(JourneyDbError);
  expect(e).toMatchObject({ source, code: err.code, cause: err });
  expect((e as Error).message).toContain(source);
  expect((e as Error).message).toContain(err.message);
  expect((e as Error).message).toContain(err.code);
}

describe('rpcScalar (one-row unwrapping)', () => {
  it('takes a bare value, a one-element array, a one-key object named after the function, or both', () => {
    for (const data of [
      'ok',
      ['ok'],
      { journey_commit: 'ok' },
      [{ journey_commit: 'ok' }],
    ])
      expect(rpcScalar('journey_commit', data)).toBe('ok');
    expect(rpcScalar('f', null)).toBeNull();
    expect(rpcScalar('f', [false])).toBe(false);
    expect(rpcScalar('f', { f: null })).toBeNull();
  });

  it('leaves every other shape as it is', () => {
    for (const data of [
      [],
      ['ok', 'ok'],
      { other: 'ok' },
      { journey_commit: 'ok', extra: 1 },
    ])
      expect(rpcScalar('journey_commit', data)).toEqual(data);
  });
});

describe('SupabaseJourneyStore.load', () => {
  it('selects body and version by id; the version column overrides body.version', async () => {
    const { db, queries } = fakeDb({
      data: { body: { ...FILE, version: 3, state: 'S_MENU' }, version: 7 },
    });
    const file = await new SupabaseJourneyStore(db).load('f1');
    expect(file).toEqual({ ...FILE, state: 'S_MENU', version: 7 });
    expect(queries).toEqual([
      [
        ['from', 'journey_files'],
        ['select', 'body, version'],
        ['eq', 'id', 'f1'],
        ['maybeSingle'],
      ],
    ]);
  });

  it('is null for a missing file, and throws a select error', async () => {
    expect(await new SupabaseJourneyStore(fakeDb().db).load('f9')).toBeNull();
    await rejectsWith(
      new SupabaseJourneyStore(fakeDb({ error: DENIED }).db).load('f1'),
      'journey_files',
      DENIED
    );
  });
});

describe('SupabaseJourneyStore.commit', () => {
  const actions: Action[] = [
    {
      type: 'SEND',
      template: 'welcome_menu',
      category: 'SESSION',
      billable: false,
    },
    { type: 'SET_OPT_OUT', optedOut: true },
  ];

  it('calls journey_commit with exactly the five arguments', async () => {
    const { db, queries } = fakeDb({ data: 'ok' });
    const after = { ...FILE, state: 'S_MENU' };
    expect(
      await new SupabaseJourneyStore(db).commit(4, after, 'wamid.1', actions)
    ).toBe('ok');
    expect(queries).toEqual([
      [
        [
          'rpc',
          'journey_commit',
          {
            p_file_id: 'f1',
            p_expected_version: 4,
            p_file: after,
            p_event_id: 'wamid.1',
            p_actions: actions,
          },
        ],
        ['await'],
      ],
    ]);
  });

  it('returns each of the three results, in any PostgREST shape', async () => {
    const cases: [unknown, string][] = [
      ['duplicate', 'duplicate'],
      [['conflict'], 'conflict'],
      [{ journey_commit: 'ok' }, 'ok'],
      [[{ journey_commit: 'duplicate' }], 'duplicate'],
    ];
    for (const [data, want] of cases) {
      const store = new SupabaseJourneyStore(fakeDb({ data }).db);
      expect(await store.commit(0, FILE, 'e', [])).toBe(want);
    }
  });

  it('throws on any other result', async () => {
    for (const data of ['OK', null, true, ['ok', 'ok'], { other: 'ok' }]) {
      const store = new SupabaseJourneyStore(fakeDb({ data }).db);
      await expect(store.commit(0, FILE, 'e', [])).rejects.toThrow(
        /journey_commit: unexpected result/
      );
    }
  });

  it('throws the RPC error with its message and code', async () => {
    const err = {
      message: 'journey_commit: malformed arguments',
      code: '22023',
    };
    await rejectsWith(
      new SupabaseJourneyStore(fakeDb({ error: err }).db).commit(
        0,
        FILE,
        'e',
        []
      ),
      'journey_commit',
      err
    );
  });
});

describe('SupabaseJourneyStore outbox', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pendingOutbox: the file’s pending rows, camelCased; dropReason only when set', async () => {
    const send: Action = {
      type: 'SEND',
      template: 'welcome_menu',
      category: 'SESSION',
      billable: false,
    };
    const { db, queries } = fakeDb({
      data: [
        {
          id: 'o1',
          file_id: 'f1',
          seq: 1,
          action: send,
          status: 'pending',
          drop_reason: null,
        },
        {
          id: 'o2',
          file_id: 'f1',
          seq: 2,
          action: send,
          status: 'pending',
          drop_reason: 'X',
        },
      ],
    });
    const items = await new SupabaseJourneyStore(db).pendingOutbox('f1');
    expect(items).toEqual([
      { id: 'o1', fileId: 'f1', seq: 1, action: send, status: 'pending' },
      {
        id: 'o2',
        fileId: 'f1',
        seq: 2,
        action: send,
        status: 'pending',
        dropReason: 'X',
      },
    ]);
    expect('dropReason' in items[0]!).toBe(false);
    expect(queries).toEqual([
      [
        ['from', 'journey_outbox'],
        ['select', 'id, file_id, seq, action, status, drop_reason'],
        ['eq', 'file_id', 'f1'],
        ['eq', 'status', 'pending'],
        ['await'],
      ],
    ]);
  });

  it('pendingOutbox throws a select error', async () => {
    await rejectsWith(
      new SupabaseJourneyStore(fakeDb({ error: DENIED }).db).pendingOutbox(
        'f1'
      ),
      'journey_outbox',
      DENIED
    );
  });

  it('markDelivered stamps delivered_at, on a pending row only', async () => {
    vi.useFakeTimers({
      now: new Date('2026-03-01T06:00:00.000Z'),
      toFake: ['Date'],
    });
    const { db, queries } = fakeDb();
    await new SupabaseJourneyStore(db).markDelivered('o1');
    expect(queries).toEqual([
      [
        ['from', 'journey_outbox'],
        [
          'update',
          { status: 'delivered', delivered_at: '2026-03-01T06:00:00.000Z' },
        ],
        ['eq', 'id', 'o1'],
        ['eq', 'status', 'pending'],
        ['await'],
      ],
    ]);
  });

  it('markDropped records the reason, on a pending row only', async () => {
    const { db, queries } = fakeDb();
    await new SupabaseJourneyStore(db).markDropped('o2', 'OPTED_OUT');
    expect(queries).toEqual([
      [
        ['from', 'journey_outbox'],
        ['update', { status: 'dropped', drop_reason: 'OPTED_OUT' }],
        ['eq', 'id', 'o2'],
        ['eq', 'status', 'pending'],
        ['await'],
      ],
    ]);
  });

  it('markDelivered / markDropped throw an update error', async () => {
    await rejectsWith(
      new SupabaseJourneyStore(fakeDb({ error: DENIED }).db).markDelivered(
        'o1'
      ),
      'journey_outbox',
      DENIED
    );
    await rejectsWith(
      new SupabaseJourneyStore(fakeDb({ error: DENIED }).db).markDropped(
        'o1',
        'X'
      ),
      'journey_outbox',
      DENIED
    );
  });
});

describe('SupabaseJourneyStore.pendingOptOut', () => {
  it('calls journey_pending_opt_out with the contact id', async () => {
    const { db, queries } = fakeDb({ data: true });
    expect(await new SupabaseJourneyStore(db).pendingOptOut('c1')).toBe(true);
    expect(queries).toEqual([
      [['rpc', 'journey_pending_opt_out', { p_contact_id: 'c1' }], ['await']],
    ]);
  });

  it('unwraps every shape to true / false / null, and throws on anything else', async () => {
    const cases: [unknown, boolean | null][] = [
      [[false], false],
      [{ journey_pending_opt_out: true }, true],
      [[{ journey_pending_opt_out: null }], null],
      [null, null],
    ];
    for (const [data, want] of cases)
      expect(
        await new SupabaseJourneyStore(fakeDb({ data }).db).pendingOptOut('c1')
      ).toBe(want);
    await expect(
      new SupabaseJourneyStore(fakeDb({ data: 'yes' }).db).pendingOptOut('c1')
    ).rejects.toThrow(/journey_pending_opt_out: unexpected result/);
    await rejectsWith(
      new SupabaseJourneyStore(fakeDb({ error: DENIED }).db).pendingOptOut(
        'c1'
      ),
      'journey_pending_opt_out',
      DENIED
    );
  });
});

describe('ensureOpenFile', () => {
  const INIT = { accountId: 'a1', contactId: 'c1', workflowKey: 'wf.v1' };
  const SELECT_OPEN = [
    ['from', 'journey_files'],
    ['select', 'id'],
    ['eq', 'account_id', 'a1'],
    ['eq', 'contact_id', 'c1'],
    ['is', 'closed_at', null],
    ['maybeSingle'],
  ];

  it('returns the open file’s id without inserting', async () => {
    const { db, queries } = fakeDb({ data: { id: 'f-open' } });
    expect(await ensureOpenFile(db, INIT)).toBe('f-open');
    expect(queries).toEqual([SELECT_OPEN]);
  });

  it('creates the engine’s newFile at version 0 when none is open', async () => {
    const { db, queries } = fakeDb({ data: null }, { error: null });
    const id = await ensureOpenFile(db, { ...INIT, conversationId: 'conv-1' });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual([
      ['from', 'journey_files'],
      [
        'insert',
        {
          id,
          account_id: 'a1',
          contact_id: 'c1',
          conversation_id: 'conv-1',
          workflow_key: 'wf.v1',
          product: null,
          entry: null,
          state: 'NEW',
          body: newFile({ id, contactId: 'c1', workspaceId: 'a1' }),
          version: 0,
        },
      ],
      ['await'],
    ]);
  });

  it('writes a NULL conversation_id when none is given', async () => {
    const { db, queries } = fakeDb({ data: null });
    await ensureOpenFile(db, INIT);
    expect(queries[1]![1]![1]).toMatchObject({ conversation_id: null });
  });

  it('a racing insert (23505) answers with the winner’s id', async () => {
    const race = { message: 'duplicate key value', code: '23505' };
    const { db, queries } = fakeDb(
      { data: null },
      { error: race },
      { data: { id: 'f-winner' } }
    );
    expect(await ensureOpenFile(db, INIT)).toBe('f-winner');
    expect(queries).toHaveLength(3);
    expect(queries[2]).toEqual(SELECT_OPEN);
  });

  it('throws the original 23505 when no winner is found', async () => {
    const race = { message: 'duplicate key value', code: '23505' };
    await rejectsWith(
      ensureOpenFile(
        fakeDb({ data: null }, { error: race }, { data: null }).db,
        INIT
      ),
      'journey_files',
      race
    );
  });

  it('throws any other insert error without re-selecting, and a select error', async () => {
    const fk = { message: 'violates foreign key constraint', code: '23503' };
    const { db, queries } = fakeDb({ data: null }, { error: fk });
    await rejectsWith(ensureOpenFile(db, INIT), 'journey_files', fk);
    expect(queries).toHaveLength(2);
    await rejectsWith(
      ensureOpenFile(fakeDb({ error: DENIED }).db, INIT),
      'journey_files',
      DENIED
    );
  });
});
