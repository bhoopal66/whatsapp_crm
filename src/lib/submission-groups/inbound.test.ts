import { describe, expect, it, vi } from 'vitest';

import type { GroupInboundMessage } from '@/lib/groups/inbound';

import {
  recordSubmissionGroupInbound,
  senderKindOf,
  type InboundStore,
} from './inbound';
import type { SubmissionGroup } from './store';

const WA_GROUP = '120363000000000001@g.us';
const channel = { id: 'cfg-1', accountId: 'acc-1' };

const group = {
  id: 'sg-1',
  contactId: 'contact-1',
  coordinatorPhone: '+971 55 000 0002',
} as SubmissionGroup;

function msg(over: Partial<GroupInboundMessage> = {}): GroupInboundMessage {
  return {
    id: 'm-1',
    waGroupId: WA_GROUP,
    fromMe: false,
    senderWaId: '971501234567',
    senderName: 'Ada',
    type: 'text',
    body: 'hello',
    media: null,
    sentAt: '2026-10-16T10:00:00.000Z',
    ...over,
  };
}

function fakeStore(over: Partial<InboundStore> = {}) {
  return {
    findByWaGroupId: vi.fn(async (_a: string, _c: string, wa: string) =>
      wa === WA_GROUP ? group : null
    ),
    contactConsent: vi.fn(async () => ({
      allowed: true,
      phone: '+971 050 123 4567',
    })),
    recordInbound: vi.fn(async () => true),
    hasWaMessage: vi.fn(async () => false),
    pendingOutMatching: vi.fn(async (): Promise<string[]> => ['41']),
    settleSend: vi.fn(async () => true),
    ...over,
  } satisfies InboundStore;
}

describe('senderKindOf', () => {
  it('matches the customer across trunk-0 and formatting differences', () => {
    expect(senderKindOf('971501234567', '+971 050 123 4567', null)).toBe(
      'customer'
    );
  });
  it('matches the coordinator phone', () => {
    expect(senderKindOf('971550000002', '971501234567', '00971550000002')).toBe(
      'coordinator'
    );
  });
  it('is other for anyone else or a hidden number', () => {
    expect(senderKindOf('971509999999', '971501234567', null)).toBe('other');
    expect(senderKindOf('123456789@lid', '971501234567', null)).toBe('other');
    expect(senderKindOf(null, '971501234567', null)).toBe('other');
  });
});

