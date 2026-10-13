import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ createGroup: vi.fn(), metaChannel: vi.fn() }));
vi.mock('@/lib/whatsapp/meta-groups', () => ({ createGroup: h.createGroup }));
vi.mock('./shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shared')>()),
  metaChannel: h.metaChannel,
}));

import { ChannelError } from '@/lib/whatsapp/channels';

import { createDealRoom, parseCreateBody } from './create';
import { memoryDb } from './test-db';

const parsed = parseCreateBody({
  contactId: 'contact-1',
  subject: 'Deal 42',
  participants: [
    { displayName: 'Aisha', phone: '971500000001', role: 'customer' },
  ],
  consent: { textVersion: 'v1', consentText: 'I agree', method: 'verbal' },
});
if (!parsed.ok) throw new Error(parsed.error);
const INPUT = parsed.value;

function setup(
  create: { data?: unknown; error?: { code?: string; message: string } } = {},
  /** What `deal_room_fail_creation` answers: false once it was cancelled. */
  failed = true
) {
  const admin = memoryDb(
    {
      deal_rooms: [
        {
          id: 'room-1',
          channel_id: 'chan-1',
          created_by: 'user-1',
          subject: 'Deal 42',
          description: null,
        },
      ],
      profiles: [
        { account_id: 'acct-1', user_id: 'owner-1', account_role: 'owner' },
        { account_id: 'acct-1', user_id: 'user-1', account_role: 'admin' },
        { account_id: 'acct-1', user_id: 'agent-1', account_role: 'agent' },
      ].map((p) => ({ ...p, deactivated_at: null })),
    },
    { rpc: (fn) => (fn === 'deal_room_fail_creation' ? failed : null) }
  );
  const userRpc = vi.fn(async () =>
    create.error
      ? { data: null, error: create.error }
      : { data: create.data ?? 'room-1', error: null }
  );
  const run = () =>
    createDealRoom({
      userDb: { rpc: userRpc } as never,
      adminDb: admin.db,
      accountId: 'acct-1',
      input: INPUT,
    });
  return { admin, userRpc, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.metaChannel.mockResolvedValue({
    id: 'cfg-1',
    provider: 'meta',
    phoneNumberId: '106',
    accessToken: 'tok',
  });
  h.createGroup.mockResolvedValue({ requestId: 'req-1' });
});

describe('createDealRoom', () => {
  it('creates the room as the caller, asks Meta for the group, and marks it requested', async () => {
    const { admin, userRpc, run } = setup();
    expect(await run()).toEqual({
      ok: true,
      roomId: 'room-1',
      channelId: 'chan-1',
      status: 'creating',
    });
    expect(userRpc).toHaveBeenCalledWith('deal_room_create', {
      p_contact_id: 'contact-1',
      p_deal_id: null,
      p_whatsapp_config_id: 'cfg-1',
      p_subject: 'Deal 42',
      p_description: null,
      p_participants: [
        {
          display_name: 'Aisha',
          phone: '971500000001',
          role: 'customer',
          contact_id: null,
          bank_code: null,
        },
      ],
      p_consent: {
        text_version: 'v1',
        consent_text: 'I agree',
        method: 'verbal',
      },
    });
    expect(h.createGroup).toHaveBeenCalledWith({
      phoneNumberId: '106',
      accessToken: 'tok',
      subject: 'Deal 42',
      description: null,
      joinApprovalMode: 'approval_required',
    });
    expect(admin.rpcCalls).toEqual([
      ['deal_room_mark_requested', { p_room: 'room-1', p_request_id: 'req-1' }],
    ]);
  });

  it('leaves the room unmarked when Meta returns no request id', async () => {
    h.createGroup.mockResolvedValue({ requestId: null });
    const { admin, run } = setup();
    expect(await run()).toMatchObject({ ok: true, status: 'creating' });
    expect(admin.rpcCalls).toEqual([]);
  });

  it.each([
    ['42501', 'deal rooms: contact not found', 403, 'Contact not found'],
    [
      '22023',
      'deal rooms: invite 1 to 7 people (WhatsApp allows 8 including the business number)',
      400,
      'Invite 1 to 7 people (WhatsApp allows 8 including the business number)',
    ],
    [
      '23505',
      'duplicate key value violates unique constraint',
      409,
      'Duplicate key value violates unique constraint',
    ],
    [
      'XX000',
      'internal: tuple concurrently updated',
      500,
      'Could not create the deal room',
    ],
  ])(
    'answers a %s refusal with %s… → %i',
    async (code, message, status, error) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { admin, run } = setup({ error: { code, message } });
      expect(await run()).toEqual({ ok: false, status, error });
      expect(h.createGroup).not.toHaveBeenCalled();
      expect(admin.rpcCalls).toEqual([]);
      log.mockRestore();
    }
  );

  it('marks the room failed when Meta refuses, and returns it', async () => {
    h.createGroup.mockRejectedValue(new Error('Too many groups'));
    const { admin, run } = setup();
    expect(await run()).toEqual({
      ok: false,
      status: 502,
      error: 'WhatsApp could not create the group: Too many groups',
      roomId: 'room-1',
    });
    expect(admin.rpcCalls).toEqual([
      [
        'deal_room_fail_creation',
        { p_room: 'room-1', p_reason: 'Too many groups' },
      ],
    ]);
  });

  it('tells the creator and the live owners and admins, once each, when Meta refuses', async () => {
    h.createGroup.mockRejectedValue(new Error('Too many groups'));
    const { admin, run } = setup();
    await run();
    expect(admin.tables.notifications).toEqual(
      ['user-1', 'owner-1'].map((user_id) => ({
        account_id: 'acct-1',
        user_id,
        type: 'deal_room_update',
        title: 'Deal room could not be created',
        body: 'Deal 42',
        meta: {
          room_id: 'room-1',
          channel_id: 'chan-1',
          event: 'create_failed',
          reason: 'Too many groups',
        },
      }))
    );
  });

  it('tells nobody when a manager cancelled the room while Meta answered', async () => {
    h.createGroup.mockRejectedValue(new Error('Too many groups'));
    const { admin, run } = setup({}, false);
    expect(await run()).toMatchObject({ ok: false, status: 502 });
    expect(admin.rpcCalls.map(([fn]) => fn)).toEqual([
      'deal_room_fail_creation',
    ]);
    expect(admin.tables.notifications).toBeUndefined();
  });

  it('refuses with 409 before any RPC when no Meta number is connected', async () => {
    h.metaChannel.mockResolvedValue(null);
    const { admin, userRpc, run } = setup();
    expect(await run()).toMatchObject({ ok: false, status: 409 });
    expect(userRpc).not.toHaveBeenCalled();
    expect(admin.rpcCalls).toEqual([]);
    expect(h.createGroup).not.toHaveBeenCalled();
  });

  it('lets a failed number lookup through to the route, before any RPC', async () => {
    h.metaChannel.mockRejectedValue(
      new ChannelError(
        'channel_lookup_failed',
        'Could not load WhatsApp channels.',
        500
      )
    );
    const { userRpc, run } = setup();
    await expect(run()).rejects.toBeInstanceOf(ChannelError);
    expect(userRpc).not.toHaveBeenCalled();
  });
});
