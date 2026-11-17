import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessageToConversation } = vi.hoisted(() => ({
  sendMessageToConversation: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({ accountId: 'acct-1', supabase: {} })),
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'cv-1',
    contactId: 'c-1',
    contactCreated: false,
  })),
}));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation,
}));

import { SendMessageError } from '@/lib/whatsapp/send-message';
import { POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/v1/messages', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  sendMessageToConversation.mockReset();
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
