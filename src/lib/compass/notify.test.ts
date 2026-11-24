import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const resolveSendChannel = vi.fn();
const findExistingContact = vi.fn();
const resolveConversationByPhone = vi.fn();
const sendCoreLoads = vi.fn();
const sendMessageToConversation = vi.fn();

vi.mock('@/lib/whatsapp/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/channels')>()),
  resolveSendChannel: (...args: unknown[]) => resolveSendChannel(...args),
}));
vi.mock('@/lib/contacts/dedupe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/dedupe')>()),
  findExistingContact: (...args: unknown[]) => findExistingContact(...args),
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: (...args: unknown[]) =>
    resolveConversationByPhone(...args),
}));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/send-message')>();
  return {
    ...actual,
    // The core's own order: its reads, the hook, then the gateway.
    sendMessageToConversation: async (...args: unknown[]) => {
      await sendCoreLoads();
      await (args[2] as SendMessageParams).beforeGateway?.();
      return sendMessageToConversation(...args);
    },
  };
});

import {
  getNotificationByKey,
  GROUP_RETRY_MS,
  NotifyError,
  parseNotificationRequest,
  sendCompassNotification,
  serializeNotification,
} from './notify';
import {
  DELIVERY_UNCONFIRMED,
  isClaimRetryable,
  STALE_CLAIM_MS,
} from './notification-status';
import {
  SendMessageError,
  type SendMessageParams,
} from '@/lib/whatsapp/send-message';
import { ChannelError } from '@/lib/whatsapp/channels';
import { ContactLookupError } from '@/lib/contacts/dedupe';
import {
  SubmissionGroupSendUnconfirmedError,
  SubmissionGroupSentNotRecordedError,
  SubmissionGroupSystemNotSentError,
} from '@/lib/submission-groups/service';
import { COMPASS_TEMPLATES } from './meta-template';
import { APPROVED_TEXT, SUBMITTED_TEXT } from './compass-messages.fixture';

// ------------------------------------------------------------
// In-memory stand-in for the Compass tables (and the chats, messages
// and templates the Meta gate reads) — just enough of the PostgREST builder for the
// chains notify.ts uses: insert/select/update with `.eq` filters,
// terminated by single/maybeSingle/await.
// ------------------------------------------------------------
type Row = Record<string, unknown>;

function makeDb(
  seed: {
    contacts?: Row[];
    /** The CRM's own `contacts` rows. */
    crmContacts?: Row[];
    notifications?: Row[];
    conversations?: Row[];
    groups?: Row[];
    groupMessages?: Row[];
    messages?: Row[];
    /** Default: both Compass templates, approved. */
    templates?: Row[];
    /** Tables whose reads answer an error. */
    failReads?: string[];
    /** Updates that answer an error, chosen by their payload. */
    failUpdate?: (payload: Row) => boolean;
    /** assignment_settings rows (migration 236). */
    settings?: Row[];
    cases?: Row[];
    /** The answer of any rpc (or a throw). */
    rpc?: (fn: string, args: unknown) => unknown;
  } = {}
) {
  const tables: Record<string, Row[]> = {
    compass_contacts: seed.contacts ?? [],
    contacts: seed.crmContacts ?? [],
    compass_notifications: seed.notifications ?? [],
    conversations: seed.conversations ?? [],
    submission_groups: seed.groups ?? [],
    submission_group_messages: seed.groupMessages ?? [],
    messages: seed.messages ?? [],
    message_templates: seed.templates ?? [SUBMITTED_ROW, APPROVED_ROW],
    assignment_settings: seed.settings ?? [],
    cases: seed.cases ?? [],
  };
  let nextId = 1;
  /** Every table an insert or update was run against. */
  const written = new Set<string>();
  /** Every table read. */
  const read = new Set<string>();
  const rpcs: { fn: string; args: unknown }[] = [];

  const db = {
    rpc(fn: string, args: unknown) {
      rpcs.push({ fn, args });
      return Promise.resolve(
        seed.rpc ? seed.rpc(fn, args) : { data: null, error: null }
      );
    },
    from(table: string) {
      const rows = tables[table];
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      const filters: ((r: Row) => boolean)[] = [];
      let sortDesc: string | null = null;
      const matching = () => {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (sortDesc) {
          const k = sortDesc;
          hit.sort((a, b) => String(b[k]).localeCompare(String(a[k])));
        }
        return hit;
      };

      const run = (): { data: unknown; error: unknown } => {
        if (op !== 'select') written.add(table);
        else read.add(table);
        if (op === 'select' && seed.failReads?.includes(table))
          return { data: null, error: { message: 'read failed' } };
        if (op === 'insert') {
          const clash = rows.find(
            (r) =>
              r.account_id === payload.account_id &&
              r.idempotency_key === payload.idempotency_key
          );
          if (clash) return { data: null, error: { code: '23505' } };
          const row = {
            id: `n${nextId++}`,
            created_at: new Date().toISOString(),
            ...payload,
          };
          rows.push(row);
          return { data: [row], error: null };
        }
        if (op === 'update' && seed.failUpdate?.(payload))
          return { data: null, error: { message: 'write failed' } };
        if (op === 'update') {
          const hit = matching();
          hit.forEach((r) => Object.assign(r, payload));
          return { data: hit, error: null };
        }
        return { data: matching(), error: null };
      };

      const builder = {
        select: () => builder,
        insert: (p: Row) => {
          op = 'insert';
          payload = p;
          return builder;
        },
        update: (p: Row) => {
          op = 'update';
          payload = p;
          return builder;
        },
        eq: (k: string, v: unknown) => {
          filters.push((r) => r[k] === v);
          return builder;
        },
        in: (k: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[k]));
          return builder;
        },
        is: (k: string, v: unknown) => {
          filters.push((r) => (r[k] ?? null) === v);
          return builder;
        },
        not: (k: string, _op: 'is', v: unknown) => {
          filters.push((r) => (r[k] ?? null) !== v);
          return builder;
        },
        like: (k: string, pattern: string) => {
          const end = pattern.replace(/^%/, '');
          filters.push((r) => String(r[k]).endsWith(end));
          return builder;
        },
        order: (k: string, o?: { ascending?: boolean }) => {
          if (o?.ascending === false) sortDesc = k;
          return builder;
        },
        limit: () => builder,
        single: () => {
          const { data, error } = run();
          return Promise.resolve({
            data: error ? null : ((data as Row[])[0] ?? null),
            error,
          });
        },
        maybeSingle: () => builder.single(),
        then: (resolve: (v: unknown) => void) => resolve(run()),
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, tables, written, read, rpcs };
}

const META = { id: 'cfg-meta', provider: 'meta', status: 'connected' };

/** The local row of a Compass template, approved by Meta. */
const templateRow = (event: string): Row => {
  const t = COMPASS_TEMPLATES.find((x) => x.event === event)!;
  return {
    id: `tpl-${t.name}`,
    user_id: 'u-1',
    account_id: 'acct',
    name: t.name,
    language: t.language,
    category: 'Utility',
    status: 'APPROVED',
    body_text: t.body,
    created_at: '2026-11-01T00:00:00Z',
  };
};
const SUBMITTED_ROW = templateRow('case.submitted');
const APPROVED_ROW = templateRow('case.approved');

/** A customer's chat on the Meta number, last written to `agoMs` ago. */
const chatOnMeta = (agoMs: number, channelId = 'cfg-meta') => ({
  conversations: [
    {
      id: 'conv-1',
      account_id: 'acct',
      contact_id: 'contact-1',
      channel_id: channelId,
      send_channel_id: null,
    },
  ],
  messages: [
    {
      id: 'm-in',
      conversation_id: 'conv-1',
      sender_type: 'customer',
      channel_id: channelId,
      created_at: new Date(Date.now() - agoMs).toISOString(),
    },
  ],
});
const HOUR = 3600_000;

