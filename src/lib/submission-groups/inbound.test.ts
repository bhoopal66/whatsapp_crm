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
    reconcileEcho: vi.fn(async () => true),
    inboundMessageId: vi.fn(async (): Promise<number | null> => 9001),
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
  it("matches any of the bank's coordinator numbers (142)", () => {
    expect(
      senderKindOf('971550000003', '971501234567', null, [
        '971550000004',
        '9710550000003',
      ])
    ).toBe('coordinator');
  });
  it("records a bank coordinator's message as the coordinator (142)", async () => {
    const recordInbound = vi.fn<InboundStore['recordInbound']>(
      async () => true
    );
    const store = fakeStore({
      findByWaGroupId: vi.fn(async () => ({
        ...group,
        coordinatorPhones: ['971550000003'],
      })),
      recordInbound,
    });
    await recordSubmissionGroupInbound(store, channel, [
      msg({ senderWaId: '971550000003' }),
    ]);
    expect(recordInbound.mock.calls[0][0].senderKind).toBe('coordinator');
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

  const echo = (over: Partial<GroupInboundMessage> = {}) =>
    msg({
      id: 'wa-echo',
      fromMe: true,
      senderWaId: '971500000001',
      body: 'Ali (Agent): hi',
      sentAt: '2026-10-16T10:19:58.000Z',
      ...over,
    });

  it('an echo of our own send is given to the matching row and never stored', async () => {
    const store = fakeStore();
    const out = await recordSubmissionGroupInbound(store, channel, [echo()]);
    expect(store.reconcileEcho).toHaveBeenCalledExactlyOnceWith({
      groupId: 'sg-1',
      waMessageId: 'wa-echo',
      type: 'text',
      text: 'Ali (Agent): hi',
      sentAt: new Date('2026-10-16T10:19:58.000Z'),
    });
    expect(store.recordInbound).not.toHaveBeenCalled();
    expect(out).toEqual({
      recorded: 0,
      reconciled: 1,
      duplicates: 0,
      failed: 0,
    });
  });

  it("an attachment's echo is matched by its caption", async () => {
    const store = fakeStore();
    const out = await recordSubmissionGroupInbound(store, channel, [
      echo({ type: 'image', body: 'Ali (Agent)', media: { id: 'x' } }),
    ]);
    expect(store.reconcileEcho).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image', text: 'Ali (Agent)' })
    );
    expect(store.recordInbound).not.toHaveBeenCalled();
    expect(out.reconciled).toBe(1);
  });

  it('an echo that matches no row is ignored and never stored', async () => {
    const store = fakeStore({ reconcileEcho: vi.fn(async () => false) });
    const out = await recordSubmissionGroupInbound(store, channel, [echo()]);
    expect(store.recordInbound).not.toHaveBeenCalled();
    expect(out.reconciled).toBe(0);
  });

  it('an echo without a usable timestamp is matched with no upper bound', async () => {
    const store = fakeStore();
    await recordSubmissionGroupInbound(store, channel, [
      echo({ sentAt: 'not a date' }),
    ]);
    expect(store.reconcileEcho).toHaveBeenCalledWith(
      expect.objectContaining({ sentAt: null })
    );
  });

  it('an empty echo, or one outside a submission group, is ignored', async () => {
    const store = fakeStore();
    await recordSubmissionGroupInbound(store, channel, [
      echo({ body: null }),
      echo({ type: 'image', body: null, media: { id: 'x' } }),
      echo({ waGroupId: '120363000000000999@g.us' }),
    ]);
    expect(store.reconcileEcho).not.toHaveBeenCalled();
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

  describe('case SLA hook', () => {
    const hook = (caseId: string | null = 'case-1') => ({
      caseIdForGroup: vi.fn(async () => caseId),
      customerMessage: vi.fn(async () => 'on_track'),
    });

    it("a new customer message is the case's customer_message", async () => {
      const caseSla = hook();
      await recordSubmissionGroupInbound(fakeStore(), channel, [msg()], {
        caseSla,
      });
      expect(caseSla.caseIdForGroup).toHaveBeenCalledWith('sg-1');
      expect(caseSla.customerMessage).toHaveBeenCalledWith('case-1');
    });

    it('a staff echo, a duplicate, a coordinator or another sender fires nothing', async () => {
      const caseSla = hook();
      await recordSubmissionGroupInbound(fakeStore(), channel, [echo()], {
        caseSla,
      });
      await recordSubmissionGroupInbound(
        fakeStore({ recordInbound: vi.fn(async () => false) }),
        channel,
        [msg()],
        { caseSla }
      );
      await recordSubmissionGroupInbound(
        fakeStore(),
        channel,
        [
          msg({ id: 'b', senderWaId: '971550000002' }),
          msg({ id: 'c', senderWaId: '971509999999' }),
        ],
        { caseSla }
      );
      expect(caseSla.customerMessage).not.toHaveBeenCalled();
    });

    it('a group without a case fires nothing', async () => {
      const caseSla = hook(null);
      await recordSubmissionGroupInbound(fakeStore(), channel, [msg()], {
        caseSla,
      });
      expect(caseSla.customerMessage).not.toHaveBeenCalled();
    });

    it('a failing SLA event is logged, never counted against the delivery', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const caseSla = hook();
      caseSla.customerMessage.mockRejectedValue(new Error('db down'));
      const out = await recordSubmissionGroupInbound(
        fakeStore(),
        channel,
        [msg()],
        { caseSla }
      );
      err.mockRestore();
      expect(out).toMatchObject({ recorded: 1, failed: 0 });
    });
  });

  describe('customer text hook (183)', () => {
    it('hands on a new customer text with its body', async () => {
      const customerText = vi.fn();
      await recordSubmissionGroupInbound(fakeStore(), channel, [msg()], {
        customerText,
      });
      expect(customerText).toHaveBeenCalledWith({
        accountId: 'acc-1',
        groupId: 'sg-1',
        waMessageId: 'm-1',
        body: 'hello',
      });
    });

    it('skips staff texts, duplicates, empty texts and media', async () => {
      const customerText = vi.fn();
      // The coordinator writes; then a redelivered customer text.
      await recordSubmissionGroupInbound(
        fakeStore(),
        channel,
        [
          msg({ id: 'c-1', senderWaId: '971550000002' }),
          msg({ id: 'e-1', body: '' }),
          msg({ id: 'd-1', type: 'image', body: '1', media: { id: 'x' } }),
        ],
        { customerText }
      );
      await recordSubmissionGroupInbound(
        fakeStore({ recordInbound: vi.fn(async () => false) }),
        channel,
        [msg()],
        { customerText }
      );
      expect(customerText).not.toHaveBeenCalled();
    });

    it('a throwing hook leaves the counts unchanged', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const customerText = vi.fn(() => {
        throw new Error('boom');
      });
      const out = await recordSubmissionGroupInbound(
        fakeStore(),
        channel,
        [msg(), msg({ id: 'm-2' })],
        { customerText }
      );
      err.mockRestore();
      expect(customerText).toHaveBeenCalledTimes(2);
      expect(out).toEqual({
        recorded: 2,
        reconciled: 0,
        duplicates: 0,
        failed: 0,
      });
    });
  });

  describe('customer document hook', () => {
    const pdf = {
      id: 'media-1',
      link: 'https://gate.whapi.cloud/media/media-1',
      mime_type: 'application/pdf',
      filename: 'salary.pdf',
      file_size: 1234,
    };
    const docMsg = (over: Partial<GroupInboundMessage> = {}) =>
      msg({ type: 'document', body: 'my salary', media: pdf, ...over });
    const slaHook = () => ({
      caseIdForGroup: vi.fn(async () => 'case-1'),
      customerMessage: vi.fn(async () => 'on_track'),
    });

    it("files a customer's document once with the new row's id", async () => {
      const store = fakeStore();
      const customerDocument = vi.fn(async () => 'TC-000001');
      const out = await recordSubmissionGroupInbound(
        store,
        channel,
        [docMsg()],
        { customerDocument }
      );
      expect(out).toMatchObject({ recorded: 1, duplicates: 0, failed: 0 });
      expect(store.inboundMessageId).toHaveBeenCalledWith('sg-1', 'm-1');
      expect(customerDocument).toHaveBeenCalledTimes(1);
      expect(customerDocument).toHaveBeenCalledWith({
        accountId: 'acc-1',
        contactId: 'contact-1',
        groupId: 'sg-1',
        groupMessageId: 9001,
        waMessageId: 'm-1',
        kind: 'document',
        media: pdf,
        caption: 'my salary',
        sentAt: '2026-10-16T10:00:00.000Z',
      });
    });

    it("files a customer's photo", async () => {
      const customerDocument = vi.fn(async () => 'TC-000001');
      const photo = {
        id: 'media-2',
        link: 'https://x/p.jpg',
        mime_type: 'image/jpeg',
      };
      await recordSubmissionGroupInbound(
        fakeStore(),
        channel,
        [msg({ type: 'image', body: null, media: photo })],
        { customerDocument }
      );
      expect(customerDocument).toHaveBeenCalledTimes(1);
      expect(customerDocument).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'image', media: photo, caption: null })
      );
    });

    it('files nothing for a sticker, an audio, staff, a duplicate or a group without a contact', async () => {
      const customerDocument = vi.fn(async () => 'TC-000001');
      await recordSubmissionGroupInbound(
        fakeStore(),
        channel,
        [
          docMsg({ id: 's', type: 'sticker' }),
          docMsg({ id: 'a', type: 'audio' }),
          docMsg({ id: 'n', media: null }),
          docMsg({ id: 'c', senderWaId: '971550000002' }),
          docMsg({ id: 'o', senderWaId: '971509999999' }),
        ],
        { customerDocument }
      );
      await recordSubmissionGroupInbound(
        fakeStore({ recordInbound: vi.fn(async () => false) }),
        channel,
        [docMsg()],
        { customerDocument }
      );
      await recordSubmissionGroupInbound(
        fakeStore({
          findByWaGroupId: vi.fn(async () => ({ ...group, contactId: null })),
        }),
        channel,
        [docMsg()],
        { customerDocument }
      );
      expect(customerDocument).not.toHaveBeenCalled();
    });

    it('a throwing or rejecting hook changes no count and no SLA call', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const rejecting = vi.fn(async () => {
        throw new Error('storage down');
      });
      const lookupFails = fakeStore({
        inboundMessageId: vi.fn(async () => {
          throw new Error('db down');
        }),
      });
      for (const [store, customerDocument] of [
        [fakeStore(), throwing],
        [fakeStore(), rejecting],
        [lookupFails, rejecting],
      ] as const) {
        const caseSla = slaHook();
        const out = await recordSubmissionGroupInbound(
          store,
          channel,
          [docMsg(), docMsg({ id: 'm-2' })],
          { caseSla, customerDocument }
        );
        expect(out).toEqual({
          recorded: 2,
          reconciled: 0,
          duplicates: 0,
          failed: 0,
        });
        expect(caseSla.customerMessage).toHaveBeenCalledTimes(2);
      }
      expect(throwing).toHaveBeenCalledTimes(2);
      expect(rejecting).toHaveBeenCalledTimes(2);
      err.mockRestore();
    });
  });
});
