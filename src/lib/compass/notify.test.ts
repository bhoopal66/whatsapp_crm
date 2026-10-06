import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const resolveSendChannel = vi.fn();
const findExistingContact = vi.fn();
const resolveConversationByPhone = vi.fn();
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
    sendMessageToConversation: (...args: unknown[]) =>
      sendMessageToConversation(...args),
  };
});

import {
  isClaimRetryable,
  NotifyError,
  parseNotificationRequest,
  sendCompassNotification,
  STALE_CLAIM_MS,
} from './notify';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { ChannelError } from '@/lib/whatsapp/channels';

// ------------------------------------------------------------
// In-memory stand-in for the two Compass tables (and the chats the
// Whapi gate reads) — just enough of the PostgREST builder for the
// chains notify.ts uses: insert/select/update with `.eq` filters,
// terminated by single/maybeSingle/await.
// ------------------------------------------------------------
type Row = Record<string, unknown>;

function makeDb(
  seed: { contacts?: Row[]; notifications?: Row[]; conversations?: Row[] } = {}
) {
  const tables: Record<string, Row[]> = {
    compass_contacts: seed.contacts ?? [],
    compass_notifications: seed.notifications ?? [],
    conversations: seed.conversations ?? [],
  };
  let nextId = 1;
  /** Every table an insert or update was run against. */
  const written = new Set<string>();

  const db = {
    from(table: string) {
      const rows = tables[table];
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      const filters: [string, unknown][] = [];
      const matching = () =>
        rows.filter((r) => filters.every(([k, v]) => r[k] === v));

      const run = (): { data: unknown; error: unknown } => {
        if (op !== 'select') written.add(table);
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
          filters.push([k, v]);
          return builder;
        },
        order: () => builder,
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
  return { db: db as unknown as SupabaseClient, tables, written };
}

const WHAPI = { id: 'cfg-whapi', provider: 'whapi', status: 'connected' };

beforeEach(() => {
  resolveSendChannel.mockReset().mockResolvedValue(WHAPI);
  findExistingContact.mockReset().mockResolvedValue(null);
  resolveConversationByPhone.mockReset().mockResolvedValue({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
    conversationCreated: false,
  });
  sendMessageToConversation.mockReset().mockResolvedValue({
    messageId: 'msg-1',
    whatsappMessageId: 'wa-1',
  });
});

const baseRequest = (over: Record<string, unknown> = {}) =>
  parseNotificationRequest({
    idempotency_key: 'APP-1:approved',
    to: '+971501234567',
    text: 'Approved',
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

describe('sendCompassNotification', () => {
  it('sends on Whapi only, into the existing chat, without renaming or pausing flows', async () => {
    const { db, tables } = makeDb();
    const outcome = await sendCompassNotification(db, 'acct', baseRequest());

    // The gate asks the send core's own question: surface 'api' on
    // Whapi, for a phone with no chat yet.
    expect(resolveSendChannel).toHaveBeenCalledWith(
      db,
      'acct',
      'api',
      null,
      'whapi',
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
    expect(sendMessageToConversation).toHaveBeenCalledWith(
      db,
      'acct',
      expect.objectContaining({
        conversationId: 'conv-1',
        provider: 'whapi',
        requireProvider: true,
        pauseActiveFlows: false,
      })
    );
    // No sender_id: nothing attributes the chat to a person.
    expect(sendMessageToConversation.mock.calls[0][2]).not.toHaveProperty(
      'senderUserId'
    );

    expect(outcome.duplicate).toBe(false);
    expect(outcome.notification.status).toBe('sent');
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'sent',
      message_id: 'msg-1',
      conversation_id: 'conv-1',
    });
  });

  it('never touches conversation ownership', async () => {
    // The only tables notify.ts writes are its own two; ownership lives
    // on `conversations`, which it only reads itself (the Whapi gate)
    // and otherwise reaches solely through the (mocked) resolver and
    // send core.
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db, written } = makeDb({
      conversations: [
        {
          id: 'conv-1',
          account_id: 'acct',
          contact_id: 'contact-1',
          channel_id: 'cfg-whapi',
          send_channel_id: null,
        },
      ],
    });
    const from = vi.spyOn(db, 'from');
    await sendCompassNotification(db, 'acct', baseRequest());
    expect([...written].sort()).toEqual(['compass_notifications']);
    const touched = new Set(from.mock.calls.map(([t]) => t));
    expect([...touched].sort()).toEqual([
      'compass_notifications',
      'conversations',
    ]);
  });

  it('fails without falling back to Meta when Whapi is not connected', async () => {
    // With no Whapi number the resolver falls back to another kind.
    resolveSendChannel.mockResolvedValue({ id: 'cfg-meta', provider: 'meta' });
    const { db, tables } = makeDb();

    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'whapi_not_connected', status: 409 });
    // Nothing was created and nothing was sent.
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'whapi_not_connected',
    });
  });

  it('reports whapi_not_connected when no WhatsApp number is connected at all', async () => {
    resolveSendChannel.mockRejectedValue(
      new ChannelError('whatsapp_not_configured', 'not configured', 400)
    );
    const { db } = makeDb();
    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'whapi_not_connected', status: 409 });
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
  });

  it('gates on the number the chat sends from, not the default one', async () => {
    // Default Whapi number A is logged out; the customer's chat is on
    // healthy B. The send core would use B, so the gate must too.
    const A = { id: 'cfg-a', provider: 'whapi', status: 'disconnected' };
    const B = { id: 'cfg-b', provider: 'whapi', status: 'connected' };
    resolveSendChannel.mockImplementation(async (...args: unknown[]) =>
      (args[6] as { channelId: string | null } | undefined)?.channelId ===
      'cfg-b'
        ? B
        : A
    );
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db, tables } = makeDb({
      conversations: [
        {
          id: 'conv-1',
          account_id: 'acct',
          contact_id: 'contact-1',
          channel_id: 'cfg-b',
          send_channel_id: null,
        },
      ],
    });

    const outcome = await sendCompassNotification(db, 'acct', baseRequest());
    expect(outcome.notification.status).toBe('sent');
    expect(findExistingContact).toHaveBeenCalledWith(
      db,
      'acct',
      '971501234567'
    );
    expect(resolveSendChannel).toHaveBeenCalledWith(
      db,
      'acct',
      'api',
      'conv-1',
      'whapi',
      null,
      { channelId: 'cfg-b', sendChannelId: null }
    );
    expect(tables.compass_notifications[0].status).toBe('sent');
  });

  it('refuses when the chat’s own number is down even if the default is up', async () => {
    const A = { id: 'cfg-a', provider: 'whapi', status: 'connected' };
    const B = { id: 'cfg-b', provider: 'whapi', status: 'disconnected' };
    resolveSendChannel.mockImplementation(async (...args: unknown[]) =>
      (args[6] as { sendChannelId: string | null } | undefined)
        ?.sendChannelId === 'cfg-b'
        ? B
        : A
    );
    findExistingContact.mockResolvedValue({ id: 'contact-1' });
    const { db } = makeDb({
      conversations: [
        {
          id: 'conv-1',
          account_id: 'acct',
          contact_id: 'contact-1',
          channel_id: 'cfg-a',
          // Pinned to B by an agent (migration 061).
          send_channel_id: 'cfg-b',
        },
      ],
    });

    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'whapi_not_connected', status: 409 });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('refuses, before creating a chat, while the Whapi number is logged out', async () => {
    // The health monitor marks a logged-out number 'disconnected'.
    resolveSendChannel.mockResolvedValue({
      ...WHAPI,
      status: 'disconnected',
    });
    const { db, tables } = makeDb();

    await expect(
      sendCompassNotification(db, 'acct', baseRequest())
    ).rejects.toMatchObject({ code: 'whapi_not_connected', status: 409 });
    expect(resolveConversationByPhone).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
    // Failed, so the same key may be retried once the phone is re-paired.
    expect(tables.compass_notifications[0]).toMatchObject({
      status: 'failed',
      error_code: 'whapi_not_connected',
    });

    resolveSendChannel.mockResolvedValue({
      ...WHAPI,
      status: 'connected',
    });
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
      new SendMessageError('whatsapp_error', 'gateway down', 502)
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
        text: 'Hi',
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
          text: 'Hi',
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
        text: 'Hi',
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
      text: 'Approved',
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
        text: 'Approved',
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
          text: 'Hi',
        })
      )
    ).rejects.toMatchObject({ code: 'no_phone', status: 422 });
  });
});