beforeEach(() => {
  resolveSendChannel.mockReset().mockResolvedValue(META);
  findExistingContact.mockReset().mockResolvedValue(null);
  resolveConversationByPhone.mockReset().mockResolvedValue({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
    conversationCreated: false,
  });
  sendCoreLoads.mockReset();
  sendMessageToConversation.mockReset().mockResolvedValue({
    messageId: 'msg-1',
    whatsappMessageId: 'wa-1',
  });
});

const baseRequest = (over: Record<string, unknown> = {}) =>
  parseNotificationRequest({
    idempotency_key: 'APP-1:approved',
    to: '+971501234567',
    event: 'case.approved',
    text: APPROVED_TEXT,
    ...over,
  });

describe('parseNotificationRequest', () => {
  it('requires an idempotency_key', () => {
    expect(() =>
      parseNotificationRequest({ to: '+971501234567', text: 'x' })
    ).toThrow(/idempotency_key/);
  });

  it('requires a recipient', () => {
    expect(() =>
      parseNotificationRequest({ idempotency_key: 'k', text: 'x' })
    ).toThrow(/'to'.*'compass_id'/);
  });

  it('requires text for a text message', () => {
    expect(() =>
      parseNotificationRequest({ idempotency_key: 'k', to: '+971501234567' })
    ).toThrow(NotifyError);
  });

  it('rejects a local number', () => {
    expect(() =>
      parseNotificationRequest({
        idempotency_key: 'k',
        to: '0501234567',
        text: 'x',
      })
    ).toThrow(/'to'.*country code/);
  });

  it('rejects a non-https media_url', () => {
    expect(() =>
      parseNotificationRequest({
        idempotency_key: 'k',
        to: '+971501234567',
        type: 'document',
        media_url: 'http://example.com/a.pdf',
      })
    ).toThrow(/https/);
  });

  it('rejects message types Compass does not use', () => {
    expect(() =>
      parseNotificationRequest({
        idempotency_key: 'k',
        to: '+971501234567',
        type: 'template',
        text: 'x',
      })
    ).toThrow(/'type'/);
  });
});

describe('isClaimRetryable', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();

  it('never retries a sent notification', () => {
    expect(isClaimRetryable({ status: 'sent', updated_at: at(1e9) }, now)).toBe(
      false
    );
  });
  it('retries a failed one', () => {
    expect(isClaimRetryable({ status: 'failed', updated_at: at(0) }, now)).toBe(
      true
    );
  });
  it('never retries one that may already be with WhatsApp', () => {
    for (const status of ['sending', 'failed']) {
      expect(
        isClaimRetryable(
          { status, updated_at: at(1e9), error_code: DELIVERY_UNCONFIRMED },
          now
        )
      ).toBe(false);
    }
  });
  it('retries a sending claim only once it is stale', () => {
    expect(
      isClaimRetryable({ status: 'sending', updated_at: at(1000) }, now)
    ).toBe(false);
    expect(
      isClaimRetryable(
        { status: 'sending', updated_at: at(STALE_CLAIM_MS + 1) },
        now
      )
    ).toBe(true);
  });
});

describe('serializeNotification', () => {
  const row = (over: Row) => ({
    id: 'n-1',
    idempotency_key: 'k',
    status: 'sending',
    error_code: DELIVERY_UNCONFIRMED,
    error_message: 'not confirmed',
    updated_at: new Date().toISOString(),
    ...over,
  });
  const stale = new Date(Date.now() - STALE_CLAIM_MS - 1000).toISOString();

  it('shows a marked send in flight as plain sending', () => {
    expect(serializeNotification(row({}))).toMatchObject({
      status: 'sending',
      error: null,
    });
  });
  it.each(['sending', 'failed'])(
    'shows a stale marked row stored as %s as failed, unconfirmed',
    (status) => {
      expect(
        serializeNotification(row({ status, updated_at: stale }))
      ).toMatchObject({
        status: 'failed',
        error: { code: DELIVERY_UNCONFIRMED, message: 'not confirmed' },
      });
    }
  );
  it('leaves a stale claim that was never handed over as sending', () => {
    expect(
      serializeNotification(
        row({ error_code: null, error_message: null, updated_at: stale })
      )
    ).toMatchObject({ status: 'sending', error: null });
  });
});

