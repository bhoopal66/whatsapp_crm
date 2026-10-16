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
    expect(out).toEqual({ recorded: 1, duplicates: 0, failed: 0 });
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

  it('skips our own sends (fromMe)', async () => {
    const store = fakeStore();
    const out = await recordSubmissionGroupInbound(store, channel, [
      msg({ fromMe: true }),
    ]);
    expect(store.recordInbound).not.toHaveBeenCalled();
    expect(out.recorded).toBe(0);
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
    expect(out).toEqual({ recorded: 1, duplicates: 1, failed: 1 });
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
