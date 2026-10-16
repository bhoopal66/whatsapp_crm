import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/submission-groups/test-db';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  admin: null as unknown,
  rls: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', async () => {
  const { SubmissionGroupStore } =
    await import('@/lib/submission-groups/store');
  return {
    supabaseAdmin: () => m.admin,
    submissionGroupStore: (c?: unknown) =>
      new SubmissionGroupStore((c ?? m.admin) as never),
  };
});

import { GET } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const ENDED_AT = '2026-10-12T00:00:00.000Z';

const groupRow = (over: Record<string, unknown> = {}) => ({
  id: G,
  account_id: 'acct-1',
  submission_ref: 'SUB-1',
  contact_id: 'c1',
  channel_id: 'w1',
  subject: 'Jane · SUB-1',
  coordinator_phone: '971509999999',
  status: 'ACTIVE',
  wa_group_id: '120363000000000001@g.us',
  invite_link: 'https://chat.whatsapp.com/CODE1',
  submission_status: 'in_review',
  created_at: '2026-10-01T10:00:00.000Z',
  last_activity_at: '2026-10-10T10:00:00.000Z',
  ended_at: null,
  end_reason: null,
  wa_create_error: null,
  wa_closed_at: null,
  wa_close_error: null,
  invite_sent_at: '2026-10-01T10:01:00.000Z',
  invite_send_error: null,
  ...over,
});

const msg = (id: number, over: Record<string, unknown>) => ({
  id,
  group_id: G,
  account_id: 'acct-1',
  direction: 'in',
  sender_user_id: null,
  sender_wa_id: '971501234567',
  sender_kind: 'customer',
  type: 'text',
  body: `m${id}`,
  prefixed_body: null,
  media: null,
  wa_message_id: `wa${id}`,
  wa_timestamp: null,
  send_status: null,
  post_end: false,
  created_at: `2026-10-10T10:0${id}:00.000Z`,
  ...over,
});

const accessRow = (user: string, label: string, removed: string | null) => ({
  group_id: G,
  account_id: 'acct-1',
  user_id: user,
  label,
  added_at: '2026-10-01T10:00:00.000Z',
  removed_at: removed,
});

let admin: FakeDb;
let rls: FakeDb;
let readable: boolean;

const get = (id = G) =>
  GET(new Request(`http://x/api/submission-groups/${id}`), {
    params: Promise.resolve({ id }),
  });

const as = (role: string, userId = 'u-me') =>
  m.getCurrentAccount.mockResolvedValue({
    userId,
    accountId: 'acct-1',
    role,
    supabase: m.rls,
  });

