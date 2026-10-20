import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  gatewayErrorFields,
  isAcceptableMediaUrl,
  sendMessageToConversation,
  SendMessageError,
  validateSendMessageParams,
  type SendMessageParams,
} from './send-message';
import { WhapiError } from './whapi-api';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('whatsapp_error', 'boom', 502);
    expect(e.code).toBe('whatsapp_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });

  it('is definite by default only for a 4xx, which comes before the gateway', () => {
    expect(new SendMessageError('bad_request', 'nope', 400).definite).toBe(
      true
    );
    expect(new SendMessageError('not_found', 'nope', 404).definite).toBe(true);
    expect(new SendMessageError('boom', 'boom', 500).definite).toBe(false);
    expect(new SendMessageError('whatsapp_error', 'boom', 502).definite).toBe(
      false
    );
    expect(
      new SendMessageError('whatsapp_error', 'refused', 502, true).definite
    ).toBe(true);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));
const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }));
const getChannelInfo = vi.fn();

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/whapi-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
  getChannelInfo: (...args: unknown[]) => getChannelInfo(...args),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

// Every service-role write, recorded: the best-effort "pause active
// flow run" write, and a coordinator's last-message summary (133).
interface AdminWrite {
  table: string;
  row: Record<string, unknown>;
  filters: [string, unknown][];
}
const adminWrites = vi.hoisted(() => [] as AdminWrite[]);
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      update: (row: Record<string, unknown>) => {
        const write: AdminWrite = { table, row, filters: [] };
        adminWrites.push(write);
        const chain = {
          eq: (column: string, value: unknown) => {
            write.filters.push([column, value]);
            return chain;
          },
          then: (resolve: (r: { error: null }) => unknown) =>
            resolve({ error: null }),
        };
        return chain;
      },
    }),
  }),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites,
  options: {
    /** Extra conversation columns (owner, numbers). */
    conversation?: Record<string, unknown>;
    /** Rows the RLS client's conversations UPDATE … select('id') returns. */
    conversationUpdateRows?: unknown[];
  } = {}
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact: { id: 'ct-1', phone: '+15551234567' },
    ...options.conversation,
  };
  // Channel rows as `channels.ts` reads them (migration 046). The
  // encryption mock above is identity, so `access_token` is plaintext.
  const channelRows = [
    {
      id: 'cfg-1',
      account_id: 'acct-1',
      provider: 'whapi',
      label: 'Support',
      phone_number_id: 'pn-1',
      waba_id: null,
      access_token: 'token',
      app_secret: null,
      is_primary: true,
      mirror_inbound_media: true,
      status: 'connected',
    },
  ];

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          // The send core writes the conversation twice: the last-message
          // summary, then (for a thread with no number yet) the number
          // stamp. Merge so a test sees everything that was written.
          if (table === 'conversations') {
            captured.conversation = { ...captured.conversation, ...row };
          }
          return builder;
        },
        is: () => builder,
        // `channels.ts` terminates its whatsapp_config read on .order();
        // every other table keeps chaining.
        order: () => {
          if (table === 'whatsapp_config') {
            return Promise.resolve({ data: channelRows, error: null });
          }
          return builder;
        },
        limit: () => builder,
        // whatsapp_routes: no explicit route, so the primary is used.
        // messages: no inbound history on this thread.
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result — only message_templates is read this way.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data:
              table === 'message_templates'
                ? templateRows
                : table === 'conversations'
                  ? (options.conversationUpdateRows ?? [])
                  : [],
            error: null,
          }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateMessageParams: { body: ['B456', 'Monday'] },
      }
    );
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
        contentText: 'rendered by the composer',
      }
    );
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it('hands the resolved local row to the sender, with its body params', async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    // Under Meta this asserted the LANGUAGE CODE on the wire, because
    // the template lived on Meta's side and the code selected which
    // approved translation to render. Whapi has no template registry:
    // the row itself is the message, so what matters is that the
    // resolver's chosen row — and the values to substitute into it —
    // reach the sender.
    const args = (
      sendTemplateMessage.mock.calls[0] as unknown as [
        { template: { language: string }; bodyParams: string[] },
      ]
    )[0];
    expect(args.template.language).toBe('en');
    expect(args.bodyParams).toEqual(['A123', 'Friday']);
  });

  it('refuses the send when the account has no local template row', async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};

    // Meta could still deliver a template we had no local copy of — the
    // row was only needed to render the text we persisted. Whapi cannot:
    // with nothing to render there is no message, so this is now a hard
    // failure instead of a send with a null content_text.
    await expect(
      sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'never_saved',
        templateParams: ['A123'],
      })
    ).rejects.toMatchObject({ code: 'template_not_found' });

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });
});