describe('sendCompassNotification', () => {
  it('sends on Meta only, as the Compass template to a customer who never wrote, without renaming or pausing flows', async () => {
    const { db, tables } = makeDb();
    const outcome = await sendCompassNotification(db, 'acct', baseRequest());

    // The gate asks the send core's own question: surface 'api' on
    // Meta, for a phone with no chat yet.
    expect(resolveSendChannel).toHaveBeenCalledWith(
      db,
      'acct',
      'api',
      null,
      'meta',
      null,
      undefined
    );
    expect(resolveConversationByPhone).toHaveBeenCalledWith(
      db,
      'acct',
      '+971501234567',
      null,
      { renameExisting: false }
    );
    const params = sendMessageToConversation.mock.calls[0][2];
    expect(params).toEqual({
      conversationId: 'conv-1',
      messageType: 'template',
      templateName: 'compass_case_approved',
      templateLanguage: 'en',
      templateParams: [
        'SILVER DUNE FURNITURE & DECOR IND. FACTORY LLC.',
        'NBF',
      ],
      surface: 'api',
      provider: 'meta',
      requireProvider: true,
      pauseActiveFlows: false,
      beforeGateway: expect.any(Function),
    });
    // No sender_id: nothing attributes the chat to a person.
    expect(params).not.toHaveProperty('senderUserId');

    expect(outcome.duplicate).toBe(false);
    expect(outcome.notification.status).toBe('sent');
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      message_id: 'msg-1',
      conversation_id: 'conv-1',
    });
  });

  it('sends free text inside the 24-hour window the customer opened on the Meta number', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb(chatOnMeta(2 * HOUR));
    await sendCompassNotification(db, 'acct', baseRequest());

    expect(resolveSendChannel).toHaveBeenCalledWith(
      db,
      'acct',
      'api',
      'conv-1',
      'meta',
      null,
      { channelId: 'cfg-meta', sendChannelId: null }
    );
    const params = sendMessageToConversation.mock.calls[0][2];
    expect(params).toMatchObject({
      messageType: 'text',
      contentText: APPROVED_TEXT,
      provider: 'meta',
      requireProvider: true,
    });
    expect(params).not.toHaveProperty('templateName');
  });

  it('uses the template once the window has closed', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb(chatOnMeta(24 * HOUR));
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
      templateName: 'compass_case_approved',
    });
  });

  it('does not count our own messages: only the customer opens the window', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const seed = chatOnMeta(HOUR);
    seed.messages[0].sender_type = 'agent';
    const { db } = makeDb(seed);
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
    });
  });

  it("judges the window on the customer's newest message", async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const seed = chatOnMeta(48 * HOUR);
    seed.messages.push({
      ...seed.messages[0],
      id: 'm-in-2',
      created_at: new Date(Date.now() - HOUR).toISOString(),
    });
    const { db } = makeDb(seed);
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'text',
    });
  });

  it('reads the window from the chat the update goes into, not another one', async () => {
    // A recent Meta message in a second chat of the same contact opens
    // nothing in the chat the send lands in (the first company chat).
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const seed = chatOnMeta(48 * HOUR);
    seed.conversations.push({
      ...seed.conversations[0],
      id: 'conv-2',
    });
    seed.messages.push({
      ...seed.messages[0],
      id: 'm-other',
      conversation_id: 'conv-2',
      created_at: new Date(Date.now() - HOUR).toISOString(),
    });
    const { db } = makeDb(seed);
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
    });
  });

  it('does not count a message the customer sent to another number', async () => {
    // The window is per number: writing to the Whapi number opens
    // nothing on Meta.
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb(chatOnMeta(HOUR, 'cfg-whapi'));
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
    });
  });

  it('sends the template when the window cannot be read', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb({ ...chatOnMeta(HOUR), failReads: ['messages'] });
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
    });
  });

  it.each(['messages', 'conversations'])(
    'answers 503, not a refusal, when %s cannot be read and no template carries it',
    async (table) => {
      findExistingContact.mockResolvedValue({ id: 'contact-1' });
      for (const over of [
        { text: 'Some wording of our own' },
        { type: 'image', media_url: 'https://x.example/a.png', text: 'x' },
      ]) {
        const { db, tables } = makeDb({
          ...chatOnMeta(HOUR),
          failReads: [table],
        });
        await expect(
          sendCompassNotification(db, 'acct', baseRequest(over))
        ).rejects.toMatchObject({ code: 'window_lookup_failed', status: 503 });
        expect(tables.compass_notifications[0]).toMatchObject({
          status: 'failed',
          error_code: 'window_lookup_failed',
        });
      }
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(resolveConversationByPhone).not.toHaveBeenCalled();
    }
  );

  it('sends the template when the chat cannot be read', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb({
      ...chatOnMeta(HOUR),
      failReads: ['conversations'],
    });
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
    });
  });

  it('answers 503, not 404, when the Compass customer cannot be read', async () => {
    const { db, tables } = makeDb({ failReads: ['compass_contacts'] });
    await expect(
      sendCompassNotification(
        db,
        'acct',
        baseRequest({ to: undefined, compass_id: 'C-1' })
      )
    ).rejects.toMatchObject({
      code: 'compass_contact_lookup_failed',
      status: 503,
    });
    expect(tables.compass_notifications[0].status).toBe('failed');
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('answers 503, not "no such key", when the stored row cannot be read', async () => {
    const { db } = makeDb({ failReads: ['compass_notifications'] });
    await expect(
      getNotificationByKey(db, 'acct', 'APP-1:approved')
    ).rejects.toMatchObject({
      code: 'notification_lookup_failed',
      status: 503,
    });
  });

  it('a sent message whose row cannot be re-read is still answered as sent', async () => {
    const { db } = makeDb({ failReads: ['compass_notifications'] });
    const outcome = await sendCompassNotification(db, 'acct', baseRequest());
    expect(outcome.notification.status).toBe('sent');
  });

  it('sends a submitted message as the submitted template', async () => {
    const { db } = makeDb();
    await sendCompassNotification(
      db,
      'acct',
      baseRequest({ event: 'case.submitted', text: SUBMITTED_TEXT })
    );
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
      templateName: 'compass_case_submitted',
      templateParams: ['BLUE PALM TRADING L.L.C', 'MASHREQ'],
    });
  });

  it('finds the template from the text when Compass sends no event', async () => {
    const { db } = makeDb();
    await sendCompassNotification(
      db,
      'acct',
      baseRequest({ event: undefined, text: SUBMITTED_TEXT })
    );
    expect(sendMessageToConversation.mock.calls[0][2].templateName).toBe(
      'compass_case_submitted'
    );
  });

  it('refuses, before creating a chat, a message no template matches', async () => {
    const { db, tables } = makeDb();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest({ text: 'Approved' }))
    ).rejects.toMatchObject({ code: 'no_template_for_message', status: 409 });
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'no_template_for_message',
    });
  });

  it('sends any wording as plain text inside the window', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb(chatOnMeta(HOUR));
    await sendCompassNotification(
      db,
      'acct',
      baseRequest({ text: 'Approved' })
    );
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'text',
      contentText: 'Approved',
    });
  });

  it('refuses a template that is missing, not approved yet, or edited', async () => {
    for (const templates of [
      [SUBMITTED_ROW],
      [SUBMITTED_ROW, { ...APPROVED_ROW, status: 'PENDING' }],
      [
        SUBMITTED_ROW,
        {
          ...APPROVED_ROW,
          body_text: String(APPROVED_ROW.body_text).replace('Dear', 'Hello'),
        },
      ],
    ]) {
      resolveConversationByPhone.mockClear();
      const { db } = makeDb({ templates });
      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toMatchObject({ code: 'meta_template_unusable', status: 409 });
      expect(resolveConversationByPhone).not.toHaveBeenCalled();
    }
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('refuses an image outside the window, and sends one inside it', async () => {
    const image = baseRequest({
      type: 'image',
      text: undefined,
      media_url: 'https://example.com/a.png',
    });
    const closed = makeDb();
    await expect(
      sendCompassNotification(closed.db, 'acct', image)
    ).rejects.toMatchObject({ code: 'outside_service_window', status: 409 });
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();

    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const open = makeDb(chatOnMeta(HOUR));
    await sendCompassNotification(open.db, 'acct', image);
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'image',
      mediaUrl: 'https://example.com/a.png',
      provider: 'meta',
    });
  });

  it('marks a contact it created as a Compass lead, and one it only found not at all', async () => {
    // Migration 249: the source is filled only when this notification
    // created the CRM contact (contact_set_lead_source_if_empty).
    resolveConversationByPhone.mockResolvedValue({
      conversationId: 'conv-1',
      contactId: 'contact-new',
      contactCreated: true,
      conversationCreated: true,
    });
    const created = makeDb({ ...chatOnMeta(48 * HOUR), rpc: () => true });
    await sendCompassNotification(created.db, 'acct', baseRequest());
    expect(created.rpcs).toEqual([
      {
        fn: 'contact_set_lead_source_if_empty',
        args: expect.objectContaining({
          p_contact: 'contact-new',
          p_source: 'compass',
        }),
      },
    ]);

    resolveConversationByPhone.mockResolvedValue({
      conversationId: 'conv-1',
      contactId: 'contact-1',
      contactCreated: false,
      conversationCreated: false,
    });
    const found = makeDb({ ...chatOnMeta(48 * HOUR), rpc: () => true });
    await sendCompassNotification(found.db, 'acct', baseRequest());
    expect(found.rpcs).toEqual([]);
  });

  it.each(['opted_out_at', 'do_not_contact_at'])(
    'refuses 1:1 a customer with %s set, in or out of the window; the key works after an opt-in',
    async (col) => {
      const { db, tables } = makeDb(chatOnMeta(HOUR));
      const customer = (at: string | null) => ({
        id: 'contact-1',
        phone: '971501234567',
        [col]: at,
      });
      findExistingContact.mockResolvedValue(customer('2026-11-23T08:00:00Z'));
      for (const req of [
        baseRequest(),
        baseRequest({ idempotency_key: 'APP-2', text: 'hello' }),
      ]) {
        await expect(
          sendCompassNotification(db, 'acct', req)
        ).rejects.toMatchObject({ code: 'customer_opted_out', status: 422 });
      }
      expect(resolveConversationByPhone).not.toHaveBeenCalled();
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(tables.compass_notifications[0]).toMatchObject({
        status: 'failed',
        error_code: 'customer_opted_out',
      });

      findExistingContact.mockResolvedValue(customer(null));
      const out = await sendCompassNotification(db, 'acct', baseRequest());
      expect(out.notification.status).toBe('sent');
    }
  );

  describe('an opt-out on any contact the phone matches', () => {
    const crm = (id: string, phone: string, over: Row = {}): Row => ({
      id,
      account_id: 'acct',
      phone,
      phone_normalized: phone.replace(/\D/g, ''),
      ...over,
    });
    const optedOut = { opted_out_at: '2026-11-01T00:00:00Z' };
    const exact = crm('full', '971501234567');

    it.each<[string, Row | null, Row[]]>([
      [
        'the older local-format twin of the exact match',
        exact,
        [crm('twin', '050 123 4567', optedOut), exact],
      ],
      [
        'one of two local-format rows, where no contact is picked',
        null,
        [
          crm('a', '0501234567'),
          crm('b', '50 123 4567', {
            do_not_contact_at: '2026-11-01T00:00:00Z',
          }),
        ],
      ],
    ])('refuses: %s', async (_label, found, crmContacts) => {
      const { db, tables } = makeDb({ crmContacts });
      findExistingContact.mockResolvedValue(found);
      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toMatchObject({ code: 'customer_opted_out', status: 422 });
      expect(resolveConversationByPhone).not.toHaveBeenCalled();
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(tables.compass_notifications[0].status).toBe('failed');
    });

    it("sends past another person's opt-out, in this account or another", async () => {
      const { db } = makeDb({
        crmContacts: [
          exact,
          // The same last eight digits, in Saudi Arabia.
          crm('ksa', '966501234567', optedOut),
          crm('other', '0501234567', { ...optedOut, account_id: 'acct-2' }),
        ],
      });
      findExistingContact.mockResolvedValue(exact);
      const out = await sendCompassNotification(db, 'acct', baseRequest());
      expect(out.notification.status).toBe('sent');
    });

    it('refuses, retryable, when the matches cannot be read', async () => {
      const { db } = makeDb({ failReads: ['contacts'] });
      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toMatchObject({ code: 'contact_lookup_failed', status: 503 });
      expect(sendMessageToConversation).not.toHaveBeenCalled();
    });
  });

  it('refuses, retryable and sending nothing, when the contact cannot be read', async () => {
    const { db, tables } = makeDb();
    findExistingContact.mockRejectedValue(new ContactLookupError('down'));
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'contact_lookup_failed', status: 503 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0].status).toBe('failed');
  });

  it('never touches conversation ownership', async () => {
    // The only table notify.ts writes is its own; ownership lives on
    // `conversations`, which it only reads itself (the Meta gate) and
    // otherwise reaches solely through the (mocked) resolver and send
    // core. With migration 236's switch off (no settings row) it reads
    // that switch and nothing else.
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db, written, rpcs } = makeDb(chatOnMeta(48 * HOUR));
    const from = vi.spyOn(db, 'from');
    await sendCompassNotification(db, 'acct', baseRequest());
    expect([...written].sort()).toEqual(['compass_notifications']);
    expect(rpcs).toEqual([]);
    const touched = new Set(from.mock.calls.map(([t]) => t));
    expect([...touched].sort()).toEqual([
      'assignment_settings',
      'compass_notifications',
      'contacts',
      'conversations',
      'message_templates',
      'messages',
    ]);
  });

  it('fails without falling back to Whapi or OpenWA when Meta is not connected', async () => {
    // With no Meta number the resolver falls back to another kind.
    for (const provider of ['whapi', 'openwa']) {
      resolveSendChannel.mockResolvedValue({ id: 'cfg-x', provider });
      const { db, tables } = makeDb();

      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toMatchObject({ code: 'meta_not_connected', status: 409 });
      // Nothing was created and nothing was sent.
      expect(resolveConversationByPhone).not.toHaveBeenCalled();
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(tables.compass_notifications[0]).toMatchObject({
        status: 'failed',
        error_code: 'meta_not_connected',
      });
    }
  });

  it('reports meta_not_connected when no WhatsApp number is connected at all', async () => {
    resolveSendChannel.mockRejectedValue(
      new ChannelError('whatsapp_not_configured', 'not configured', 400)
    );
    const { db } = makeDb();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'meta_not_connected', status: 409 });
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
  });

  it('refuses, before creating a chat, while the Meta number is marked disconnected', async () => {
    resolveSendChannel.mockResolvedValue({ ...META, status: 'disconnected' });
    const { db, tables } = makeDb();

    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'meta_not_connected', status: 409 });
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    // Failed, so the same key may be retried once it is back.
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'meta_not_connected',
    });

    resolveSendChannel.mockResolvedValue(META);
    const retry = await sendCompassNotification(db, 'acct', baseRequest());
    expect(retry.duplicate).toBe(false);
    expect(retry.notification.status).toBe('sent');
  });

  it('returns the stored result for a repeated key without sending again', async () => {
    const { db } = makeDb();
    await sendCompassNotification(db, 'acct', baseRequest());
    const again = await sendCompassNotification(db, 'acct', baseRequest());

    expect(again.duplicate).toBe(true);
    expect(again.notification.status).toBe('sent');
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
  });

  it('refuses a key another request is still sending', async () => {
    const { db } = makeDb({
      notifications: [
        {
          id: 'n-live',
          account_id: 'acct',
          idempotency_key: 'APP-1:approved',
          status: 'sending',
          updated_at: new Date().toISOString(),
        },
      ],
    });
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'in_progress', status: 409 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('lets a failed key be retried', async () => {
    const { db, tables } = makeDb({
      notifications: [
        {
          id: 'n-old',
          account_id: 'acct',
          idempotency_key: 'APP-1:approved',
          status: 'failed',
          error_code: 'whatsapp_error',
          updated_at: '2026-09-23T10:00:00.000Z',
        },
      ],
    });
    const outcome = await sendCompassNotification(db, 'acct', baseRequest());
    expect(outcome.duplicate).toBe(false);
    expect(tables.compass_notifications).toHaveLength(1);
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      error_code: null,
    });
  });

  it('keeps the key spent when the gateway accepted but the save failed', async () => {
    // A db_error from the send core happens only after WhatsApp took the
    // message. Freeing the key would let Compass send it twice.
    sendMessageToConversation.mockRejectedValue(
      new SendMessageError('db_error', 'saved failed', 500)
    );
    const { db, tables } = makeDb();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toBeInstanceOf(SendMessageError);
    expect(tables.compass_notifications[0].status).toBe('sent');
  });

  it('marks a gateway failure as failed so it can be retried', async () => {
    sendMessageToConversation.mockRejectedValue(
      new SendMessageError('whatsapp_error', 'gateway down', 502, true)
    );
    const { db, tables } = makeDb();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'whatsapp_error' });
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'whatsapp_error',
    });
  });

  it('marks the row before the gateway call and clears the mark once sent', async () => {
    const { db, tables } = makeDb();
    let during: Row = {};
    sendMessageToConversation.mockImplementation(async () => {
      during = { ...tables.compass_notifications[0] };
      return { messageId: 'msg-1', whatsappMessageId: 'wa-1' };
    });
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(during).toMatchObject({
      status: 'sending',
      error_code: DELIVERY_UNCONFIRMED,
    });
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      error_code: null,
    });
  });

  it('sends nothing when the mark cannot be written, and the key stays usable', async () => {
    let fail = true;
    const { db, tables } = makeDb({
      failUpdate: (p) => fail && p.error_code === DELIVERY_UNCONFIRMED,
    });
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'internal', status: 500 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0].status).toBe('failed');
    fail = false;
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a refusal', new SendMessageError('meta_not_connected', 'x', 409)],
    ['a failed read', new SendMessageError('internal', 'x', 500)],
    ['an unknown error', new Error('fetch failed')],
  ])(
    'keeps the key usable when the send core stops before the gateway: %s',
    async (_label, err) => {
      const { db, tables } = makeDb();
      sendCoreLoads.mockRejectedValueOnce(err);
      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toBe(err);
      expect(tables.compass_notifications[0].status).toBe('failed');
      const out = await sendCompassNotification(db, 'acct', baseRequest());
      expect(out.notification.status).toBe('sent');
    }
  );

  it('retries the sent record once', async () => {
    let fails = 1;
    const { db, tables } = makeDb({
      failUpdate: (p) => p.status === 'sent' && fails-- > 0,
    });
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      message_id: 'msg-1',
    });
  });

  it('answers sent but never sends again when the sent record cannot be written', async () => {
    const { db, tables } = makeDb({ failUpdate: (p) => p.status === 'sent' });
    const out = await sendCompassNotification(db, 'acct', baseRequest());
    expect(out.notification).toMatchObject({ status: 'sent', error: null });
    const row = tables.compass_notifications[0];
    expect(row).toMatchObject({
      status: 'sending',
      error_code: DELIVERY_UNCONFIRMED,
    });

    // Fresh: it may be a live send. Stale: unconfirmed, not sent again.
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'in_progress', status: 409 });
    row.updated_at = new Date(Date.now() - STALE_CLAIM_MS - 1).toISOString();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: DELIVERY_UNCONFIRMED, status: 409 });
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a gateway timeout', new SendMessageError('whatsapp_error', 'x', 502)],
    ['an unknown error', new Error('socket hang up')],
  ])('never sends again after %s', async (_label, err) => {
    const { db, tables } = makeDb();
    sendMessageToConversation.mockRejectedValue(err);
    for (let i = 0; i < 2; i++) {
      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toMatchObject({ code: DELIVERY_UNCONFIRMED, status: 409 });
    }
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: DELIVERY_UNCONFIRMED,
    });
  });

  describe('a claim that stalled and was taken over', () => {
    const stall = (row: Row) => {
      row.updated_at = new Date(Date.now() - STALE_CLAIM_MS - 1).toISOString();
    };

    it("a failure before the mark leaves the winner's sent row alone", async () => {
      const { db, tables } = makeDb();
      resolveConversationByPhone.mockImplementationOnce(async () => {
        // A stalls here; B reclaims the key, sends and records it.
        stall(tables.compass_notifications[0]);
        await sendCompassNotification(db, 'acct', baseRequest());
        throw new Error('A fails late');
      });
      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toThrow('A fails late');
      expect(tables.compass_notifications[0]).toMatchObject({
        status: 'sent',
        error_code: null,
        message_id: 'msg-1',
      });

      const again = await sendCompassNotification(db, 'acct', baseRequest());
      expect(again.duplicate).toBe(true);
      expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
    });

    it("does not hand over on the winner's claim, nor write to its row", async () => {
      const { db, tables } = makeDb();
      const taken = new Date(Date.now() + 1000).toISOString();
      resolveConversationByPhone.mockImplementationOnce(async () => {
        tables.compass_notifications[0].updated_at = taken; // B, not yet marked
        return { conversationId: 'conv-1', contactId: 'contact-1' };
      });
      await expect(
        sendCompassNotification(db, 'acct', baseRequest())
      ).rejects.toMatchObject({ code: 'in_progress', status: 409 });
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(tables.compass_notifications[0]).toMatchObject({
        status: 'sending',
        error_code: null,
        updated_at: taken,
      });
    });

    it('a group update posted late does not overwrite the row either', async () => {
      const { db, tables } = makeDb({
        groups: [
          {
            id: 'g-1',
            account_id: 'acct',
            submission_ref: 'SUB-1',
            contact_id: null,
          },
        ],
      });
      const row = () => tables.compass_notifications[0];
      await sendCompassNotification(
        db,
        'acct',
        baseRequest({ reference: 'SUB-1' }),
        {
          groupSender: async () => {
            row().updated_at = new Date(Date.now() + 1000).toISOString();
            row().group_message_id = 'B';
            return { status: 'sent', messageId: 'A' } as never;
          },
        }
      );
      expect(row().group_message_id).toBe('B');
    });
  });

  it('does not send a claim another request already handed over, nor touch its row', async () => {
    const { db, tables } = makeDb();
    resolveConversationByPhone.mockImplementation(async () => {
      tables.compass_notifications[0].error_code = DELIVERY_UNCONFIRMED;
      return { conversationId: 'conv-1', contactId: 'contact-1' };
    });
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'in_progress', status: 409 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0].status).toBe('sending');
  });

  it('resolves the phone and name from a synced Compass customer, and links it', async () => {
    const { db, tables } = makeDb({
      contacts: [
        {
          account_id: 'acct',
          compass_id: 'CUST-1',
          name: 'Jane',
          phone: '971509999999',
          contact_id: null,
        },
      ],
    });
    await sendCompassNotification(
      db,
      'acct',
      parseNotificationRequest({
        idempotency_key: 'k1',
        compass_id: 'CUST-1',
        text: APPROVED_TEXT,
        event: 'case.approved',
      })
    );
    expect(resolveConversationByPhone).toHaveBeenCalledWith(
      db,
      'acct',
      '+971509999999',
      'Jane',
      { renameExisting: false }
    );
    expect(tables.compass_contacts[0].contact_id).toBe('contact-1');
    expect(tables.compass_notifications[0].phone).toBe('971509999999');
  });

  it('404s an unknown compass_id and records the failure', async () => {
    const { db, tables } = makeDb();
    await expect(
      sendCompassNotification(
        db,
        'acct',
        parseNotificationRequest({
          idempotency_key: 'k2',
          compass_id: 'NOPE',
          text: APPROVED_TEXT,
          event: 'case.approved',
        })
      )
    ).rejects.toMatchObject({ code: 'compass_contact_not_found', status: 404 });
    expect(tables.compass_notifications[0].status).toBe('failed');
  });

  it('normalizes a valid synced phone before using it', async () => {
    const { db, tables } = makeDb({
      contacts: [
        {
          account_id: 'acct',
          compass_id: 'CUST-2',
          name: 'Omar',
          // Stored before the sync normalized: trunk 0 after 971.
          phone: '+971 050 999 9999',
        },
      ],
    });
    await sendCompassNotification(
      db,
      'acct',
      parseNotificationRequest({
        idempotency_key: 'k-norm',
        compass_id: 'CUST-2',
        text: APPROVED_TEXT,
        event: 'case.approved',
      })
    );
    expect(resolveConversationByPhone.mock.calls[0][2]).toBe('+971509999999');
    expect(tables.compass_notifications[0].phone).toBe('971509999999');
  });

  it('refuses a synced phone that is not a valid international number', async () => {
    // A 9-digit local number stored before the sync enforced the rule.
    // Sending to it would create a contact and report 'sent' to nobody.
    const { db, tables } = makeDb({
      contacts: [
        {
          account_id: 'acct',
          compass_id: 'CUST-9',
          name: 'Bad',
          phone: '557123456',
        },
      ],
    });
    const request = parseNotificationRequest({
      idempotency_key: 'k-bad',
      compass_id: 'CUST-9',
      text: APPROVED_TEXT,
      event: 'case.approved',
    });

    const err = await sendCompassNotification(db, 'acct', request).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(NotifyError);
    expect(err).toMatchObject({ code: 'invalid_phone', status: 422 });
    expect((err as NotifyError).message).toMatch(
      /^Compass customer "CUST-9" has a synced phone that is not a valid international number \('phone' "557123456" is too short/
    );
    // Nothing was looked up, created or sent.
    expect(resolveSendChannel).not.toHaveBeenCalled();
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'invalid_phone',
    });

    // The key stays retryable: once the phone is re-synced, the same
    // key sends.
    tables.compass_contacts[0].phone = '971557123456';
    const retry = await sendCompassNotification(db, 'acct', request);
    expect(retry.duplicate).toBe(false);
    expect(retry.notification.status).toBe('sent');
    expect(resolveConversationByPhone.mock.calls[0][2]).toBe('+971557123456');
  });

  it('lets an explicit to override an invalid synced phone', async () => {
    const { db } = makeDb({
      contacts: [
        { account_id: 'acct', compass_id: 'CUST-9', phone: '557123456' },
      ],
    });
    const outcome = await sendCompassNotification(
      db,
      'acct',
      parseNotificationRequest({
        idempotency_key: 'k-to',
        compass_id: 'CUST-9',
        to: '+971557123456',
        text: APPROVED_TEXT,
        event: 'case.approved',
      })
    );
    expect(outcome.notification.status).toBe('sent');
  });

  it('reports a synced customer with no phone', async () => {
    const { db } = makeDb({
      contacts: [{ account_id: 'acct', compass_id: 'C', phone: null }],
    });
    await expect(
      sendCompassNotification(
        db,
        'acct',
        parseNotificationRequest({
          idempotency_key: 'k3',
          compass_id: 'C',
          text: APPROVED_TEXT,
          event: 'case.approved',
        })
      )
    ).rejects.toMatchObject({ code: 'no_phone', status: 422 });
  });
});

