import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Group traffic through the Whapi webhook (migration 114), against an
 * in-memory stand-in for the service-role client. The inbox pipeline
 * is a spy: group traffic must never reach it.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  SECRET: 'b'.repeat(64),
  db: {} as Record<string, Row[]>,
  tablesTouched: [] as string[],
  failUpsertOn: null as string | null,
  afterCallbacks: [] as (() => Promise<void> | void)[],
  screenWebhook: vi.fn(),
  confirmAccepted: vi.fn(),
  processMessage: vi.fn(),
  handleStatusUpdate: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  persistGroupSnapshot: vi.fn(),
  rpc: vi.fn(),
}));

let seq = 0;
function query(table: string) {
  const rows = (h.db[table] ??= []);
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'update' | 'delete' | 'upsert' = 'select';
  let payload: Row | Row[] = {};
  let opts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  const run = () => {
    if (op === 'upsert' && h.failUpsertOn === table) {
      return { data: null, error: { message: 'boom' } };
    }
    const match = (r: Row) => filters.every((f) => f(r));
    if (op === 'select') return { data: rows.filter(match), error: null };
    if (op === 'update') {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, payload);
      return { data: hit, error: null };
    }
    if (op === 'delete') {
      const hit = rows.filter(match);
      h.db[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    const keys = (opts.onConflict ?? '').split(',');
    const inserted: Row[] = [];
    for (const row of Array.isArray(payload) ? payload : [payload]) {
      const existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
      if (existing) {
        if (!opts.ignoreDuplicates) Object.assign(existing, row);
        continue;
      }
      const next = { id: `${table}-${++seq}`, ...row };
      rows.push(next);
      inserted.push(next);
    }
    return { data: inserted, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, vs: unknown[]) => (
      filters.push((r) => vs.includes(r[c])),
      b
    ),
    update: (p: Row) => ((op = 'update'), (payload = p), b),
    delete: () => ((op = 'delete'), b),
    upsert: (p: Row | Row[], o: typeof opts) => (
      (op = 'upsert'),
      (payload = p),
      (opts = o),
      b
    ),
    maybeSingle: () =>
      Promise.resolve(run()).then((r) => ({
        data: (r.data as Row[] | null)?.[0] ?? null,
        error: r.error,
      })),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(res, rej),
  };
  return b;
}

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      h.tablesTouched.push(table);
      return query(table);
    },
    rpc: (fn: string, args: Row) => h.rpc(fn, args),
  }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/edge', () => ({
  clientIp: () => '203.0.113.7',
  screenWebhook: h.screenWebhook,
  confirmAccepted: h.confirmAccepted,
  ReplayGuard: class {},
  RateLimiter: class {},
  RpcSeenStore: class {},
  RpcRateStore: class {},
}));
vi.mock('@/lib/whatsapp/inbound-pipeline', () => ({
  processMessage: h.processMessage,
  handleStatusUpdate: h.handleStatusUpdate,
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}));
vi.mock('@/lib/groups/server', () => ({
  persistGroupSnapshot: h.persistGroupSnapshot,
}));

import { POST } from './route';

const GROUP = '120363025555555555@g.us';
const OTHER_GROUP = '120363029999999999@g.us';
const OUR_NUMBER = '15551230000';

type Outcome = 'accept' | 'duplicate' | 'ip_limited';
function screenAs(outcomeOf: (key: string) => Outcome = () => 'accept') {
  h.screenWebhook.mockImplementation(
    async (_ctx: unknown, input: { events: { key: string }[] }) => ({
      status: 200,
      decisions: input.events.map((e) => ({
        key: e.key,
        outcome: outcomeOf(e.key),
      })),
    })
  );
}

async function post(body: Record<string, unknown>) {
  h.afterCallbacks = [];
  const res = await POST({
    url: `https://crm.test/api/whatsapp/webhook?secret=${h.SECRET}`,
    json: async () => ({ channel_id: 'CHANNEL-1', ...body }),
    headers: { get: () => null },
  } as unknown as Request);
  for (const cb of h.afterCallbacks) await cb();
  return res;
}

function groupText(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    from_me: false,
    type: 'text',
    chat_id: GROUP,
    from: '971501234567',
    from_name: 'Ada',
    timestamp: 1700000000,
    text: { body: 'hello group' },
    ...extra,
  };
}

const messages = (...m: Record<string, unknown>[]) => ({
  messages: m,
  event: { type: 'messages', event: 'post' },
});

