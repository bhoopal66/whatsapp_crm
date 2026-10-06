import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedStatus } from '@/lib/whatsapp/inbound';
import { META_FAILURE_REASONS } from '@/lib/whatsapp/meta-failure';

// ============================================================
// handleStatusUpdate: the status ladder in SQL, failure reasons, the
// late-failure campaign settle, and the hand-off when a bot reply
// fails. A recording Supabase fake stands in for PostgREST: every
// query is captured with its filters, and `h.respond` decides what the
// database "returns" for it.
// ============================================================

interface Call {
  table: string;
  op: 'select' | 'update';
  payload?: Record<string, unknown>;
  filters: [string, string, unknown][];
  returning?: string;
}

type Result = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (() => ({ data: null, error: null })) as (call: Call) => Result,
  webhook: vi.fn(),
  settle: vi.fn(),
  context: vi.fn(),
}));

function fakeDb() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      const run = () => {
        h.calls.push(call);
        return Promise.resolve(h.respond(call));
      };
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          if (call.op === 'update') call.returning = cols;
          return b;
        },
        update: (payload: Record<string, unknown>) => {
          call.op = 'update';
          call.payload = payload;
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters.push(['eq', col, val]);
          return b;
        },
        in: (col: string, val: unknown) => {
          call.filters.push(['in', col, val]);
          return b;
        },
        is: (col: string, val: unknown) => {
          call.filters.push(['is', col, val]);
          return b;
        },
        limit: () => b,
        maybeSingle: () => run(),
        then: (
          resolve: (r: Result) => unknown,
          reject?: (e: unknown) => unknown
        ) => run().then(resolve, reject),
      };
      return b;
    },
  };
}

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fakeDb() }));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...args: unknown[]) => h.webhook(...args),
}));
vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  settleBroadcastAfterLateFailure: (...args: unknown[]) => h.settle(...args),
}));
vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: (...args: unknown[]) => h.context(...args),
}));
// The inbound half of the pipeline is not under test here.
vi.mock('@/lib/whatsapp/provider', () => ({ getMediaUrl: vi.fn() }));
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({
  mirrorInboundMedia: vi.fn(),
}));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(),
  isUniqueViolation: vi.fn(),
}));
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: vi.fn(),
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@/lib/ai/typesafe-watch', () => ({ watchInboundMessage: vi.fn() }));

import { handleStatusUpdate } from './inbound-pipeline';

const ACCOUNT = 'acct-1';

function status(over: Partial<NormalizedStatus> = {}): NormalizedStatus {
  return {
    messageId: 'wamid.1',
    status: 'delivered',
    recipientPhone: '971500000001',
    timestamp: '1758100000',
    ...over,
  };
}

interface World {
  messages?: Array<Record<string, unknown>>;
  /** Ids the messages UPDATE reports as changed; default: all found. */
  movedIds?: string[];
  recipient?: Record<string, unknown> | null;
  /** Whether the recipient UPDATE matched. */
  recipientFlipped?: boolean;
  /**
   * The status the recipient row holds when the UPDATE runs, which a
   * concurrent receipt may have moved since the SELECT. When set, the
   * UPDATE matches only if its status filter admits it.
   */
  recipientNow?: string;
  conversation?: Record<string, unknown> | null;
  conversationError?: unknown;
  aiConfig?: Record<string, unknown> | null;
}