describe('recordSubmissionGroupInbound', () => {
  it('records a submission-group message scoped to the account and number', async () => {
    const store = fakeStore();
    const out = await recordSubmissionGroupInbound(store, channel, [msg()]);
    expect(out).toEqual({
      recorded: 1,
      reconciled: 0,
      duplicates: 0,
      failed: 0,
    });
    expect(store.findByWaGroupId).toHaveBeenCalledWith(
      'acc-1',
      'cfg-1',
      WA_GROUP
    );
    expect(store.recordInbound).toHaveBeenCalledWith({
      groupId: 'sg-1',
      waMessageId: 'm-1',
      senderWaId: '971501234567',
      senderKind: 'customer',
      type: 'text',
      body: 'hello',
      media: null,
      waTimestamp: new Date('2026-10-16T10:00:00.000Z'),
    });
  });

  const NOW = new Date('2026-10-16T10:20:00.000Z');
  const echo = (over: Partial<GroupInboundMessage> = {}) =>
    msg({
      id: 'wa-echo',
      fromMe: true,
      senderWaId: '971500000001',
      body: 'Ali (Agent): hi',
      sentAt: '2026-10-16T10:19:58.000Z',
      ...over,
    });

  it("an echo of our own send settles the group's sole matching pending row sent with the echo's id", async () => {
    const store = fakeStore();
    const out = await recordSubmissionGroupInbound(store, channel, [echo()], {
      now: () => NOW,
    });
    expect(store.hasWaMessage).toHaveBeenCalledWith('sg-1', 'wa-echo');
    expect(store.pendingOutMatching).toHaveBeenCalledWith(
      'sg-1',
      'Ali (Agent): hi',
      new Date('2026-10-16T10:05:00.000Z'),
      new Date('2026-10-16T10:19:58.999Z')
    );
    expect(store.settleSend).toHaveBeenCalledWith('41', 'sent', 'wa-echo');
    expect(store.recordInbound).not.toHaveBeenCalled();
    expect(out).toEqual({
      recorded: 0,
      reconciled: 1,
      duplicates: 0,
      failed: 0,
    });
  });

  it('an echo whose id is already recorded, or with no matching pending send, is ignored and never stored', async () => {
    const known = fakeStore({ hasWaMessage: vi.fn(async () => true) });
    await recordSubmissionGroupInbound(known, channel, [echo()]);
    expect(known.pendingOutMatching).not.toHaveBeenCalled();
    expect(known.settleSend).not.toHaveBeenCalled();

    const none = fakeStore({ pendingOutMatching: vi.fn(async () => []) });
    const out = await recordSubmissionGroupInbound(none, channel, [echo()]);
    expect(none.settleSend).not.toHaveBeenCalled();
    expect(none.recordInbound).not.toHaveBeenCalled();
    expect(out.reconciled).toBe(0);
  });

  it('an echo matching two pending sends is ambiguous: neither is settled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = fakeStore({
      pendingOutMatching: vi.fn(async () => ['41', '42']),
    });
    const out = await recordSubmissionGroupInbound(store, channel, [echo()], {
      now: () => NOW,
    });
    expect(store.settleSend).not.toHaveBeenCalled();
    expect(store.recordInbound).not.toHaveBeenCalled();
    expect(out.reconciled).toBe(0);
    warn.mockRestore();
  });

  it('an echo without a usable timestamp is matched with no upper bound', async () => {
    const store = fakeStore();
    await recordSubmissionGroupInbound(
      store,
      channel,
      [echo({ sentAt: 'not a date' })],
      { now: () => NOW }
    );
    expect(store.pendingOutMatching).toHaveBeenCalledWith(
      'sg-1',
      'Ali (Agent): hi',
      new Date('2026-10-16T10:05:00.000Z'),
      null
    );
    expect(store.settleSend).toHaveBeenCalledWith('41', 'sent', 'wa-echo');
  });

  it('a media or empty echo, or one outside a submission group, is ignored', async () => {
    const store = fakeStore();
    await recordSubmissionGroupInbound(store, channel, [
      echo({ type: 'image', body: 'caption', media: { id: 'x' } }),
      echo({ body: null }),
      echo({ waGroupId: '120363000000000999@g.us' }),
    ]);
    expect(store.pendingOutMatching).not.toHaveBeenCalled();
    expect(store.settleSend).not.toHaveBeenCalled();
    expect(store.recordInbound).not.toHaveBeenCalled();
  });

  it('ignores chats that are not submission groups', async () => {
    const store = fakeStore();
    await recordSubmissionGroupInbound(store, channel, [
      msg({ waGroupId: '120363000000000999@g.us' }),
    ]);
    expect(store.recordInbound).not.toHaveBeenCalled();
  });

  it('counts a duplicate and isolates a failing message', async () => {
    const recordInbound = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('P0002'))
      .mockResolvedValueOnce(true);
    const store = fakeStore({ recordInbound });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await recordSubmissionGroupInbound(store, channel, [
      msg({ id: 'a' }),
      msg({ id: 'b', senderWaId: '971550000002' }),
      msg({ id: 'c', senderWaId: '971509999999' }),
    ]);
    err.mockRestore();
    expect(out).toEqual({
      recorded: 1,
      reconciled: 0,
      duplicates: 1,
      failed: 1,
    });
    expect(recordInbound.mock.calls.map((c) => c[0].senderKind)).toEqual([
      'customer',
      'coordinator',
      'other',
    ]);
    // One lookup per group and per contact for the whole delivery.
    expect(store.findByWaGroupId).toHaveBeenCalledTimes(1);
    expect(store.contactConsent).toHaveBeenCalledTimes(1);
  });
});