describe('sendCompassNotification into a submission group (170)', () => {
  const group = (over: Row = {}): Row => ({
    id: 'g-ref',
    account_id: 'acct',
    submission_ref: 'sub-1',
    contact_id: 'contact-g',
    wa_mode: 'group',
    status: 'ACTIVE',
    wa_group_id: '120@g.us',
    wa_closed_at: null,
    created_at: '2026-11-01T00:00:00Z',
    ...over,
  });
  const sent = (messageId = '41') => ({
    status: 'sent' as const,
    messageId,
    waMessageId: 'wa-g',
  });

  it('sends a reference match into the group only, nothing 1:1', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const groupSender = vi.fn().mockResolvedValue(sent());
    const outcome = await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'sub-1' }),
      { groupSender }
    );
    expect(groupSender).toHaveBeenCalledWith({
      groupId: 'g-ref',
      kind: 'status_update',
      key: 'compass:APP-1:approved',
      text: APPROVED_TEXT,
      beforeGateway: expect.any(Function),
    });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
    expect(resolveSendChannel).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      submission_group_id: 'g-ref',
      group_message_id: '41',
      contact_id: 'contact-g',
      message_id: null,
      conversation_id: null,
    });
    expect(outcome.notification).toMatchObject({
      delivered_to: 'group',
      submission_group_id: 'g-ref',
    });
  });

  it("uses the contact's newest live group when the reference matches none", async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-g' });
    const { db, tables } = makeDb({
      groups: [
        group({ id: 'g-old', submission_ref: 'a' }),
        group({
          id: 'g-new',
          submission_ref: 'b',
          created_at: '2026-11-02T00:00:00Z',
        }),
        group({
          id: 'g-none',
          submission_ref: 'c',
          wa_mode: 'none',
          wa_group_id: null,
          created_at: '2026-11-03T00:00:00Z',
        }),
        group({
          id: 'g-closed',
          submission_ref: 'd',
          status: 'ENDED',
          wa_closed_at: '2026-11-03T00:00:00Z',
          created_at: '2026-11-03T00:00:00Z',
        }),
      ],
    });
    const groupSender = vi.fn().mockResolvedValue(sent());
    await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'unknown' }),
      { groupSender }
    );
    expect(groupSender).toHaveBeenCalledTimes(1);
    expect(groupSender.mock.calls[0][0].groupId).toBe('g-new');
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0].submission_group_id).toBe('g-new');
  });

  it("never tries another case's group when the reference group refuses: 1:1", async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-g' });
    const { db, tables } = makeDb({
      groups: [
        group({ wa_mode: 'none', wa_group_id: null }),
        group({
          id: 'g-other',
          submission_ref: 'x',
          created_at: '2026-11-02T00:00:00Z',
        }),
      ],
    });
    const groupSender = vi
      .fn()
      .mockResolvedValue({ status: 'refused', code: 'NO_WHATSAPP_GROUP' });
    const outcome = await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'sub-1' }),
      { groupSender }
    );
    expect(groupSender.mock.calls.map((c) => c[0].groupId)).toEqual(['g-ref']);
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
    expect(tables.compass_notifications[0].submission_group_id ?? null).toBe(
      null
    );
    expect(outcome.notification.delivered_to).toBe('customer');
  });

  it('answers 503 and sends nothing when the group lookup fails', async () => {
    const { db, tables } = makeDb({
      groups: [group()],
      failReads: ['submission_groups'],
    });
    const groupSender = vi.fn();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest({ reference: 'sub-1' }), {
        groupSender,
      })
    ).rejects.toMatchObject({ code: 'group_lookup_failed', status: 503 });
    expect(groupSender).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0].status).toBe('failed');
  });

  it('answers 503 and sends nothing when the contact cannot be read', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    findExistingContact.mockRejectedValue(new ContactLookupError('down'));
    const groupSender = vi.fn();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest(), { groupSender })
    ).rejects.toMatchObject({ code: 'contact_lookup_failed', status: 503 });
    expect(groupSender).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'contact_lookup_failed',
    });
  });

  it('treats a duplicate that was sent as sent', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const groupSender = vi.fn().mockResolvedValue({
      status: 'duplicate',
      messageId: '7',
      sendStatus: 'sent',
    });
    await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'sub-1' }),
      { groupSender }
    );
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      group_message_id: '7',
    });
  });

  /** A groupSender that reaches the gateway (row `id`) and ends as `outcome`. */
  const handsOver =
    (id: string, outcome: (id: string) => unknown) =>
    async (input: { beforeGateway: (id: string) => Promise<void> }) => {
      await input.beforeGateway(id);
      const r = outcome(id);
      if (r instanceof Error) throw r;
      return r as never;
    };
  const timedOut = (id: string) =>
    new SubmissionGroupSendUnconfirmedError(id, new Error('timeout'));
  const refusedBy = (id: string) =>
    new SubmissionGroupSystemNotSentError(id, new Error('403'));
  const aWhileAgo = () =>
    new Date(Date.now() - GROUP_RETRY_MS - 1000).toISOString();
  const refReq = () => baseRequest({ reference: 'sub-1' });

  it('marks the row with its group right before the gateway, and clears the mark once sent', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const groupSender = handsOver('41', () => {
      expect(tables.compass_notifications[0]).toMatchObject({
        status: 'sending',
        error_code: DELIVERY_UNCONFIRMED,
        submission_group_id: 'g-ref',
        group_message_id: '41',
        contact_id: 'contact-g',
      });
      return sent('41');
    });
    const outcome = await sendCompassNotification(db, 'acct', refReq(), {
      groupSender,
    });
    expect(outcome.notification).toMatchObject({
      status: 'sent',
      delivered_to: 'group',
      error: null,
    });
  });

  it('a timeout in the group is delivery_unconfirmed: never posted again, never 1:1', async () => {
    const { db, tables } = makeDb({
      groups: [group()],
      groupMessages: [{ id: '41', send_status: 'failed' }],
    });
    await expect(
      sendCompassNotification(db, 'acct', refReq(), {
        groupSender: handsOver('41', timedOut),
      })
    ).rejects.toMatchObject({ code: DELIVERY_UNCONFIRMED, status: 409 });
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: DELIVERY_UNCONFIRMED,
    });
    expect(
      serializeNotification(tables.compass_notifications[0])
    ).toMatchObject({ status: 'failed', delivered_to: null });

    const groupSender = vi.fn();
    await expect(
      sendCompassNotification(db, 'acct', refReq(), { groupSender })
    ).rejects.toMatchObject({ code: DELIVERY_UNCONFIRMED, status: 409 });
    expect(groupSender).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('an untyped error after the hand-over is unconfirmed too', async () => {
    const { db } = makeDb({ groups: [group()] });
    await expect(
      sendCompassNotification(db, 'acct', refReq(), {
        groupSender: handsOver('41', () => new Error('socket hang up')),
      })
    ).rejects.toMatchObject({ code: DELIVERY_UNCONFIRMED, status: 409 });
  });

  it('a crash after the hand-over is final once the claim is stale', async () => {
    const { db } = makeDb({
      groups: [group()],
      notifications: [
        {
          id: 'n-old',
          account_id: 'acct',
          idempotency_key: 'APP-1:approved',
          status: 'sending',
          error_code: DELIVERY_UNCONFIRMED,
          submission_group_id: 'g-ref',
          group_message_id: '41',
          updated_at: new Date(Date.now() - STALE_CLAIM_MS - 1).toISOString(),
        },
      ],
      groupMessages: [{ id: '41', send_status: 'failed' }],
    });
    const groupSender = vi.fn();
    await expect(
      sendCompassNotification(db, 'acct', refReq(), { groupSender })
    ).rejects.toMatchObject({ code: DELIVERY_UNCONFIRMED, status: 409 });
    expect(groupSender).not.toHaveBeenCalled();
  });

  it('a swept row under the key is unconfirmed, and names its message for the echo', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const groupSender = vi.fn().mockResolvedValue({
      status: 'duplicate',
      messageId: '7',
      sendStatus: 'failed',
    });
    await expect(
      sendCompassNotification(db, 'acct', refReq(), { groupSender })
    ).rejects.toMatchObject({ code: DELIVERY_UNCONFIRMED, status: 409 });
    expect(groupSender).toHaveBeenCalledTimes(1);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: DELIVERY_UNCONFIRMED,
      submission_group_id: 'g-ref',
      group_message_id: '7',
    });
  });

  it.each(['POST', 'GET'])(
    "WhatsApp's late echo settles it: a %s of the same key answers sent",
    async (method) => {
      const { db, tables } = makeDb({
        groups: [group()],
        groupMessages: [{ id: '41', send_status: 'failed' }],
      });
      await sendCompassNotification(db, 'acct', refReq(), {
        groupSender: handsOver('41', timedOut),
      }).catch(() => undefined);
      tables.submission_group_messages[0].send_status = 'sent';

      const groupSender = vi.fn();
      const n =
        method === 'GET'
          ? await getNotificationByKey(db, 'acct', 'APP-1:approved')
          : await sendCompassNotification(db, 'acct', refReq(), {
              groupSender,
            }).then((o) => {
              expect(o.duplicate).toBe(true);
              return o.notification;
            });
      expect(n).toMatchObject({
        status: 'sent',
        delivered_to: 'group',
        submission_group_id: 'g-ref',
        error: null,
      });
      expect(groupSender).not.toHaveBeenCalled();
      expect(tables.compass_notifications[0]).toMatchObject({
        status: 'sent',
        error_code: null,
      });
    }
  );

  it('whether the echo came cannot be read: 503, not final', async () => {
    const seed = {
      groups: [group()],
      groupMessages: [{ id: '41', send_status: 'failed' }],
      failReads: [] as string[],
    };
    const { db } = makeDb(seed);
    await sendCompassNotification(db, 'acct', refReq(), {
      groupSender: handsOver('41', timedOut),
    }).catch(() => undefined);
    seed.failReads.push('submission_group_messages');
    await expect(
      sendCompassNotification(db, 'acct', refReq(), { groupSender: vi.fn() })
    ).rejects.toMatchObject({ status: 503 });
  });

  it('a refusal spends nothing: however many, the key posts once the group takes it', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const keys: string[] = [];
    for (let n = 1; n <= 5; n++) {
      const id = `${40 + n}`;
      await expect(
        sendCompassNotification(db, 'acct', refReq(), {
          groupSender: async (input) => {
            keys.push(input.key);
            // Half of them fail on a read, before the gateway.
            if (n % 2) return handsOver(id, refusedBy)(input);
            throw refusedBy(id);
          },
        })
      ).rejects.toMatchObject({ code: 'group_send_failed', status: 502 });
      expect(tables.compass_notifications[0]).toMatchObject({
        status: 'failed',
        error_code: 'group_send_failed',
        submission_group_id: null,
        group_message_id: id,
      });
      tables.submission_group_messages.push({ id, created_at: aWhileAgo() });
    }
    const groupSender = vi.fn(handsOver('46', sent));
    const outcome = await sendCompassNotification(db, 'acct', refReq(), {
      groupSender,
    });
    expect(outcome.notification).toMatchObject({
      status: 'sent',
      delivered_to: 'group',
    });
    expect(keys).toEqual([
      'compass:APP-1:approved',
      'compass:APP-1:approved#r41',
      'compass:APP-1:approved#r42',
      'compass:APP-1:approved#r43',
      'compass:APP-1:approved#r44',
    ]);
    expect(tables.compass_notifications[0].group_message_id).toBe('46');
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('a lookup failure in between does not forget which key comes next', async () => {
    const seed = { groups: [group()], failReads: [] as string[] };
    const { db, tables } = makeDb(seed);
    await sendCompassNotification(db, 'acct', refReq(), {
      groupSender: handsOver('41', refusedBy),
    }).catch(() => undefined);
    tables.submission_group_messages.push({
      id: '41',
      created_at: aWhileAgo(),
    });
    seed.failReads.push('submission_groups');
    await sendCompassNotification(db, 'acct', refReq(), {
      groupSender: vi.fn(),
    }).catch(() => undefined);
    seed.failReads.pop();
    const groupSender = vi.fn(handsOver('42', sent));
    await sendCompassNotification(db, 'acct', refReq(), { groupSender });
    expect(groupSender).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'compass:APP-1:approved#r41' })
    );
  });

  it('a second try within a minute of the last answers 503 and asks nobody', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    await sendCompassNotification(db, 'acct', refReq(), {
      groupSender: handsOver('41', refusedBy),
    }).catch(() => undefined);
    tables.submission_group_messages.push({
      id: '41',
      created_at: new Date(Date.now() - 20_000).toISOString(),
    });
    const groupSender = vi.fn(handsOver('42', sent));
    for (let n = 0; n < 2; n++) {
      await expect(
        sendCompassNotification(db, 'acct', refReq(), { groupSender })
      ).rejects.toMatchObject({ code: 'group_retry_too_soon', status: 503 });
    }
    expect(groupSender).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    // Being told to wait does not move the minute.
    tables.submission_group_messages[0].created_at = aWhileAgo();
    await sendCompassNotification(db, 'acct', refReq(), { groupSender });
    expect(groupSender).toHaveBeenCalledTimes(1);
  });

  it('input the group send cannot take is an error, never sent 1:1', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    await expect(
      sendCompassNotification(db, 'acct', refReq(), {
        groupSender: async () => ({ status: 'refused', code: 'BAD_INPUT' }),
      })
    ).rejects.toMatchObject({ code: 'group_send_failed', status: 502 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0].status).toBe('failed');
  });

  it("the longest key's retry fits 170's system_key", async () => {
    // submission_group_messages.id is a bigint.
    const id = '9223372036854775807';
    const { db } = makeDb({
      groups: [group()],
      groupMessages: [{ id, created_at: aWhileAgo() }],
    });
    const idempotency_key = 'k'.repeat(200);
    expect(() =>
      baseRequest({ idempotency_key: `${idempotency_key}k` })
    ).toThrow(/200/);
    const request = baseRequest({ idempotency_key, reference: 'sub-1' });
    await sendCompassNotification(db, 'acct', request, {
      groupSender: handsOver(id, refusedBy),
    }).catch(() => undefined);
    const groupSender = vi.fn(handsOver('42', sent));
    await sendCompassNotification(db, 'acct', request, { groupSender });
    const { key } = groupSender.mock.calls[0][0] as unknown as { key: string };
    expect(key).toBe(`compass:${idempotency_key}#r${id}`);
    expect(key.length).toBeLessThanOrEqual(240);
  });

  it('goes 1:1 when the group is gone after a try that sent nothing', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db, tables } = makeDb({
      groups: [group()],
      ...chatOnMeta(HOUR),
      groupMessages: [{ id: '41', created_at: aWhileAgo() }],
    });
    await sendCompassNotification(db, 'acct', refReq(), {
      groupSender: handsOver('41', refusedBy),
    }).catch(() => undefined);
    const outcome = await sendCompassNotification(db, 'acct', refReq(), {
      groupSender: async () => ({ status: 'refused', code: 'WA_CLOSED' }),
    });
    expect(outcome.notification).toMatchObject({
      status: 'sent',
      delivered_to: 'customer',
      submission_group_id: null,
    });
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
    expect(tables.compass_notifications[0].group_message_id).toBeNull();
  });

  it('a group that lost its number in between goes 1:1; a failed 1:1 comes back to a fresh key', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    sendMessageToConversation.mockRejectedValueOnce(
      new SendMessageError('whatsapp_error', 'refused', 502, true)
    );
    const { db, tables } = makeDb({
      groups: [group()],
      ...chatOnMeta(HOUR),
      groupMessages: [{ id: '41', created_at: aWhileAgo() }],
    });
    await expect(
      sendCompassNotification(db, 'acct', refReq(), {
        groupSender: async () => ({
          status: 'refused',
          code: 'NUMBER_REMOVED',
          messageId: '41',
        }),
      })
    ).rejects.toMatchObject({ code: 'whatsapp_error' });
    expect(tables.compass_notifications[0]).toMatchObject({
      submission_group_id: null,
      group_message_id: '41',
    });
    const groupSender = vi.fn(handsOver('42', sent));
    await sendCompassNotification(db, 'acct', refReq(), { groupSender });
    expect(groupSender.mock.calls[0][0]).toMatchObject({
      key: 'compass:APP-1:approved#r41',
    });
  });

  it('a retry after an opt-out block is still refused, never sent 1:1', async () => {
    const { db } = makeDb({ groups: [group()] });
    const groupSender = vi.fn().mockResolvedValue({
      status: 'duplicate',
      messageId: '7',
      sendStatus: 'blocked',
    });
    await expect(
      sendCompassNotification(db, 'acct', baseRequest({ reference: 'sub-1' }), {
        groupSender,
      })
    ).rejects.toMatchObject({ code: 'customer_opted_out', status: 422 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('refuses with 422 and sends nothing 1:1 when the customer opted out', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const groupSender = vi
      .fn()
      .mockResolvedValue({ status: 'blocked', reason: 'opted_out' });
    await expect(
      sendCompassNotification(db, 'acct', baseRequest({ reference: 'sub-1' }), {
        groupSender,
      })
    ).rejects.toMatchObject({ code: 'customer_opted_out', status: 422 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'customer_opted_out',
    });
  });

  it('records a gateway error as failed 502, so a retry is allowed', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const groupSender = vi.fn().mockRejectedValue(new Error('whapi 500'));
    await expect(
      sendCompassNotification(db, 'acct', baseRequest({ reference: 'sub-1' }), {
        groupSender,
      })
    ).rejects.toMatchObject({ code: 'group_send_failed', status: 502 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'group_send_failed',
    });
  });

  it('keeps the key spent when WhatsApp has it but the row was not settled', async () => {
    const { db, tables } = makeDb({ groups: [group()] });
    const groupSender = vi
      .fn()
      .mockRejectedValue(
        new SubmissionGroupSentNotRecordedError('9', 'wa-9', new Error('x'))
      );
    const outcome = await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'sub-1' }),
      { groupSender }
    );
    expect(outcome.notification.status).toBe('sent');
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      submission_group_id: 'g-ref',
      group_message_id: '9',
    });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('sends an image 1:1 even when there is a group', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb({ groups: [group()], ...chatOnMeta(HOUR) });
    const groupSender = vi.fn();
    await sendCompassNotification(
      db,
      'acct',
      baseRequest({
        reference: 'sub-1',
        type: 'image',
        text: undefined,
        media_url: 'https://example.com/a.png',
      }),
      { groupSender }
    );
    expect(groupSender).not.toHaveBeenCalled();
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
  });

  it('sends 1:1 as before when the customer has no group', async () => {
    const { db, tables } = makeDb();
    const groupSender = vi.fn();
    const outcome = await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'sub-1' }),
      { groupSender }
    );
    expect(groupSender).not.toHaveBeenCalled();
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      message_id: 'msg-1',
    });
    expect(outcome.notification.delivered_to).toBe('customer');
  });
});

