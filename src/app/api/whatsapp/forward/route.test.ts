import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// POST /api/whatsapp/forward — one message into several chats. Mocked at the
// module boundary: the send core, channel loading and media re-hosting each
// have their own tests; this covers what the route itself decides.
// ---------------------------------------------------------------------------

let sourceRow: Record<string, unknown> | null;
let sourceVisible: boolean;
let visibleTargets: string[];
/** The read that fails: the source, its chat or the destinations. */
let failing: 'messages' | 'conversations' | 'targets' | null;
const TIMEOUT = {
  message: 'canceling statement due to timeout',
  code: '57014',
};

function makeSupabase() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit']) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = () =>
        Promise.resolve(
          failing === table
            ? { data: null, error: TIMEOUT }
            : {
                data:
                  table === 'messages'
                    ? sourceRow
                    : sourceVisible
                      ? { id: 'conv-src' }
                      : null,
                error: null,
              }
        );
      // Awaited without a terminal: the target-visibility list.
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(
          failing === 'targets'
            ? { data: null, error: TIMEOUT }
            : { data: visibleTargets.map((id) => ({ id })), error: null }
        );
      return chain;
    },
  };
}

const requireRole = vi.fn();
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}));

const sendMessageToConversation = vi.fn();
vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: (...a: unknown[]) =>
    sendMessageToConversation(...a),
}));

const loadChannels = vi.fn();
vi.mock('@/lib/whatsapp/channels', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/channels')>()),
  loadChannels: (...a: unknown[]) => loadChannels(...a),
}));

const resolveForwardMediaUrl = vi.fn();
vi.mock('@/lib/whatsapp/forward-media', () => ({
  resolveForwardMediaUrl: (...a: unknown[]) => resolveForwardMediaUrl(...a),
}));

import { POST } from './route';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/whatsapp/forward', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

const TEXT_SOURCE = {
  id: 'msg-src',
  conversation_id: 'conv-src',
  content_type: 'text',
  content_text: 'hello there',
  media_url: null,
  media_type: null,
  created_at: '2026-09-23T10:00:00Z',
  provider: 'whapi',
};

