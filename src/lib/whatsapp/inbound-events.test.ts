import { beforeEach, describe, expect, it, vi } from 'vitest';

// processInboundEvent: what each kind calls per provider, and the outcome
// it settles with. Every writer behind it is faked at its module boundary.

const h = vi.hoisted(() => ({
  processMessage: vi.fn(),
  handleStatusUpdate: vi.fn(),
  persistOwnSend: vi.fn(),
  resolveLid: vi.fn(),
  persistGroup: vi.fn(),
  groupStatuses: vi.fn(),
  submission: vi.fn(),
  order: [] as string[],
  decrypt: vi.fn(),
  configReply: { data: null as unknown, error: null as unknown },
  configFilters: {} as Record<string, unknown>,
  hasFile: vi.fn(),
  copyMedia: vi.fn(),
  groupFile: vi.fn(),
}));

vi.mock('./encryption', () => ({ decrypt: h.decrypt }));
vi.mock('./inbound-pipeline', () => ({
  processMessage: h.processMessage,
  handleStatusUpdate: h.handleStatusUpdate,
}));
vi.mock('./own-send', () => ({
  persistOwnSend: h.persistOwnSend,
  resolveOpenWALidPhone: h.resolveLid,
}));
vi.mock('@/lib/groups/inbound', () => ({
  persistGroupMessages: h.persistGroup,
  applyGroupStatuses: h.groupStatuses,
}));
vi.mock('@/lib/groups/inbound-media', () => ({
  hasGroupFile: h.hasFile,
  copyGroupMessageMedia: h.copyMedia,
}));
vi.mock('@/lib/desk/group-intake', () => ({
  processGroupFile: h.groupFile,
}));
vi.mock('@/lib/submission-groups/inbound', () => ({
  recordSubmissionGroupInbound: h.submission,
}));
vi.mock('@/lib/submission-groups/store', () => ({
  SubmissionGroupStore: class {},
}));
vi.mock('@/lib/customer-docs/group-documents', () => ({
  groupDocumentFiler: () => ({
    hook: () => h.order.push('filer.hook'),
    run: async () => void h.order.push('filer.run'),
  }),
}));
vi.mock('@/lib/cases/server', () => ({
  caseSlaInboundHook: () => 'sla',
  caseIntakeQueueFor: () => ({
    document: () => h.order.push('intake.document'),
    text: () => h.order.push('intake.text'),
    run: async () => void h.order.push('intake.run'),
  }),
}));
vi.mock('@/lib/brain/sink', () => ({
  recordGroupCustomerText: async () => void h.order.push('brain'),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b = {
        select: () => b,
        is: () => b,
        limit: async () => ownerReply,
        eq: (col: string, v: unknown) => {
          h.configFilters[col] = v;
          return b;
        },
        maybeSingle: async () => h.configReply,
      };
      return b;
    },
  }),
}));

let ownerReply: { data: unknown; error: unknown };

import {
  groupMessagePayload,
  inboundChannel,
  messagePayload,
  ownSendPayload,
  processInboundEvent,
  statusPayload,
} from './inbound-events';
import { InboundPersistError } from './inbound-persist-error';
import type { InboundEvent } from './webhook-inbox';

type Provider = InboundEvent['provider'];

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  account_id: 'acct-1',
  user_id: 'owner-1',
  phone_number_id: 'pn-1',
  access_token: 'cipher',
  ...over,
});
const MESSAGE = { id: 'm1', from: '971500000001', text: 'secret' } as never;
const STATUS = { messageId: 'm1', status: 'read' } as never;
const OWN = {
  id: 'o1',
  peerPhone: '971500000002',
  peerLid: null,
  text: 'mine',
  timestamp: '1',
};
const GROUP = { id: 'g1', waGroupId: 'x@g.us' } as never;

const event = (
  provider: Provider,
  kind: InboundEvent['kind'],
  payload: unknown
): InboundEvent => ({
  accountId: 'acct-1',
  channel: 'cfg-1',
  provider,
  eventKey: 'k',
  kind,
  payload,
});
const run = (
  provider: Provider,
  kind: InboundEvent['kind'],
  payload: unknown,
  config: Record<string, unknown> = {}
) =>
  processInboundEvent(event(provider, kind, payload), { config: row(config) });

const DONE = { outcome: 'done' };
const PERSONAL = { is_personal: true };

beforeEach(() => {
  ownerReply = { data: [{ id: 'p1' }], error: null };
});