const groupRow = () => h.db.whatsapp_groups[0];
const groupMessages = () => h.db.whatsapp_group_messages ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  h.failUpsertOn = null;
  h.tablesTouched = [];
  h.db = {
    whatsapp_config: [
      {
        id: 'cfg-1',
        account_id: 'acc-1',
        user_id: 'user-1',
        provider: 'whapi',
        phone_number_id: 'CHANNEL-1',
        waba_id: OUR_NUMBER,
        access_token: 'enc:token',
        verify_token: `enc:${h.SECRET}`,
        is_primary: true,
        status: 'connected',
      },
    ],
    whatsapp_groups: [
      {
        id: 'grp-1',
        account_id: 'acc-1',
        channel_id: 'cfg-1',
        wa_group_id: GROUP,
        name: 'Deals',
        our_role: 'admin',
        participants_count: 2,
        settings: { send_messages: 'anyone' },
      },
      // Same WhatsApp id on another account's number: never touched.
      {
        id: 'grp-x',
        account_id: 'acc-2',
        channel_id: 'cfg-2',
        wa_group_id: OTHER_GROUP,
        name: 'Elsewhere',
        our_role: 'member',
        participants_count: 9,
        settings: {},
      },
    ],
    whatsapp_group_participants: [
      {
        group_id: 'grp-1',
        account_id: 'acc-1',
        wa_id: OUR_NUMBER,
        role: 'admin',
      },
      {
        group_id: 'grp-1',
        account_id: 'acc-1',
        wa_id: '971500000001',
        role: 'member',
      },
    ],
    whatsapp_group_messages: [],
  };
  screenAs();
  h.rpc.mockResolvedValue({ data: null, error: null });
  h.confirmAccepted.mockResolvedValue({ unconfirmed: [] });
  h.processMessage.mockResolvedValue(undefined);
  h.handleStatusUpdate.mockResolvedValue(undefined);
  h.persistGroupSnapshot.mockResolvedValue({
    id: 'grp-new',
    our_role: 'admin',
    participants_count: 1,
    settings: {},
  });
});

describe('Whapi webhook: group messages', () => {
  it('stores a group message in whatsapp_group_messages only, never the inbox pipeline', async () => {
    const res = await post(messages(groupText('g-1')));
    expect((res as unknown as { init: { status: number } }).init.status).toBe(
      200
    );
    expect(groupMessages()).toEqual([
      expect.objectContaining({
        account_id: 'acc-1',
        group_id: 'grp-1',
        wa_message_id: 'g-1',
        direction: 'in',
        sender_wa_id: '971501234567',
        sender_name: 'Ada',
        type: 'text',
        body: 'hello group',
        created_at: new Date(1700000000 * 1000).toISOString(),
      }),
    ]);
    expect(h.processMessage).not.toHaveBeenCalled();
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.tablesTouched).not.toContain('messages');
    expect(h.tablesTouched).not.toContain('conversations');
    expect(h.tablesTouched).not.toContain('contacts');
  });

  it('hands a 1:1 message in the same delivery to the pipeline, alone', async () => {
    await post(
      messages(groupText('g-1'), {
        id: 'p-1',
        type: 'text',
        chat_id: '971501234567@s.whatsapp.net',
        from: '971501234567',
        text: { body: 'hi' },
      })
    );
    expect(h.processMessage).toHaveBeenCalledTimes(1);
    expect(h.processMessage.mock.calls[0][0]).toMatchObject({ id: 'p-1' });
    expect(groupMessages()).toHaveLength(1);
  });

  it('records our own send from the phone as outbound', async () => {
    await post(messages(groupText('g-2', { from_me: true, from: OUR_NUMBER })));
    expect(groupMessages()[0]).toMatchObject({ direction: 'out' });
  });

  it('a redelivery is a no-op', async () => {
    await post(messages(groupText('g-1')));
    await post(messages(groupText('g-1', { text: { body: 'changed' } })));
    expect(groupMessages()).toHaveLength(1);
    expect(groupMessages()[0].body).toBe('hello group');
  });

  it('ignores a group this number does not know, even one of another account', async () => {
    await post(
      messages(
        groupText('g-3', { chat_id: '120363021111111111@g.us' }),
        groupText('g-4', { chat_id: OTHER_GROUP })
      )
    );
    expect(groupMessages()).toEqual([]);
  });

  it('screens each group message by the config row, and skips a duplicate', async () => {
    screenAs((key) => (key.endsWith(':g-dup') ? 'duplicate' : 'accept'));
    await post(messages(groupText('g-dup'), groupText('g-5')));
    const keys = h.screenWebhook.mock.calls[0][1].events.map(
      (e: { key: string }) => e.key
    );
    expect(keys).toEqual(['whapi:group:cfg-1:g-dup', 'whapi:group:cfg-1:g-5']);
    expect(groupMessages().map((r) => r.wa_message_id)).toEqual(['g-5']);
    expect(h.confirmAccepted).toHaveBeenCalledTimes(1);
  });

  it('leaves the group claims unconfirmed when the write fails, without throwing', async () => {
    h.failUpsertOn = 'whatsapp_group_messages';
    await post(messages(groupText('g-6')));
    const confirmed = h.confirmAccepted.mock.calls[0][1] as { key: string }[];
    expect(confirmed.map((d) => d.key)).toEqual([]);
  });
});

