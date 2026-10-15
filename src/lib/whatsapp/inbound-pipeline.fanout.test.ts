import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound';

// ============================================================
// processMessage's `fanOut: false` (module 017a): a sender over the
// webhook rate limit keeps the message in the inbox, and nothing
// answers it. A recording Supabase fake stands in for PostgREST.
// ============================================================

interface Call {
  table: string;
  op: 'select' | 'update' | 'upsert' | 'insert';
  payload?: unknown;
}

type Result = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rpcs: [] as string[],
  rpcArgs: [] as unknown[],
  upsertRows: [] as { id: string }[],
  flows: vi.fn(),
  journey: vi.fn(),
  automations: vi.fn(),
  ai: vi.fn(),
  webhook: vi.fn(),
  watch: vi.fn(),
  reopen: vi.fn(),
}));

function respond(call: Call): Result {
  if (call.table === 'conversations' && call.op === 'select') {
    return {
      data: [{ id: 'conv-1', channel_id: 'ch-1', send_channel_id: null }],
      error: null,
    };
  }
  if (call.table === 'messages' && call.op === 'upsert') {
    return { data: h.upsertRows, error: null };
  }
  if (call.table === 'messages' && call.op === 'select') {
    return { data: [{ id: 'earlier' }], error: null };
  }
  return { data: null, error: null };
}

function fakeDb() {
  return {
    rpc(fn: string, args?: unknown) {
      h.rpcs.push(fn);
      h.rpcArgs.push(args);
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const call: Call = { table, op: 'select' };
      const run = () => {
        h.calls.push(call);
        return Promise.resolve(respond(call));
      };
      const b: Record<string, unknown> = {};
      for (const op of ['update', 'upsert', 'insert'] as const) {
        b[op] = (payload: unknown) => {
          call.op = op;
          call.payload = payload;
          return b;
        };
      }
      for (const name of [
        'select',
        'eq',
        'in',
        'is',
        'gte',
        'order',
        'limit',
      ]) {
        b[name] = () => b;
      }
      b.maybeSingle = () => run();
      b.single = () => run();
      b.then = (
        resolve: (r: Result) => unknown,
        reject?: (e: unknown) => unknown
      ) => run().then(resolve, reject);
      return b;
    },
  };
}

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fakeDb() }));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: async () => ({ id: 'contact-1', name: 'Asha' }),
  isUniqueViolation: () => false,
}));
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: (...args: unknown[]) => h.reopen(...args),
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: (...args: unknown[]) => h.flows(...args),
}));
vi.mock('@/lib/journeys/host/inbound', () => ({
  dispatchInboundToJourney: (...args: unknown[]) => h.journey(...args),
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: (...args: unknown[]) => h.automations(...args),
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: (...args: unknown[]) => h.ai(...args),
}));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...args: unknown[]) => h.webhook(...args),
}));
vi.mock('@/lib/ai/typesafe-watch', () => ({
  watchInboundMessage: (...args: unknown[]) => h.watch(...args),
}));
vi.mock('@/lib/whatsapp/provider', () => ({ getMediaUrl: vi.fn() }));
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({
  mirrorInboundMedia: vi.fn(),
}));
vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  settleBroadcastAfterLateFailure: vi.fn(),
}));

import { processMessage } from './inbound-pipeline';

const channel: WhatsAppChannel = {
  id: 'ch-1',
  accountId: 'acct-1',
  provider: 'meta',
  label: null,
  phoneNumberId: 'pn-1',
  wabaId: 'waba-1',
  accessToken: 'token',
  appSecret: null,
  isPrimary: true,
  mirrorInboundMedia: false,
  status: 'connected',
};

const message: NormalizedInboundMessage = {
  id: 'wamid.over-limit',
  from: '971500000001',
  chatId: '971500000001',
  fromName: 'Asha',
  timestamp: '1760000000',
  type: 'text',
  text: 'hello',
  media: null,
  location: null,
  reaction: null,
  contacts: null,
  interactiveReplyId: null,
  interactiveReplyTitle: null,
  contextMessageId: null,
  forwarded: false,
  fromMe: false,
  isGroup: false,
  freeEntry: false,
};