const messages = [
  msg(1, {}),
  msg(2, {
    direction: 'out',
    sender_user_id: 'u-me',
    sender_wa_id: null,
    sender_kind: null,
    body: 'hello',
    prefixed_body: '*Agent Me:* hello',
    send_status: 'sent',
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  readable = false;
  admin = {
    tables: {
      submission_groups: [groupRow()],
      submission_group_access: [accessRow('u-me', 'agent', null)],
      submission_group_messages: [...messages],
      profiles: [
        { user_id: 'u-me', account_id: 'acct-1', full_name: 'Me Agent' },
        { user_id: 'u-me', account_id: 'acct-2', full_name: 'Elsewhere' },
      ],
      contacts: [
        { id: 'c1', account_id: 'acct-1', name: 'Jane', phone: '9715' },
      ],
      whatsapp_config: [
        { id: 'w1', account_id: 'acct-1', label: 'Sales', waba_id: '971500' },
      ],
    },
    rpc: { sg_can_read: () => readable },
  };
  rls = {
    tables: {
      submission_groups: [groupRow()],
      submission_group_access: [accessRow('u-me', 'agent', null)],
      submission_group_messages: [
        ...messages,
        msg(3, { post_end: true, body: 'late' }),
      ],
    },
  };
  m.admin = fakeSupabase(admin);
  m.rls = fakeSupabase(rls);
  as('agent');
});

const endIt = () => {
  const ended = {
    status: 'ENDED',
    ended_at: ENDED_AT,
    end_reason: 'final_status',
  };
  admin.tables.submission_groups = [groupRow(ended)];
  admin.tables.submission_group_access = [
    accessRow('u-me', 'coordinator', ENDED_AT),
    accessRow('u-old', 'agent', '2026-10-05T00:00:00.000Z'),
  ];
  // RLS never returns an ENDED group or its rows.
  rls.tables = {};
};

describe('GET /api/submission-groups/[id]', () => {
  it('answers an ACTIVE group the caller can see, with its live messages', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group).toMatchObject({
      id: G,
      status: 'ACTIVE',
      contact: { id: 'c1', name: 'Jane', phone: '9715' },
      channel: { id: 'w1', label: 'Sales' },
      my_label: 'agent',
      pending: false,
      archive: false,
      submission_status: 'in_review',
      coordinator_phone: '971509999999',
      invite_link: 'https://chat.whatsapp.com/CODE1',
      wa_group_id: '120363000000000001@g.us',
      wa_create_error: null,
      wa_close_error: null,
      wa_closed_at: null,
      invite_sent_at: '2026-10-01T10:01:00.000Z',
      invite_send_error: null,
    });
    expect(body.access).toEqual([
      {
        user_id: 'u-me',
        name: 'Me Agent',
        label: 'agent',
        added_at: '2026-10-01T10:00:00.000Z',
      },
    ]);
    expect(body.messages.map((x: { id: string }) => x.id)).toEqual(['1', '2']);
    expect(body.messages[0]).toEqual({
      id: '1',
      direction: 'in',
      sender_user_id: null,
      sender_name: null,
      sender_wa_id: '971501234567',
      sender_kind: 'customer',
      body: 'm1',
      prefixed_body: null,
      send_status: null,
      post_end: false,
      type: 'text',
      media: null,
      created_at: '2026-10-10T10:01:00.000Z',
    });
    expect(body.messages[1]).toMatchObject({
      sender_name: 'Me Agent',
      send_status: 'sent',
    });
    expect(body).toMatchObject({
      archive_available: false,
      can_send: true,
      can_manage: false,
    });
  });

  it('answers 404 for an ACTIVE group RLS does not hand the caller', async () => {
    as('agent', 'u-other');
    rls.tables = {};
    expect((await get()).status).toBe(404);
  });

  it('lets an admin off the list read but not send', async () => {
    as('admin', 'u-admin');
    const body = await (await get()).json();
    expect(body).toMatchObject({ can_send: false, can_manage: true });
    expect(body.group.my_label).toBeNull();
  });

  it("answers 404 for another account's group and checks nothing else", async () => {
    admin.tables.submission_groups = [
      groupRow({ account_id: 'acct-2', status: 'ENDED', ended_at: ENDED_AT }),
    ];
    readable = true;
    expect((await get()).status).toBe(404);
    expect(admin.log?.some(([t]) => t === 'profiles')).toBeFalsy();
  });

  it('answers 404 for a non-uuid id without touching the database', async () => {
    expect((await get('not-a-uuid')).status).toBe(404);
    expect(admin.log).toBeUndefined();
    expect(rls.log).toBeUndefined();
  });

  it('answers an ENDED group sg_can_read allows: no messages, the list at the end', async () => {
    endIt();
    readable = true;
    const body = await (await get()).json();
    expect(body.messages).toEqual([]);
    expect(body.archive_available).toBe(true);
    expect(body.can_send).toBe(false);
    expect(body.group).toMatchObject({
      status: 'ENDED',
      archive: true,
      ended_at: ENDED_AT,
      end_reason: 'final_status',
      my_label: 'coordinator',
    });
    expect(body.access.map((a: { user_id: string }) => a.user_id)).toEqual([
      'u-me',
    ]);
    expect(
      admin.log?.some(([t]) => t === 'submission_group_messages')
    ).toBeFalsy();
  });

  it('answers 404 for an ENDED group sg_can_read refuses', async () => {
    endIt();
    readable = false;
    expect((await get()).status).toBe(404);
  });

  it('answers a group whose number and contact were deleted', async () => {
    admin.tables.submission_groups = [
      groupRow({ channel_id: null, contact_id: null }),
    ];
    rls.tables.submission_groups = [
      groupRow({ channel_id: null, contact_id: null }),
    ];
    const body = await (await get()).json();
    expect(body.group).toMatchObject({ contact: null, channel: null });
  });
});