describe('Whapi webhook: submission groups (018a)', () => {
  const SG_GROUP = '120363027777777777@g.us';
  const sgCalls = () =>
    h.rpc.mock.calls.filter((c) => c[0] === 'sg_record_inbound');

  beforeEach(() => {
    h.db.submission_groups = [
      {
        id: 'sg-1',
        account_id: 'acc-1',
        channel_id: 'cfg-1',
        wa_group_id: SG_GROUP,
        contact_id: 'contact-1',
        submission_ref: 'S-1',
        subject: 'S-1',
        coordinator_phone: null,
        status: 'ACTIVE',
        created_at: '2026-10-16T00:00:00Z',
        last_activity_at: '2026-10-16T00:00:00Z',
      },
    ];
    h.db.contacts = [{ id: 'contact-1', phone: '+971 50 123 4567' }];
  });

  it('records a submission-group message through sg_record_inbound, not as a 114 group row', async () => {
    h.rpc.mockResolvedValue({ data: true, error: null });
    await post(
      messages(groupText('g-1'), groupText('s-1', { chat_id: SG_GROUP }))
    );
    expect(sgCalls()).toEqual([
      [
        'sg_record_inbound',
        expect.objectContaining({
          p_group: 'sg-1',
          p_wa_message_id: 's-1',
          p_sender_wa_id: '971501234567',
          p_sender_kind: 'customer',
          p_type: 'text',
          p_body: 'hello group',
        }),
      ],
    ]);
    expect(groupMessages().map((r) => r.wa_message_id)).toEqual(['g-1']);
  });

  it('a submission-group failure leaves the 114 path and the 1:1 pipeline untouched, and its claim unconfirmed', async () => {
    h.rpc.mockImplementation(async (fn: string) =>
      fn === 'sg_record_inbound'
        ? { data: null, error: { message: 'boom' } }
        : { data: null, error: null }
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(
      messages(groupText('g-1'), groupText('s-1', { chat_id: SG_GROUP }), {
        id: 'p-1',
        type: 'text',
        chat_id: '971501234567@s.whatsapp.net',
        from: '971501234567',
        text: { body: 'hi' },
      })
    );
    err.mockRestore();
    expect((res as unknown as { init: { status: number } }).init.status).toBe(
      200
    );
    expect(sgCalls()).toHaveLength(1);
    expect(groupMessages().map((r) => r.wa_message_id)).toEqual(['g-1']);
    expect(h.processMessage).toHaveBeenCalledTimes(1);
    // The group claims stay unconfirmed so Whapi's redelivery records the
    // submission-group message (both group writes are idempotent).
    const confirmed = h.confirmAccepted.mock.calls[0][1] as { key: string }[];
    expect(confirmed.map((d) => d.key)).not.toEqual(
      expect.arrayContaining(['whapi:group:cfg-1:s-1'])
    );
    expect(confirmed.length).toBeGreaterThan(0);
  });
});

describe('Whapi webhook: receipts for group sends', () => {
  beforeEach(() => {
    h.db.whatsapp_group_messages.push(
      {
        id: 'gm-1',
        account_id: 'acc-1',
        group_id: 'grp-1',
        wa_message_id: 'out-1',
        direction: 'out',
        status: 'sent',
      },
      {
        id: 'gm-x',
        account_id: 'acc-2',
        group_id: 'grp-x',
        wa_message_id: 'out-1',
        direction: 'out',
        status: 'sent',
      }
    );
  });
  const receipt = (status: string) => ({
    statuses: [{ id: 'out-1', status, recipient_id: GROUP, timestamp: 1 }],
    event: { type: 'statuses', event: 'post' },
  });
  const row = (id: string) =>
    h.db.whatsapp_group_messages.find((r) => r.id === id);

  it('moves forward only, within this account', async () => {
    await post(receipt('delivered'));
    expect(row('gm-1')?.status).toBe('delivered');
    expect(row('gm-x')?.status).toBe('sent');
    await post(receipt('sent'));
    expect(row('gm-1')?.status).toBe('delivered');
    await post(receipt('failed'));
    expect(row('gm-1')?.status).toBe('delivered');
    await post(receipt('read'));
    expect(row('gm-1')?.status).toBe('read');
    // The 1:1 handler still sees every receipt (it matches nothing here).
    expect(h.handleStatusUpdate).toHaveBeenCalledTimes(4);
  });

  it('accepts failed from sent', async () => {
    await post(receipt('failed'));
    expect(row('gm-1')?.status).toBe('failed');
  });
});

describe('Whapi webhook: groups events', () => {
  const groupsEvent = (payload: Record<string, unknown>, method = 'put') => ({
    event: { type: 'groups', event: method },
    ...payload,
  });

  it('applies an add and a promote to the participants', async () => {
    await post(
      groupsEvent({
        groups_participants: [
          {
            group_id: GROUP,
            action: 'add',
            participants: ['971500000002@s.whatsapp.net'],
          },
          {
            group_id: GROUP,
            action: 'promote',
            participants: ['971500000001'],
          },
        ],
      })
    );
    const people = h.db.whatsapp_group_participants;
    expect(people.find((p) => p.wa_id === '971500000002')).toMatchObject({
      group_id: 'grp-1',
      account_id: 'acc-1',
      role: 'member',
    });
    expect(people.find((p) => p.wa_id === '971500000001')?.role).toBe('admin');
    expect(groupRow().participants_count).toBe(3);
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('marks the group left when our number is removed', async () => {
    await post(
      groupsEvent({
        groups_participants: [
          { group_id: GROUP, action: 'remove', participants: [OUR_NUMBER] },
        ],
      })
    );
    expect(groupRow()).toMatchObject({
      our_role: 'left',
      participants_count: 1,
    });
    expect(
      h.db.whatsapp_group_participants.some((p) => p.wa_id === OUR_NUMBER)
    ).toBe(false);
  });

  it('ignores participants of an unknown group', async () => {
    await post(
      groupsEvent({
        groups_participants: [
          {
            group_id: OTHER_GROUP,
            action: 'remove',
            participants: ['971500000009'],
          },
        ],
      })
    );
    expect(h.db.whatsapp_groups[1]).toMatchObject({ participants_count: 9 });
  });

  it('patches the name and merges a setting', async () => {
    const base = {
      id: GROUP,
      name: 'Deals',
      announcements: false,
      participants: [],
    };
    await post(
      groupsEvent(
        {
          groups_updates: [
            {
              before_update: base,
              after_update: { ...base, name: 'Deals 2', announcements: true },
            },
          ],
        },
        'patch'
      )
    );
    expect(groupRow()).toMatchObject({
      name: 'Deals 2',
      settings: { send_messages: 'admins' },
    });
  });

  it('snapshots a known group, and a new one only when our number created it', async () => {
    await post(
      groupsEvent(
        {
          groups: [
            { id: GROUP, name: 'Deals', participants: [] },
            {
              id: '120363027777777777@g.us',
              name: 'From the phone',
              created_by: `${OUR_NUMBER}@s.whatsapp.net`,
              participants: [],
            },
            {
              id: '120363028888888888@g.us',
              name: 'Someone else’s',
              created_by: '971509999999@s.whatsapp.net',
              participants: [],
            },
          ],
        },
        'post'
      )
    );
    const ids = h.persistGroupSnapshot.mock.calls.map(
      (c) => (c[2] as { id: string }).id
    );
    expect(ids).toEqual([GROUP, '120363027777777777@g.us']);
    expect(h.persistGroupSnapshot.mock.calls[0][1]).toEqual({
      id: 'cfg-1',
      accountId: 'acc-1',
      wabaId: OUR_NUMBER,
    });
    // Never stamps a creator: such a group is unowned.
    expect(h.persistGroupSnapshot.mock.calls[1][3]).toBeUndefined();
  });

  it('keeps going when one event fails', async () => {
    h.persistGroupSnapshot.mockRejectedValueOnce(new Error('boom'));
    await post({
      event: { type: 'groups', event: 'post' },
      groups: [{ id: GROUP, name: 'Deals', participants: [] }],
      groups_participants: [
        { group_id: GROUP, action: 'promote', participants: ['971500000001'] },
      ],
    });
    expect(
      h.db.whatsapp_group_participants.find((p) => p.wa_id === '971500000001')
        ?.role
    ).toBe('admin');
  });
});