describe('sendMessageToConversation — provider pin', () => {
  // The fixture account has only a Whapi channel connected.
  it('falls back to the connected number when the pin is a preference', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
      provider: 'meta',
    });
    expect(captured.message?.provider).toBe('whapi');
  });

  it('refuses rather than falls back when the pin is required', async () => {
    // Compass status notifications: never silently move to another number.
    const captured: CapturedWrites = {};
    await expect(
      sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hi',
        provider: 'meta',
        requireProvider: true,
      })
    ).rejects.toMatchObject({ code: 'meta_not_connected', status: 409 });
    expect(captured.message).toBeUndefined();
  });

  it('never writes conversation ownership', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'status update',
      provider: 'whapi',
      requireProvider: true,
      pauseActiveFlows: false,
    });
    expect(captured.conversation).toBeDefined();
    expect(captured.conversation).not.toHaveProperty('assigned_agent_id');
    expect(captured.conversation).not.toHaveProperty('user_id');
    expect(captured.message?.sender_id).toBeNull();
  });
});

describe('sendMessageToConversation — gateway refusal wording', () => {
  // A Whapi 401/403 on a send is ambiguous: a phone logged out of
  // WhatsApp answers it with a perfectly valid token. The send path
  // probes the number and says which it is (production, 29 Sep: every
  // agent was told the token was revoked while the phone showed a QR).
  async function failWith(probe: () => Promise<unknown>) {
    sendTextMessage.mockImplementationOnce(async () => {
      throw new WhapiError('Unauthorized', 401, 401, 'channel not authorized');
    });
    getChannelInfo.mockReset();
    getChannelInfo.mockImplementationOnce(probe);
    const captured: CapturedWrites = {};
    const error = await sendMessageToConversation(
      sendPathDb([], captured),
      'acct-1',
      { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(captured.message).toBeUndefined();
    return error as SendMessageError;
  }

  it('says the phone is logged out when the probe reports a QR', async () => {
    const error = await failWith(async () => ({
      status: 'QR',
      authorized: false,
      phone: null,
    }));
    // The contract callers map is unchanged: whatsapp_error / 502.
    expect(error).toBeInstanceOf(SendMessageError);
    expect(error.code).toBe('whatsapp_error');
    expect(error.status).toBe(502);
    // A refused 401 never went out, so the inbox may offer Retry.
    expect(error.definite).toBe(true);
    expect(error.message).toMatch(/logged out of WhatsApp/);
    expect(error.message).toMatch(/Do not re-save the token/);
    expect(getChannelInfo).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token', wakeup: false })
    );
  });

  it('says the token was revoked only when the probe is refused too', async () => {
    const error = await failWith(async () => {
      throw new WhapiError('Invalid token', 401);
    });
    expect(error.code).toBe('whatsapp_error');
    expect(error.message).toMatch(/no longer accepts the token/);
  });

  it('keeps the neutral wording when the probe itself fails', async () => {
    const error = await failWith(async () => {
      throw new WhapiError('Whapi request failed: timeout', 503);
    });
    expect(error.status).toBe(502);
    expect(error.message).toContain('HTTP 401: Unauthorized');
    expect(error.message).not.toMatch(/invalid or revoked/);
  });

  it("logs the gateway's raw status, code, message and details", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await failWith(async () => {
        throw new WhapiError('Whapi request failed: timeout', 503);
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('[send-message] send failed'),
        expect.any(String),
        {
          status: 401,
          code: 401,
          message: 'Unauthorized',
          details: 'channel not authorized',
        }
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('sendMessageToConversation — whether a failure is definite', () => {
  // The inbox offers Retry only for a definite failure. A retry after
  // one that may have gone out reaches the customer twice.
  async function failWith(thrown: unknown) {
    sendTextMessage.mockImplementationOnce(async () => {
      throw thrown;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const captured: CapturedWrites = {};
      const error = await sendMessageToConversation(
        sendPathDb([], captured),
        'acct-1',
        { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }
      ).then(
        () => null,
        (e: unknown) => e
      );
      expect(captured.message).toBeUndefined();
      expect(error).toBeInstanceOf(SendMessageError);
      return error as SendMessageError;
    } finally {
      log.mockRestore();
    }
  }

  it('is definite when the gateway refused with a 4xx', async () => {
    const error = await failWith(new WhapiError('bad recipient', 400));
    expect(error).toMatchObject({
      code: 'whatsapp_error',
      status: 502,
      definite: true,
    });
  });

  it.each([
    ['a timeout', new WhapiError('Whapi request failed: timeout', 503)],
    [
      'an accepted send with no id back',
      new WhapiError(
        'Whapi accepted the text message but returned no message id.',
        502
      ),
    ],
    ['a gateway 5xx', new WhapiError('Internal error', 500)],
    ['a 2xx body that is not JSON', new SyntaxError('Unexpected token <')],
  ])('is not definite after %s: it may have gone out', async (_, thrown) => {
    const error = await failWith(thrown);
    expect(error).toMatchObject({
      code: 'whatsapp_error',
      status: 502,
      definite: false,
    });
  });

  it('is definite for a malformed template row, found before the gateway call', async () => {
    sendTemplateMessage.mockClear();
    const error = await sendMessageToConversation(
      sendPathDb([{ id: 'tpl-bad', name: 'order_update', language: 'en' }], {}),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
      }
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toMatchObject({
      code: 'template_malformed',
      status: 500,
      definite: true,
    });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('is not definite when the sent message could not be saved', async () => {
    const captured: CapturedWrites = {};
    const inner = sendPathDb([], captured);
    const db = {
      from(table: string) {
        const builder = inner.from(table) as unknown as Record<string, unknown>;
        if (table === 'messages') {
          builder.single = async () => ({
            data: null,
            error: { message: 'insert denied' },
          });
        }
        return builder;
      },
    } as unknown as SupabaseClient;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const error = await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'hi',
      }).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toMatchObject({
        code: 'db_error',
        status: 500,
        definite: false,
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe('sendMessageToConversation — new-chat limit (migration 068)', () => {
  function withCheck(result: unknown) {
    const captured: CapturedWrites = {};
    const inner = sendPathDb([], captured);
    const rpc = vi.fn(async () => result);
    const db = {
      from: (table: string) => inner.from(table),
      rpc,
    } as unknown as SupabaseClient;
    return { db, rpc, captured };
  }

  it("refuses a person's new chat when the check says so, before the gateway", async () => {
    sendTextMessage.mockClear();
    const { db, rpc } = withCheck({
      data: { blocked: true, reason: 'user', started: 20, limit: 20 },
      error: null,
    });
    const error = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hello',
      senderUserId: 'u-1',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toMatchObject({
      code: 'new_chat_limit',
      status: 429,
      definite: true,
    });
    expect((error as Error).message).toMatch(/started 20 new chats today/);
    expect(rpc).toHaveBeenCalledWith('team_activity_start_check', {
      p_conversation_id: 'cv-1',
      p_channel_id: 'cfg-1',
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('sends when the check allows it', async () => {
    sendTextMessage.mockClear();
    const { db, captured } = withCheck({
      data: { blocked: false },
      error: null,
    });
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hello',
      senderUserId: 'u-1',
    });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(captured.message).toMatchObject({ sender_id: 'u-1' });
  });

  it('does not ask for a send no person made', async () => {
    const { db, rpc } = withCheck({ data: { blocked: true }, error: null });
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Your order shipped',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('sendMessageToConversation — a chat shared with a coordinator (migration 133)', () => {
  const COORDINATOR = 'u-coord';

  /**
   * The coordinator's view of a colleague's chat: `shared` decides what
   * coordinator_share_grants answers (and can_view_conversation the
   * opposite, as for a coordinator who sees the chat only by the share).
   * The RLS client's summary UPDATE matches `updateRows`.
   */
  function sharedChat(opts: {
    shared: boolean;
    channelId: string | null;
    updateRows?: unknown[];
  }) {
    const captured: CapturedWrites = {};
    const inner = sendPathDb([], captured, {
      conversation: {
        user_id: 'u-owner',
        assigned_agent_id: null,
        channel_id: opts.channelId,
        send_channel_id: null,
      },
      conversationUpdateRows: opts.updateRows ?? [],
    });
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'coordinator_share_grants')
        return { data: opts.shared, error: null };
      if (fn === 'can_view_conversation')
        return { data: !opts.shared, error: null };
      return { data: { blocked: false }, error: null };
    });
    const db = {
      from: (table: string) => inner.from(table),
      rpc,
    } as unknown as SupabaseClient;
    return { db, rpc, captured };
  }

  const reply = {
    conversationId: 'cv-1',
    messageType: 'text',
    contentText: 'The bank needs your salary letter',
    senderUserId: COORDINATOR,
  };

  const summaryWrites = () =>
    adminWrites.filter((w) => w.table === 'conversations');

  it("updates the shared chat's last message through the service role, confined to it", async () => {
    adminWrites.length = 0;
    sendTextMessage.mockClear();
    const { db, rpc, captured } = sharedChat({
      shared: true,
      channelId: 'cfg-1',
    });
    await sendMessageToConversation(db, 'acct-1', reply);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(captured.message).toMatchObject({
      sender_id: COORDINATOR,
      channel_id: 'cfg-1',
    });
    expect(rpc).toHaveBeenCalledWith('coordinator_share_grants', {
      p_conversation_id: 'cv-1',
    });
    expect(summaryWrites()).toEqual([
      {
        table: 'conversations',
        row: expect.objectContaining({
          last_message_text: 'The bank needs your salary letter',
        }),
        filters: [
          ['id', 'cv-1'],
          ['account_id', 'acct-1'],
        ],
      },
    ]);
  });

  it('leaves a 0-row summary update alone for anyone the share does not explain', async () => {
    adminWrites.length = 0;
    const { db } = sharedChat({ shared: false, channelId: 'cfg-1' });
    await sendMessageToConversation(db, 'acct-1', reply);
    expect(summaryWrites()).toEqual([]);
  });

  it('asks nothing when the RLS update reached the row', async () => {
    adminWrites.length = 0;
    const { db, rpc } = sharedChat({
      shared: true,
      channelId: 'cfg-1',
      updateRows: [{ id: 'cv-1' }],
    });
    await sendMessageToConversation(db, 'acct-1', reply);
    expect(summaryWrites()).toEqual([]);
    expect(rpc).not.toHaveBeenCalledWith(
      'coordinator_share_grants',
      expect.anything()
    );
  });

  it("refuses, before the gateway, a reply on a number that is not the chat's own", async () => {
    sendTextMessage.mockClear();
    // No number on the thread yet: the send would go out on the primary,
    // which the messages INSERT policy refuses for a coordinator.
    const { db, captured } = sharedChat({ shared: true, channelId: null });
    const error = await sendMessageToConversation(db, 'acct-1', reply).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toMatchObject({
      code: 'shared_chat_number',
      status: 409,
      definite: true,
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(captured.message).toBeUndefined();
  });

  it('still sends from a thread with no number for a sender who sees it normally', async () => {
    sendTextMessage.mockClear();
    const { db, captured } = sharedChat({ shared: false, channelId: null });
    await sendMessageToConversation(db, 'acct-1', reply);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(captured.message).toMatchObject({ channel_id: 'cfg-1' });
    // …and the thread is stamped with its number, as before.
    expect(captured.conversation).toMatchObject({ channel_id: 'cfg-1' });
  });
});

describe('gatewayErrorFields', () => {
  it('reads the shared fields off any error without knowing its class', () => {
    expect(gatewayErrorFields(new WhapiError('nope', 403, 7, 'why'))).toEqual({
      status: 403,
      code: 7,
      message: 'nope',
      details: 'why',
    });
    expect(gatewayErrorFields(new Error('plain'))).toEqual({
      status: null,
      code: null,
      message: 'plain',
      details: null,
    });
    expect(gatewayErrorFields('text')).toMatchObject({ message: 'text' });
    expect(gatewayErrorFields(null)).toMatchObject({ status: null });
  });
});

describe('media_url validation', () => {
  const STORAGE = 'http://localhost:8000';

  it('accepts https URLs and our own public storage over http', () => {
    expect(isAcceptableMediaUrl('https://cdn.example.com/a.jpg', STORAGE)).toBe(
      true
    );
    expect(
      isAcceptableMediaUrl(
        `${STORAGE}/storage/v1/object/public/chat-media/account-1/a.jpg`,
        STORAGE
      )
    ).toBe(true);
  });

  it('rejects other schemes, relative paths, and look-alike storage paths', () => {
    for (const url of [
      'http://attacker.example/a.jpg',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'ftp://example.com/a.jpg',
      '/api/whatsapp/media/123',
      'javascript:alert(1)',
      'not a url',
      'https://user:pass@example.com/a.jpg',
      `${STORAGE}/auth/v1/admin/users`,
      `${STORAGE}/storage/v1/object/public/../../../auth/v1/user`,
      `https://example.com/${'a'.repeat(2100)}`,
    ]) {
      expect(isAcceptableMediaUrl(url, STORAGE), url).toBe(false);
    }
    expect(
      isAcceptableMediaUrl(
        `${STORAGE}/storage/v1/object/public/chat-media/a.jpg`,
        undefined
      )
    ).toBe(false);
  });

  it('400s a send whose media_url is not https', () => {
    expect(() =>
      validateSendMessageParams({
        messageType: 'image',
        mediaUrl: 'http://attacker.example/a.jpg',
      })
    ).toThrow(/https/);
    // Even on a non-media type — the send core persists media_url always.
    expect(() =>
      validateSendMessageParams({
        messageType: 'text',
        contentText: 'hi',
        mediaUrl: 'file:///etc/passwd',
      })
    ).toThrow(SendMessageError);
    expect(() =>
      validateSendMessageParams({
        messageType: 'image',
        mediaUrl: 'https://cdn.example.com/a.jpg',
      })
    ).not.toThrow();
  });

  it('short-circuits sendMessageToConversation before any query', async () => {
    await expectSendError(
      {
        conversationId: 'cv-1',
        messageType: 'document',
        mediaUrl: 'http://127.0.0.1:54321/rest/v1/',
      },
      400,
      /https/
    );
  });
});