// Migration 236: Compass assignment. Off (the default, or no settings
// row) notify behaves exactly as before: it reads the switch and never
// touches ownership, cases or any RPC.
describe('sendCompassNotification — Compass assignment (236)', () => {
  const caseRow = (over: Row = {}): Row => ({
    id: 'case-1',
    account_id: 'acct',
    group_id: 'g-1',
    contact_id: null,
    agent_id: 'agent-1',
    coordinator_id: 'coord-1',
    bank_code: 'ADCB',
    closed_at: null,
    ...over,
  });
  const groupRow: Row = {
    id: 'g-1',
    account_id: 'acct',
    submission_ref: 'SUB-9',
    contact_id: 'contact-1',
  };
  const seedChat = () => {
    const chat = chatOnMeta(HOUR);
    return {
      ...chat,
      conversations: chat.conversations.map((c) => ({
        ...c,
        assigned_agent_id: null as string | null,
      })),
    };
  };
  const compassAnswer = {
    data: {
      enabled: true,
      assigned_to: 'agent-1',
      reason: 'assigned',
      shared_with: 'coord-1',
      share_created: true,
      share_reason: 'shared',
    },
    error: null,
  };

  const offCases: [string, Row[]][] = [
    ['no settings row', []],
    ['the switch off', [{ account_id: 'acct', compass_assign_enabled: false }]],
  ];
  for (const [label, settings] of offCases) {
    it(`with ${label} never touches ownership`, async () => {
      const { db, tables, written, read, rpcs } = makeDb({
        ...seedChat(),
        settings,
        cases: [caseRow()],
        groups: [groupRow],
      });
      const outcome = await sendCompassNotification(
        db,
        'acct',
        baseRequest({ reference: 'SUB-9' })
      );
      expect(outcome.notification.status).toBe('sent');
      expect(rpcs).toEqual([]);
      expect(read.has('cases')).toBe(false);
      expect(written.has('conversations')).toBe(false);
      expect(tables.conversations[0].assigned_agent_id).toBeNull();
    });
  }

  it('on: the case named by the reference gives its agent and coordinator', async () => {
    const { db, rpcs } = makeDb({
      ...seedChat(),
      settings: [{ account_id: 'acct', compass_assign_enabled: true }],
      cases: [caseRow()],
      groups: [groupRow],
      rpc: () => compassAnswer,
    });
    const outcome = await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'SUB-9' })
    );
    expect(outcome.notification.status).toBe('sent');
    expect(rpcs).toEqual([
      {
        fn: 'assignment_compass_assign',
        args: {
          p_account_id: 'acct',
          p_conversation_id: 'conv-1',
          p_agent_user_id: 'agent-1',
          p_coordinator_user_id: 'coord-1',
          p_bank_code: 'ADCB',
        },
      },
    ]);
  });

  it("on, no reference: the contact's one open case", async () => {
    const { db, rpcs } = makeDb({
      ...seedChat(),
      settings: [{ account_id: 'acct', compass_assign_enabled: true }],
      cases: [
        caseRow({
          id: 'lead-1',
          group_id: null,
          contact_id: 'contact-1',
          agent_id: 'agent-7',
        }),
        caseRow({
          id: 'old',
          group_id: null,
          contact_id: 'contact-1',
          closed_at: '2026-01-01',
        }),
      ],
      rpc: () => compassAnswer,
    });
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].args).toMatchObject({ p_agent_user_id: 'agent-7' });
  });

  it('on, several open cases: nothing is assigned rather than guessing', async () => {
    const { db, rpcs } = makeDb({
      ...seedChat(),
      settings: [{ account_id: 'acct', compass_assign_enabled: true }],
      cases: [
        caseRow({ id: 'c-a', group_id: null, contact_id: 'contact-1' }),
        caseRow({ id: 'c-b', group_id: 'g-1' }),
      ],
      groups: [groupRow],
      rpc: () => compassAnswer,
    });
    await sendCompassNotification(db, 'acct', baseRequest());
    expect(rpcs).toEqual([]);
  });

  it('on, a referenced case of another customer is not used', async () => {
    const { db, rpcs } = makeDb({
      ...seedChat(),
      settings: [{ account_id: 'acct', compass_assign_enabled: true }],
      cases: [caseRow({ contact_id: 'someone-else' })],
      groups: [{ ...groupRow, contact_id: 'someone-else' }],
      rpc: () => compassAnswer,
    });
    await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'SUB-9' })
    );
    expect(rpcs).toEqual([]);
  });

  it('a failing assignment never fails a sent notification', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({
      ...seedChat(),
      settings: [{ account_id: 'acct', compass_assign_enabled: true }],
      cases: [caseRow()],
      groups: [groupRow],
      rpc: () => {
        throw new Error('db down');
      },
    });
    const outcome = await sendCompassNotification(
      db,
      'acct',
      baseRequest({ reference: 'SUB-9' })
    );
    expect(outcome.notification.status).toBe('sent');
    quiet.mockRestore();
  });
});