beforeEach(() => {
  h.calls = [];
  h.rpcs = [];
  h.rpcArgs = [];
  h.upsertRows = [{ id: 'row-1' }];
  h.flows.mockReset().mockResolvedValue({ consumed: false });
  h.journey.mockReset().mockResolvedValue({ consumed: false });
  h.automations.mockReset().mockResolvedValue(undefined);
  h.ai.mockReset().mockResolvedValue(undefined);
  h.webhook.mockReset().mockResolvedValue(undefined);
  h.watch.mockReset().mockResolvedValue(undefined);
  h.reopen.mockReset().mockResolvedValue(undefined);
});

describe('processMessage — fanOut', () => {
  it('fanOut: false persists the message and stops before the fan-out', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });

    const upsert = h.calls.find(
      (c) => c.table === 'messages' && c.op === 'upsert'
    );
    expect(upsert?.payload).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'customer',
      message_id: 'wamid.over-limit',
      content_text: 'hello',
      channel_id: 'ch-1',
    });
    // The push is part of the inbox, so an over-limit sender still rings.
    expect(h.rpcs).toEqual([
      'bump_conversation_on_inbound',
      'push_whatsapp_inbound',
    ]);
    expect(h.rpcArgs[1]).toEqual({ p_message_id: 'row-1' });
    expect(h.reopen).toHaveBeenCalledTimes(1);

    expect(h.flows).not.toHaveBeenCalled();
    expect(h.journey).not.toHaveBeenCalled();
    expect(h.automations).not.toHaveBeenCalled();
    expect(h.ai).not.toHaveBeenCalled();
    expect(h.webhook).not.toHaveBeenCalled();
    expect(h.watch).not.toHaveBeenCalled();
  });

  it('by default the same message fans out', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);

    expect(h.rpcs).toEqual([
      'bump_conversation_on_inbound',
      'push_whatsapp_inbound',
    ]);
    expect(h.flows).toHaveBeenCalledTimes(1);
    expect(h.automations).toHaveBeenCalled();
    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(h.webhook).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.received',
      expect.anything()
    );
    expect(h.watch).toHaveBeenCalledTimes(1);
  });
});

// A replayed delivery (the upsert returns no row) is the idempotency
// boundary: push_whatsapp_inbound de-dupes nothing, so reaching it on a
// replay would ring everyone twice.
describe('processMessage — replay', () => {
  it('a replayed message queues no push and bumps nothing', async () => {
    h.upsertRows = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await processMessage(message, 'acct-1', 'owner-1', channel);
    info.mockRestore();

    expect(h.rpcs).not.toContain('push_whatsapp_inbound');
    expect(h.rpcs).toEqual([]);
    expect(h.flows).not.toHaveBeenCalled();
  });
});

// The journey bot (module 016) runs after Flows, only when no Flow took
// the message; when it consumes, content automations and the AI reply
// stand down as they do for a Flow.
describe('processMessage — journey bot', () => {
  const triggers = () =>
    h.automations.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    );

  it('hands an unconsumed message to the journey with the contact and thread', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);

    expect(h.journey).toHaveBeenCalledTimes(1);
    expect(h.journey.mock.calls[0][0]).toMatchObject({
      accountId: 'acct-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      message: { id: 'wamid.over-limit' },
    });
    expect(triggers()).toEqual(['new_message_received', 'keyword_match']);
    expect(h.ai).toHaveBeenCalledTimes(1);
  });

  it('a journey that consumes suppresses content automations and the AI reply', async () => {
    h.journey.mockResolvedValue({ consumed: true });
    await processMessage(message, 'acct-1', 'owner-1', channel);

    expect(triggers()).toEqual([]);
    expect(h.ai).not.toHaveBeenCalled();
    expect(h.webhook).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.received',
      expect.anything()
    );
    expect(h.watch).toHaveBeenCalledTimes(1);
  });

  it('a message a Flow consumed never reaches the journey', async () => {
    h.flows.mockResolvedValue({ consumed: true });
    h.journey.mockResolvedValue({ consumed: true });
    await processMessage(message, 'acct-1', 'owner-1', channel);

    expect(h.journey).not.toHaveBeenCalled();
    expect(triggers()).toEqual([]);
    expect(h.ai).not.toHaveBeenCalled();
  });

  it('a failing journey hook leaves the rest of the fan-out running', async () => {
    h.journey.mockRejectedValue(new Error('boom'));
    await processMessage(message, 'acct-1', 'owner-1', channel);

    expect(triggers()).toEqual(['new_message_received', 'keyword_match']);
    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(h.webhook).toHaveBeenCalled();
  });
});