describe('a personal number whose owner left', () => {
  it('drops every kind queued for it, logging each kind once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ownerReply = { data: [], error: null };
    for (let i = 0; i < 2; i++) {
      for (const [kind, payload] of [
        ['message', messagePayload(MESSAGE)],
        ['status', statusPayload(STATUS)],
        ['own_send', ownSendPayload(OWN)],
      ] as const) {
        expect(await run('openwa', kind, payload, PERSONAL)).toEqual(DONE);
      }
    }
    expect(h.processMessage).not.toHaveBeenCalled();
    expect(h.handleStatusUpdate).not.toHaveBeenCalled();
    expect(h.persistOwnSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|9715|mine/);
    warn.mockRestore();
  });

  it('is retried, not dropped, when the owner cannot be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ownerReply = { data: null, error: { code: '57014' } };
    expect(
      await run('openwa', 'message', messagePayload(MESSAGE), PERSONAL)
    ).toMatchObject({ outcome: 'failed' });
    spy.mockRestore();
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  h.order = [];
  h.configReply = { data: null, error: null };
  h.configFilters = {};
  h.decrypt.mockImplementation((v: string) => `plain:${v}`);
  h.handleStatusUpdate.mockResolvedValue({ matched: true, failed: false });
  h.groupStatuses.mockResolvedValue(0);
  h.submission.mockResolvedValue({ failed: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('inboundChannel matches what the routes shape', () => {
  it.each([
    ['whapi', undefined, true],
    ['whapi', false, false],
    ['openwa', undefined, true],
    ['openwa', false, false],
    ['meta', undefined, false],
    ['meta', true, true],
  ] as const)('%s is_primary %s', (provider, is_primary, isPrimary) => {
    expect(inboundChannel(provider, row({ is_primary }))).toEqual({
      id: 'cfg-1',
      accountId: 'acct-1',
      provider,
      label: null,
      phoneNumberId: 'pn-1',
      wabaId: null,
      accessToken: 'plain:cipher',
      appSecret: null,
      isPrimary,
      mirrorInboundMedia: true,
      status: 'connected',
      isPersonal: false,
      personalUserId: null,
    });
  });

  it('is personal only on OpenWA', () => {
    expect(inboundChannel('openwa', row(PERSONAL))).toMatchObject({
      isPersonal: true,
      personalUserId: 'owner-1',
    });
    for (const provider of ['whapi', 'meta'] as const) {
      expect(inboundChannel(provider, row(PERSONAL))).toMatchObject({
        isPersonal: false,
        personalUserId: null,
      });
    }
  });
});

describe('message', () => {
  it.each(['whapi', 'openwa', 'meta'] as const)('%s', async (provider) => {
    expect(await run(provider, 'message', messagePayload(MESSAGE))).toEqual(
      DONE
    );
    expect(h.processMessage).toHaveBeenCalledWith(
      MESSAGE,
      'acct-1',
      'owner-1',
      inboundChannel(provider, row()),
      undefined,
      { onPersistFailure: 'throw' }
    );
  });

  it('carries fanOut false, and the caller background list', async () => {
    const later: Promise<unknown>[] = [];
    await processInboundEvent(
      event('meta', 'message', messagePayload(MESSAGE, true)),
      { config: row(), later }
    );
    expect(h.processMessage.mock.calls[0][4]).toBe(later);
    expect(h.processMessage.mock.calls[0][5]).toEqual({
      onPersistFailure: 'throw',
      fanOut: false,
    });
  });

  it('says it is a retry from the second attempt on', async () => {
    h.processMessage.mockResolvedValue(undefined);
    for (const attempt of [1, 2]) {
      await processInboundEvent(
        event('meta', 'message', messagePayload(MESSAGE)),
        { config: row(), attempt }
      );
    }
    expect(h.processMessage.mock.calls.map((c) => c[5])).toEqual([
      { onPersistFailure: 'throw' },
      { onPersistFailure: 'throw', retry: true },
    ]);
  });

  it('a message that was not stored is failed, quoting nothing', async () => {
    h.processMessage.mockRejectedValueOnce(
      new InboundPersistError('message', '57014')
    );
    expect(await run('whapi', 'message', messagePayload(MESSAGE))).toEqual({
      outcome: 'failed',
      reason: 'message failed: message 57014',
    });
    h.processMessage.mockRejectedValueOnce({
      code: '23505',
      details: 'secret',
      message: 'secret',
    });
    expect(await run('whapi', 'message', messagePayload(MESSAGE))).toEqual({
      outcome: 'failed',
      reason: 'message failed: 23505',
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'secret'
    );
  });

  it('works on the text the queue stores: no NUL, no half surrogate', async () => {
    h.processMessage.mockResolvedValue(undefined);
    await run(
      'whapi',
      'message',
      messagePayload({
        ...(MESSAGE as object),
        text: 'a\u0000b \ud83d c',
      } as typeof MESSAGE)
    );
    expect(h.processMessage.mock.calls.at(-1)![0]).toMatchObject({
      text: 'ab \ufffd c',
    });
  });

  it('an unreadable payload is failed', async () => {
    expect(await run('whapi', 'message', {})).toMatchObject({
      outcome: 'failed',
    });
    expect(h.processMessage).not.toHaveBeenCalled();
  });
});

describe('the number', () => {
  const drain = () =>
    processInboundEvent(event('meta', 'message', messagePayload(MESSAGE)));

  it('is read by id, account and provider for the drain', async () => {
    h.configReply = { data: row(), error: null };
    expect(await drain()).toEqual(DONE);
    expect(h.configFilters).toEqual({
      id: 'cfg-1',
      account_id: 'acct-1',
      provider: 'meta',
    });
  });

  it.each([
    ['a failed read', { data: null, error: { code: '57014' } }],
    ['no such number', { data: null, error: null }],
    ['another account', { data: row({ account_id: 'b' }), error: null }],
  ])('%s is failed', async (_name, reply) => {
    h.configReply = reply;
    expect(await drain()).toMatchObject({ outcome: 'failed' });
    expect(h.processMessage).not.toHaveBeenCalled();
  });

  it('a token that does not decrypt fails what needs it, only', async () => {
    h.decrypt.mockImplementation(() => {
      throw new Error('bad key');
    });
    expect(await run('whapi', 'message', messagePayload(MESSAGE))).toEqual({
      outcome: 'failed',
      reason: 'number credentials could not be decrypted',
    });
    expect(await run('whapi', 'status', statusPayload(STATUS))).toEqual(DONE);
    expect(
      await run('whapi', 'group_message', groupMessagePayload(GROUP))
    ).toEqual(DONE);
  });
});

describe('status', () => {
  it.each([
    ['whapi', {}, true],
    ['openwa', {}, true],
    ['openwa', PERSONAL, false],
    ['meta', {}, false],
  ] as const)('%s %o', async (provider, config, groups) => {
    expect(
      await run(provider, 'status', statusPayload(STATUS), config)
    ).toEqual(DONE);
    expect(h.handleStatusUpdate).toHaveBeenCalledWith(STATUS, 'acct-1');
    expect(h.groupStatuses).toHaveBeenCalledTimes(groups ? 1 : 0);
  });

  it('matching nothing is unmatched; a group match is done', async () => {
    h.handleStatusUpdate.mockResolvedValue({ matched: false, failed: false });
    const go = () => run('whapi', 'status', statusPayload(STATUS));
    expect(await go()).toEqual({ outcome: 'unmatched' });
    h.groupStatuses.mockResolvedValue(1);
    expect(await go()).toEqual(DONE);
  });

  it('a database error is failed, even when a row matched', async () => {
    h.handleStatusUpdate.mockResolvedValueOnce({ matched: true, failed: true });
    const go = () => run('whapi', 'status', statusPayload(STATUS));
    expect(await go()).toMatchObject({ outcome: 'failed' });
    h.groupStatuses.mockRejectedValueOnce({ code: '57014' });
    expect(await go()).toEqual({
      outcome: 'failed',
      reason: 'status failed: 57014',
    });
  });
});

describe('own_send', () => {
  it('is filed on a personal OpenWA number only', async () => {
    const payload = ownSendPayload(OWN);
    expect(await run('openwa', 'own_send', payload)).toEqual(DONE);
    expect(await run('whapi', 'own_send', payload, PERSONAL)).toEqual(DONE);
    expect(h.persistOwnSend).not.toHaveBeenCalled();
    expect(await run('openwa', 'own_send', payload, PERSONAL)).toEqual(DONE);
    expect(h.persistOwnSend).toHaveBeenCalledWith(
      expect.anything(),
      inboundChannel('openwa', row(PERSONAL)),
      { id: 'o1', peerPhone: '971500000002', text: 'mine', timestamp: '1' },
      { onPersistFailure: 'throw' }
    );
  });

  it('a chat that could not be resolved is failed', async () => {
    h.persistOwnSend.mockRejectedValue(new InboundPersistError('conversation'));
    expect(
      await run('openwa', 'own_send', ownSendPayload(OWN), PERSONAL)
    ).toEqual({ outcome: 'failed', reason: 'own_send failed: conversation' });
  });

  it('resolves a lid, and retries cheaply one not learned yet', async () => {
    const lid = ownSendPayload({ ...OWN, peerPhone: null, peerLid: '9@lid' });
    const go = (p: unknown) => run('openwa', 'own_send', p, PERSONAL);
    h.resolveLid.mockResolvedValueOnce('971500000003');
    expect(await go(lid)).toEqual(DONE);
    expect(h.persistOwnSend.mock.calls[0][2].peerPhone).toBe('971500000003');
    h.resolveLid.mockResolvedValueOnce(null);
    expect(await go(lid)).toEqual({ outcome: 'unmatched' });
    expect(await go(ownSendPayload({ ...OWN, peerPhone: null }))).toEqual(DONE);
    expect(h.persistOwnSend).toHaveBeenCalledTimes(1);
  });
});

describe('group_message', () => {
  const payload = groupMessagePayload(GROUP);

  it('whapi: both writers, then the filer and the intake', async () => {
    h.submission.mockImplementation(async (_s, _c, _m, hooks) => {
      hooks.customerDocument({});
      await hooks.customerText({});
      return { failed: 0 };
    });
    expect(await run('whapi', 'group_message', payload)).toEqual(DONE);
    const channel = { id: 'cfg-1', accountId: 'acct-1', wabaId: null };
    expect(h.persistGroup).toHaveBeenCalledWith(expect.anything(), channel, [
      GROUP,
    ]);
    expect(h.submission.mock.calls[0][1]).toEqual(channel);
    expect(h.submission.mock.calls[0][3].caseSla).toBe('sla');
    expect(h.order).toEqual([
      'filer.hook',
      'intake.document',
      'intake.text',
      'brain',
      'filer.run',
      'intake.run',
    ]);
  });

  it('whapi: either write failing is failed, and the other still runs', async () => {
    h.persistGroup.mockRejectedValueOnce({ code: '57014' });
    expect(await run('whapi', 'group_message', payload)).toEqual({
      outcome: 'failed',
      reason: 'group message failed: 57014',
    });
    expect(h.submission).toHaveBeenCalledTimes(1);
    h.submission.mockResolvedValueOnce({ failed: 1 });
    expect(await run('whapi', 'group_message', payload)).toMatchObject({
      outcome: 'failed',
    });
    expect(h.order).toEqual([
      'filer.run',
      'intake.run',
      'filer.run',
      'intake.run',
    ]);
  });

  it('openwa: group messages only, and none on a personal number', async () => {
    expect(await run('openwa', 'group_message', payload)).toEqual(DONE);
    expect(h.persistGroup).toHaveBeenCalledTimes(1);
    expect(await run('openwa', 'group_message', payload, PERSONAL)).toEqual(
      DONE
    );
    expect(h.persistGroup).toHaveBeenCalledTimes(1);
    expect(h.submission).not.toHaveBeenCalled();
  });

  it('a file: the media copy, then the case desk, in `later`', async () => {
    h.hasFile.mockReturnValue(true);
    h.copyMedia.mockImplementation(async () => void h.order.push('copy'));
    h.groupFile.mockImplementation(async () => void h.order.push('desk'));
    const later: Promise<unknown>[] = [];
    await processInboundEvent(event('whapi', 'group_message', payload), {
      config: row(),
      later,
    });
    expect(later).toHaveLength(1);
    await Promise.all(later);
    expect(h.order.filter((s) => s === 'copy' || s === 'desk')).toEqual([
      'copy',
      'desk',
    ]);
    const [deps, message] = h.groupFile.mock.calls[0];
    expect(message).toEqual(GROUP);
    expect(deps.channel).toMatchObject({ id: 'cfg-1', accountId: 'acct-1' });
    expect(typeof deps.loadChannel).toBe('function');
  });

  it('a file without `later` (the drain) is awaited inline; openwa too', async () => {
    h.hasFile.mockReturnValue(true);
    h.copyMedia.mockResolvedValue(undefined);
    h.groupFile.mockResolvedValue(undefined);
    await run('openwa', 'group_message', payload);
    expect(h.groupFile).toHaveBeenCalledTimes(1);
  });

  it('no file, or a failed write, never reaches the case desk', async () => {
    h.hasFile.mockReturnValue(false);
    await run('whapi', 'group_message', payload);
    h.hasFile.mockReturnValue(true);
    h.persistGroup.mockRejectedValueOnce({ code: '57014' });
    await run('whapi', 'group_message', payload);
    expect(h.copyMedia).not.toHaveBeenCalled();
    expect(h.groupFile).not.toHaveBeenCalled();
  });

  it('meta: never queued under this kind', async () => {
    expect(await run('meta', 'group_message', payload)).toMatchObject({
      outcome: 'failed',
    });
    expect(h.persistGroup).not.toHaveBeenCalled();
  });
});