function world(w: World) {
  const messages = w.messages ?? [];
  h.respond = (call) => {
    if (call.table === 'messages' && call.op === 'select') {
      return { data: messages, error: null };
    }
    if (call.table === 'messages' && call.op === 'update') {
      const ids = w.movedIds ?? messages.map((m) => m.id as string);
      return { data: ids.map((id) => ({ id })), error: null };
    }
    if (call.table === 'broadcast_recipients' && call.op === 'select') {
      return { data: w.recipient ?? null, error: null };
    }
    if (call.table === 'broadcast_recipients' && call.op === 'update') {
      let matched = w.recipientFlipped !== false;
      if (w.recipientNow !== undefined) {
        matched = call.filters.every(
          ([kind, col, val]) =>
            col !== 'status' ||
            (kind === 'eq' && val === w.recipientNow) ||
            (kind === 'in' && (val as unknown[]).includes(w.recipientNow))
        );
      }
      return { data: matched ? [{ id: 'r-1' }] : [], error: null };
    }
    if (call.table === 'conversations' && call.op === 'select') {
      if (w.conversationError) throw w.conversationError;
      return { data: w.conversation ?? null, error: null };
    }
    if (call.table === 'ai_configs') {
      return { data: w.aiConfig ?? null, error: null };
    }
    return { data: null, error: null };
  };
}

const OUTBOUND = {
  id: 'm-1',
  conversation_id: 'conv-1',
  ai_generated: false,
  conversations: { account_id: ACCOUNT },
};
const BOT_REPLY = { ...OUTBOUND, ai_generated: true };

const find = (table: string, op: Call['op']) =>
  h.calls.filter((c) => c.table === table && c.op === op);
const filter = (call: Call | undefined, kind: string, col: string) =>
  call?.filters.find(([k, c]) => k === kind && c === col)?.[2];

beforeEach(() => {
  h.calls = [];
  h.webhook.mockReset().mockResolvedValue(undefined);
  h.settle.mockReset().mockResolvedValue(undefined);
  h.context
    .mockReset()
    .mockResolvedValue([{ role: 'user', content: 'Where is my order?' }]);
  world({});
});

describe('handleStatusUpdate — messages.status is forward-only in SQL', () => {
  it.each([
    ['sent', ['sending']],
    ['delivered', ['sending', 'sent']],
    ['read', ['sending', 'sent', 'delivered']],
    ['failed', ['sending', 'sent']],
  ] as const)('%s may only overwrite %j', async (value, predecessors) => {
    world({ messages: [OUTBOUND] });
    await handleStatusUpdate(status({ status: value }), ACCOUNT);

    const [update] = find('messages', 'update');
    expect(update.payload).toEqual({ status: value });
    expect(filter(update, 'in', 'id')).toEqual(['m-1']);
    expect(filter(update, 'in', 'status')).toEqual(predecessors);
  });

  it("skips 'pending', which the messages CHECK does not allow", async () => {
    world({ messages: [OUTBOUND] });
    await handleStatusUpdate(status({ status: 'pending' }), ACCOUNT);
    expect(find('messages', 'update')).toHaveLength(0);
    expect(h.webhook).not.toHaveBeenCalled();
  });

  it('stays inside the authenticated account', async () => {
    world({ messages: [OUTBOUND] });
    await handleStatusUpdate(status(), ACCOUNT);
    const [lookup] = find('messages', 'select');
    expect(filter(lookup, 'eq', 'conversations.account_id')).toBe(ACCOUNT);
  });

  it('tells webhook subscribers when the receipt moved the message', async () => {
    world({ messages: [OUTBOUND] });
    await handleStatusUpdate(status({ status: 'read' }), ACCOUNT);
    expect(h.webhook).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT,
      'message.status_updated',
      {
        whatsapp_message_id: 'wamid.1',
        conversation_id: 'conv-1',
        status: 'read',
      }
    );
  });

  it('stays silent for a late sent that lands after read', async () => {
    // The WHERE matched nothing: the message is already further along.
    world({ messages: [OUTBOUND], movedIds: [] });
    await handleStatusUpdate(status({ status: 'sent' }), ACCOUNT);
    expect(h.webhook).not.toHaveBeenCalled();
  });
});

