import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sendMessageToConversation: vi.fn(),
  findMatchingContacts: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({ accountId: 'acct-1', supabase: {} })),
}));
vi.mock('@/lib/contacts/dedupe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/dedupe')>()),
  findMatchingContacts: h.findMatchingContacts,
}));
vi.mock('@/lib/whatsapp/resolve-conversation', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/whatsapp/resolve-conversation')
  >()),
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'cv-1',
    contactId: 'c-1',
    contactCreated: false,
  })),
}));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: h.sendMessageToConversation,
}));

import { ContactLookupError } from '@/lib/contacts/dedupe';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { POST } from './route';

const { sendMessageToConversation, findMatchingContacts } = h;

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/v1/messages', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  sendMessageToConversation.mockReset();
  findMatchingContacts.mockReset().mockResolvedValue([]);
  vi.mocked(resolveConversationByPhone).mockClear();
});

describe('POST /api/v1/messages and the number daily limit (migration 204)', () => {
  it('holds the send to the limit', async () => {
    sendMessageToConversation.mockResolvedValue({
      messageId: 'm-1',
      whatsappMessageId: 'wamid-1',
    });
    const res = await post({ to: '+971501234567', text: 'Hi' });
    expect(res.status).toBe(201);
    expect(sendMessageToConversation).toHaveBeenCalledWith(
      {},
      'acct-1',
      expect.objectContaining({
        surface: 'api',
        enforceNumberDailyLimit: true,
      })
    );
  });

  it('answers 429 number_daily_limit when the start is refused', async () => {
    sendMessageToConversation.mockRejectedValue(
      new SendMessageError(
        'number_daily_limit',
        'This WhatsApp number has started 30 new chats today, its daily limit.',
        429
      )
    );
    const res = await post({ to: '+971501234567', text: 'Hi' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: {
        code: 'number_daily_limit',
        message:
          'This WhatsApp number has started 30 new chats today, its daily limit.',
      },
    });
  });
});

describe('POST /api/v1/messages and the consent register', () => {
  const at = '2026-11-01T00:00:00Z';
  const refused = {
    error: {
      code: 'customer_opted_out',
      message:
        'The customer has opted out of WhatsApp messages. Nothing was sent.',
    },
  };

  it('has the core ask the contact', async () => {
    sendMessageToConversation.mockResolvedValue({ messageId: 'm-1' });
    await post({ to: '+971501234567', text: 'Hi' });
    expect(sendMessageToConversation).toHaveBeenCalledWith(
      {},
      'acct-1',
      expect.objectContaining({ respectConsent: true })
    );
  });

  it.each(['opted_out', 'do_not_contact'])(
    'answers 422 customer_opted_out for the core refusal %s',
    async (code) => {
      sendMessageToConversation.mockRejectedValue(
        new SendMessageError(code, 'no', 409)
      );
      const res = await post({ to: '+971501234567', text: 'Hi' });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual(refused);
    }
  );

  it.each([{ opted_out_at: at }, { do_not_contact_at: at }])(
    'refuses on a twin contact, touching nothing: %j',
    async (mark) => {
      findMatchingContacts.mockResolvedValue([
        { id: 'c-1', phone: '971501234567' },
        { id: 'c-2', phone: '0501234567', ...mark },
      ]);
      const res = await post({ to: '+971 50 123 4567', text: 'Hi' });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual(refused);
      expect(findMatchingContacts).toHaveBeenCalledWith(
        {},
        'acct-1',
        '971501234567'
      );
      expect(resolveConversationByPhone).not.toHaveBeenCalled();
      expect(sendMessageToConversation).not.toHaveBeenCalled();
    }
  );

  it('sends nothing and answers 503 when the contacts cannot be read', async () => {
    findMatchingContacts.mockRejectedValue(new ContactLookupError('timeout'));
    const res = await post({ to: '+971501234567', text: 'Hi' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('still answers 400 for a number that is not one', async () => {
    const res = await post({ to: '9.71505E+11', text: 'Hi' });
    expect(res.status).toBe(400);
    expect(findMatchingContacts).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/messages template values', () => {
  const template = (params: unknown) =>
    post({
      to: '+971501234567',
      type: 'template',
      template: { name: 'rate_offer', params },
    });

  it('sends a number as text, in its own place', async () => {
    sendMessageToConversation.mockResolvedValue({
      messageId: 'm-1',
      whatsappMessageId: 'wamid-1',
    });
    expect((await template(['Jane', 50000, '5.9'])).status).toBe(201);
    expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      templateParams: ['Jane', '50000', '5.9'],
    });
    expect((await template({ body: ['Jane', 50000] })).status).toBe(201);
    expect(sendMessageToConversation.mock.calls[1][2]).toMatchObject({
      templateMessageParams: { body: ['Jane', '50000'] },
    });
  });

  it('refuses any other value before anything is created or sent', async () => {
    for (const params of [['Jane', null, '5.9'], { body: ['Jane', true] }]) {
      const res = await template(params);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    }
    expect(vi.mocked(resolveConversationByPhone)).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });
});