describe('POST /api/whatsapp/forward', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
    sourceRow = TEXT_SOURCE;
    sourceVisible = true;
    failing = null;
    visibleTargets = ['conv-a', 'conv-b'];
    requireRole.mockResolvedValue({
      supabase: makeSupabase(),
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'agent',
    });
    sendMessageToConversation.mockImplementation(async (_db, _acct, p) => ({
      messageId: `new-${p.conversationId}`,
      whatsappMessageId: 'wa-1',
    }));
  });

  it('requires the agent role, like the composer', async () => {
    await post({ message_id: 'msg-src', conversation_ids: ['conv-a'] });
    expect(requireRole).toHaveBeenCalledWith('agent');
  });

  it('sends a flagged copy to every target and reports each', async () => {
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a', 'conv-b'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { conversation_id: 'conv-a', ok: true, message_id: 'new-conv-a' },
        { conversation_id: 'conv-b', ok: true, message_id: 'new-conv-b' },
      ],
    });
    expect(sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({
        conversationId: 'conv-a',
        messageType: 'text',
        contentText: 'hello there',
        senderUserId: 'user-1',
        forwarded: true,
      })
    );
  });

  it('rejects more than five targets before sending anything', async () => {
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(res.status).toBe(400);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it.each(['messages', 'conversations', 'targets'] as const)(
    'answers 503, not "not found", when reading the %s fails',
    async (read) => {
      vi.spyOn(console, 'error').mockReturnValueOnce(undefined);
      failing = read;
      const res = await post({
        message_id: 'msg-src',
        conversation_ids: ['conv-a'],
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'The service is temporarily unavailable. Please try again.',
      });
      expect(sendMessageToConversation).not.toHaveBeenCalled();
    }
  );

  it('404s a source message the caller cannot see', async () => {
    sourceRow = null;
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a'],
    });
    expect(res.status).toBe(404);
  });

  it('404s a source in a conversation outside the caller’s account', async () => {
    sourceVisible = false;
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a'],
    });
    expect(res.status).toBe(404);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('refuses a message kind the send core cannot re-create', async () => {
    sourceRow = { ...TEXT_SOURCE, content_type: 'location' };
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a'],
    });
    expect(res.status).toBe(400);
  });

  it('never sends to a target the caller cannot see', async () => {
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a', 'conv-hidden'],
    });
    const { results } = await res.json();
    expect(results).toEqual([
      { conversation_id: 'conv-a', ok: true, message_id: 'new-conv-a' },
      {
        conversation_id: 'conv-hidden',
        ok: false,
        error: 'Conversation not found',
      },
    ]);
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
  });

  it('reports a failed target without abandoning the rest', async () => {
    sendMessageToConversation.mockImplementationOnce(async () => {
      throw new SendMessageError(
        'whatsapp_error',
        'WhatsApp API error: window closed',
        502
      );
    });
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a', 'conv-b'],
    });
    const { results } = await res.json();
    expect(results[0]).toMatchObject({
      ok: false,
      error: 'WhatsApp API error: window closed',
    });
    expect(results[1]).toMatchObject({ ok: true });
  });

  it('marks a copy that may have gone, and one that certainly did not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    visibleTargets = ['conv-a', 'conv-b', 'conv-c', 'conv-d'];
    sendMessageToConversation
      .mockRejectedValueOnce(
        new SendMessageError('whatsapp_error', 'timed out', 502)
      )
      .mockRejectedValueOnce(
        new SendMessageError('whatsapp_error', 'refused', 502, true)
      )
      // Not one of ours: the batch goes on, and nobody knows about this one.
      .mockRejectedValueOnce(new TypeError('boom'));
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a', 'conv-b', 'conv-c', 'conv-d'],
    });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(
      results.map((r: { ok: boolean; maybeSent?: boolean }) => [
        r.ok,
        r.maybeSent ?? false,
      ])
    ).toEqual([
      [false, true],
      [false, false],
      [false, true],
      [true, false],
    ]);
    expect(results[2].error).toBe('The message could not be sent');
  });

  it('starts no further chat once WhatsApp has been slow', async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    sendMessageToConversation.mockImplementation(async () => {
      clock += 26_000;
      return { messageId: 'm' };
    });
    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a', 'conv-b'],
    });
    now.mockRestore();
    const { results } = await res.json();
    expect(results[0].ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[1].maybeSent).toBeUndefined();
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
  });

  it('re-hosts an attachment once through the channel it arrived on', async () => {
    sourceRow = {
      ...TEXT_SOURCE,
      content_type: 'image',
      content_text: 'caption',
      media_url: '/api/whatsapp/media/42',
      media_type: 'image/jpeg',
      provider: 'meta',
      sender_type: 'customer',
    };
    const whapi = { provider: 'whapi', isPrimary: true };
    const meta = { provider: 'meta', isPrimary: false };
    loadChannels.mockResolvedValue([whapi, meta]);
    resolveForwardMediaUrl.mockResolvedValue({
      ok: true,
      url: 'https://public/fwd.jpg',
    });

    await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a', 'conv-b'],
    });

    expect(resolveForwardMediaUrl).toHaveBeenCalledTimes(1);
    expect(resolveForwardMediaUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: meta,
        mediaUrl: '/api/whatsapp/media/42',
        fromCustomer: true,
      })
    );
    expect(sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({
        messageType: 'image',
        mediaUrl: 'https://public/fwd.jpg',
      })
    );
  });

  it('fails the whole forward when the attachment cannot be retrieved', async () => {
    sourceRow = {
      ...TEXT_SOURCE,
      content_type: 'image',
      media_url: '/api/whatsapp/media/42',
    };
    loadChannels.mockResolvedValue([{ provider: 'whapi', isPrimary: true }]);
    resolveForwardMediaUrl.mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    });

    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a'],
    });
    expect(res.status).toBe(502);
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('answers "cannot be forwarded" for a place attachments do not live in', async () => {
    sourceRow = {
      ...TEXT_SOURCE,
      content_type: 'image',
      media_url: 'https://attacker.example/a.jpg',
    };
    loadChannels.mockResolvedValue([{ provider: 'whapi', isPrimary: true }]);
    resolveForwardMediaUrl.mockResolvedValue({ ok: false, reason: 'refused' });

    const res = await post({
      message_id: 'msg-src',
      conversation_ids: ['conv-a'],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'This kind of message cannot be forwarded',
    });
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });
});