describe('handleStatusUpdate — broadcast recipients', () => {
  const RECIPIENT = {
    id: 'r-1',
    status: 'sent',
    broadcast_id: 'bc-1',
    broadcasts: { account_id: ACCOUNT },
  };

  it.each([
    ['sent', ['pending']],
    ['delivered', ['pending', 'sent']],
    ['read', ['pending', 'sent', 'delivered']],
    ['failed', ['pending', 'sent']],
  ] as const)('%s may only overwrite %j', async (value, predecessors) => {
    world({ recipient: { ...RECIPIENT, status: 'pending' } });
    await handleStatusUpdate(status({ status: value }), ACCOUNT);
    const [update] = find('broadcast_recipients', 'update');
    expect(filter(update, 'eq', 'id')).toBe('r-1');
    expect(filter(update, 'in', 'status')).toEqual(predecessors);
    // No compare-and-set on the status that was read.
    expect(filter(update, 'eq', 'status')).toBeUndefined();
  });

  it('stamps the receipt time with the status', async () => {
    world({ recipient: RECIPIENT });
    await handleStatusUpdate(status({ status: 'delivered' }), ACCOUNT);
    const [update] = find('broadcast_recipients', 'update');
    expect(update.payload).toMatchObject({
      status: 'delivered',
      delivered_at: '2025-09-17T09:06:40.000Z',
    });
    // Delivered is not a failure: the campaign status is not revisited.
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('lands a read when a concurrent delivered committed first', async () => {
    // Both receipts read 'sent'; 'delivered' won the row in between.
    // The old compare-and-set (status = 'sent') matched nothing here.
    world({ recipient: RECIPIENT, recipientNow: 'delivered' });
    await handleStatusUpdate(status({ status: 'read' }), ACCOUNT);
    const [update] = find('broadcast_recipients', 'update');
    expect(update.payload).toMatchObject({ status: 'read' });
    expect(filter(update, 'in', 'status')).toContain('delivered');
  });

  it('lands a failure when the row moved from pending to sent meanwhile', async () => {
    // The observable half of the same race: only a failure that
    // actually moved the row re-settles the campaign.
    world({
      recipient: { ...RECIPIENT, status: 'pending' },
      recipientNow: 'sent',
    });
    await handleStatusUpdate(
      status({ status: 'failed', error: { code: 131026 } }),
      ACCOUNT
    );
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'bc-1');
  });

  it('lets a late receipt match nothing once a higher one landed', async () => {
    // Read 'sent', but 'read' committed first: a failure no longer fits.
    world({ recipient: RECIPIENT, recipientNow: 'read' });
    await handleStatusUpdate(
      status({ status: 'failed', error: { code: 131026 } }),
      ACCOUNT
    );
    expect(find('broadcast_recipients', 'update')).toHaveLength(1);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("writes nothing for a 'pending' receipt", async () => {
    world({ recipient: { ...RECIPIENT, status: 'pending' } });
    await handleStatusUpdate(status({ status: 'pending' }), ACCOUNT);
    expect(find('broadcast_recipients', 'update')).toHaveLength(0);
  });

  it('refuses a transition off the ladder without writing', async () => {
    world({ recipient: { ...RECIPIENT, status: 'read' } });
    await handleStatusUpdate(status({ status: 'failed' }), ACCOUNT);
    expect(find('broadcast_recipients', 'update')).toHaveLength(0);
  });

  it("stores Meta's reason with a failure and re-settles the campaign", async () => {
    world({ recipient: RECIPIENT });
    await handleStatusUpdate(
      status({
        status: 'failed',
        error: { code: 131049, title: 'ecosystem engagement' },
      }),
      ACCOUNT
    );
    const [update] = find('broadcast_recipients', 'update');
    expect(update.payload).toEqual({
      status: 'failed',
      error_message: META_FAILURE_REASONS['131049'],
    });
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'bc-1');
  });

  it('writes no reason when the gateway gave none', async () => {
    world({ recipient: RECIPIENT });
    await handleStatusUpdate(status({ status: 'failed' }), ACCOUNT);
    const [update] = find('broadcast_recipients', 'update');
    expect(update.payload).toEqual({ status: 'failed' });
  });

  it('does not re-settle when a concurrent receipt won the row', async () => {
    world({ recipient: RECIPIENT, recipientFlipped: false });
    await handleStatusUpdate(
      status({ status: 'failed', error: { code: 131026 } }),
      ACCOUNT
    );
    expect(h.settle).not.toHaveBeenCalled();
  });
});

describe('handleStatusUpdate — a bot reply WhatsApp refused', () => {
  const OPEN_THREAD = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 2,
  };

  it("hands the thread to the configured agent with reason 'error'", async () => {
    world({
      messages: [BOT_REPLY],
      conversation: OPEN_THREAD,
      aiConfig: { handoff_agent_id: 'agent-9' },
    });
    await handleStatusUpdate(
      status({
        status: 'failed',
        error: { code: 131031, title: 'Business Account locked' },
      }),
      ACCOUNT
    );

    const [lookup] = find('conversations', 'select');
    expect(filter(lookup, 'eq', 'account_id')).toBe(ACCOUNT);

    const [update] = find('conversations', 'update');
    expect(update.payload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'error',
      assigned_agent_id: 'agent-9',
    });
    const summary = String(update.payload?.ai_handoff_summary);
    expect(summary).toContain('after 2 replies');
    expect(summary).toContain(
      "Reason: WhatsApp did not deliver the bot's last reply"
    );
    expect(summary).toContain(META_FAILURE_REASONS['131031']);
    expect(summary).not.toContain('AI provider error');
    expect(summary).toContain('Where is my order?');
    // Once per thread, and never over an assignment made meanwhile.
    expect(filter(update, 'eq', 'id')).toBe('conv-1');
    expect(filter(update, 'eq', 'ai_autoreply_disabled')).toBe(false);
    expect(filter(update, 'is', 'assigned_agent_id')).toBeNull();
  });

  it('leaves the thread in the shared queue when no hand-off agent is set', async () => {
    world({ messages: [BOT_REPLY], conversation: OPEN_THREAD, aiConfig: null });
    await handleStatusUpdate(status({ status: 'failed' }), ACCOUNT);
    const [update] = find('conversations', 'update');
    expect(update.payload).not.toHaveProperty('assigned_agent_id');
    expect(update.filters.some(([k]) => k === 'is')).toBe(false);
    expect(String(update.payload?.ai_handoff_summary)).toContain(
      'WhatsApp reported it as failed.'
    );
  });

  it('keeps an existing assignee', async () => {
    world({
      messages: [BOT_REPLY],
      conversation: { ...OPEN_THREAD, assigned_agent_id: 'agent-1' },
      aiConfig: { handoff_agent_id: 'agent-9' },
    });
    await handleStatusUpdate(status({ status: 'failed' }), ACCOUNT);
    const [update] = find('conversations', 'update');
    expect(update.payload).not.toHaveProperty('assigned_agent_id');
  });

  it('leaves a thread that was already handed off alone', async () => {
    world({
      messages: [BOT_REPLY],
      conversation: { ...OPEN_THREAD, ai_autoreply_disabled: true },
    });
    await handleStatusUpdate(status({ status: 'failed' }), ACCOUNT);
    expect(find('conversations', 'update')).toHaveLength(0);
  });

  it('ignores failures of messages the bot did not write', async () => {
    world({ messages: [OUTBOUND], conversation: OPEN_THREAD });
    await handleStatusUpdate(status({ status: 'failed' }), ACCOUNT);
    expect(find('conversations', 'select')).toHaveLength(0);
  });

  it('does not hand off again on a replayed receipt', async () => {
    world({ messages: [BOT_REPLY], movedIds: [], conversation: OPEN_THREAD });
    await handleStatusUpdate(status({ status: 'failed' }), ACCOUNT);
    expect(find('conversations', 'select')).toHaveLength(0);
  });

  it('never throws, and the webhook still goes out', async () => {
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    world({
      messages: [BOT_REPLY],
      conversationError: new Error('connection reset'),
    });
    await expect(
      handleStatusUpdate(status({ status: 'failed' }), ACCOUNT)
    ).resolves.toBeUndefined();
    expect(h.webhook).toHaveBeenCalledTimes(1);
    errored.mockRestore();
  });
});
