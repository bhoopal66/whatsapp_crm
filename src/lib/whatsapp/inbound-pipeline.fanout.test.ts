import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  filters?: [string, string, unknown][];
}

type Result = { data: unknown; error: unknown };

/** The customer_documents row the recording of message 'row-1' made. */
const DOC_ROW_ID = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  // The workspace's "understand meaning" switch (Smart insights).
  meaningOn: true,
  /** null = the usual existing row; [] = no chat yet (creates one). */
  convRows: null as unknown[] | null,
  /** A `table:op` the database refuses. */
  refuse: null as string | null,
  assignee: null as string | null,
  engagedAt: null as string | null,
  assignFromCalls: vi.fn(),
  rpcsAtAssign: null as string[] | null,
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
  insights: vi.fn(),
  reminder: vi.fn(),
  hrAgents: vi.fn(),
  autoOpen: vi.fn(),
  autoTag: vi.fn(),
  reopen: vi.fn(),
  classify: vi.fn(),
  tagInterested: vi.fn(),
  recipientRows: [] as unknown[],
  order: [] as string[],
  // customer_documents_record (migration 178): the reply, or a throw.
  docRpc: vi.fn(),
  // Broadcast first-reply rotation (migration 236).
  loadAssignment: vi.fn(),
  rotate: vi.fn(),
  // case_csat_capture (migration 246): true when the reply was stored.
  csatRpc: vi.fn(),
  // The contact's open cases without a group.
  caseRows: null as Record<string, unknown>[] | null,
  // case_sla_event_system (migration 124).
  slaRpc: vi.fn(),
}));

function respond(call: Call): Result {
  if (h.refuse === `${call.table}:${call.op}`) {
    return { data: null, error: { code: '57014', message: 'timeout' } };
  }
  if (call.table === 'conversations' && call.op === 'select') {
    if (h.convRows) return { data: h.convRows, error: null };
    return {
      data: [
        {
          id: 'conv-1',
          channel_id: 'ch-1',
          send_channel_id: null,
          assigned_agent_id: h.assignee,
          human_engaged_at: h.engagedAt,
        },
      ],
      error: null,
    };
  }
  if (call.table === 'conversations' && call.op === 'insert') {
    return {
      data: { id: 'conv-new', ...(call.payload as object) },
      error: null,
    };
  }
  if (call.table === 'messages' && call.op === 'upsert') {
    return { data: h.upsertRows, error: null };
  }
  if (call.table === 'cases' && call.op === 'select') {
    return { data: h.caseRows, error: null };
  }
  if (call.table === 'broadcast_recipients' && call.op === 'select') {
    return { data: h.recipientRows, error: null };
  }
  if (call.table === 'messages' && call.op === 'select') {
    return { data: [{ id: 'earlier' }], error: null };
  }
  if (call.table === 'customer_documents' && call.op === 'select') {
    const byMessage = call.filters?.some(
      ([op, col, v]) => op === 'eq' && col === 'message_id' && v === 'row-1'
    );
    return { data: byMessage ? { id: DOC_ROW_ID } : null, error: null };
  }
  return { data: null, error: null };
}

function fakeDb() {
  return {
    rpc(fn: string, args?: unknown) {
      h.rpcs.push(fn);
      h.rpcArgs.push(args);
      if (fn === 'customer_documents_record') return h.docRpc(args);
      if (fn === 'case_csat_capture') return h.csatRpc(args);
      if (fn === 'case_sla_event_system') return h.slaRpc(args);
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
      for (const name of ['eq', 'is'] as const) {
        b[name] = (col: string, v: unknown) => {
          (call.filters ??= []).push([name, col, v]);
          return b;
        };
      }
      for (const name of ['select', 'in', 'gte', 'order', 'limit']) {
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
  findExistingContact: async () => ({
    id: 'contact-1',
    name: 'Asha',
    user_id: 'owner-1',
  }),
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
vi.mock('@/lib/insights/inbound', () => ({
  runInboundInsights: (...args: unknown[]) => h.insights(...args),
}));
vi.mock('@/lib/reminders/suggest', () => ({
  suggestReminderForMessage: (...args: unknown[]) => h.reminder(...args),
}));
vi.mock('@/lib/hr/agents/inbound', () => ({
  handleHrInboundMessage: (...args: unknown[]) => h.hrAgents(...args),
}));
vi.mock('@/lib/hr/auto-open', () => ({
  autoOpenRecruiterChat: (...args: unknown[]) => h.autoOpen(...args),
}));
vi.mock('@/lib/insights/auto-tag', () => ({
  autoTagFromInsights: (...args: unknown[]) => h.autoTag(...args),
}));
vi.mock('@/lib/insights/settings', () => ({
  insightsAvailable: () => h.meaningOn,
  getInsightSettings: async () => ({ meaningTriggersEnabled: h.meaningOn }),
}));
vi.mock('@/lib/broadcasts/reply-class', () => ({
  classifyCampaignReply: (...args: unknown[]) => h.classify(...args),
  tagInterestedReply: (...args: unknown[]) => h.tagInterested(...args),
}));
vi.mock('@/lib/pbx/assign-from-calls', () => ({
  assignChatFromCallHistory: (...args: unknown[]) => {
    h.rpcsAtAssign = [...h.rpcs];
    return h.assignFromCalls(...args);
  },
}));
vi.mock('@/lib/assignment/rotation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assignment/rotation')>()),
  loadAssignmentSettings: (...args: unknown[]) => h.loadAssignment(...args),
  rotateAssign: (...args: unknown[]) => h.rotate(...args),
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({
  mirrorInboundMedia: vi.fn(),
}));
vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  settleBroadcastAfterLateFailure: vi.fn(),
}));

import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media';
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
  isPersonal: false,
  personalUserId: null,
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

// The fixture message is a live one: the clock reads a minute after it
// was sent, inside the inbound push's freshness window.
const MESSAGE_SENT_MS = 1760000000 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MESSAGE_SENT_MS + 60_000);
  h.meaningOn = true;
  h.convRows = null;
  h.assignee = null;
  h.engagedAt = null;
  h.assignFromCalls.mockReset().mockResolvedValue(null);
  h.rpcsAtAssign = null;
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
  h.insights.mockReset().mockResolvedValue({ skipped: 'off' });
  h.reminder.mockReset().mockResolvedValue({ status: 'off' });
  h.hrAgents.mockReset().mockResolvedValue(undefined);
  h.autoOpen.mockReset().mockResolvedValue('off');
  h.autoTag.mockReset().mockResolvedValue('not_auto');
  h.reopen.mockReset().mockResolvedValue(undefined);
  h.recipientRows = [];
  h.order = [];
  h.classify.mockReset().mockResolvedValue(null);
  h.tagInterested.mockReset().mockResolvedValue('not_interested');
  h.docRpc.mockReset().mockResolvedValue({ data: 'TC-000123', error: null });
  h.loadAssignment.mockReset().mockResolvedValue({
    broadcastRotationEnabled: false,
    broadcastPool: [],
    compassAssignEnabled: false,
    limitsEnabled: false,
    defaultChatLimit: 30,
  });
  h.rotate
    .mockReset()
    .mockResolvedValue({ assignedTo: 'agent-2', reason: 'assigned' });
  h.csatRpc.mockReset().mockResolvedValue({ data: false, error: null });
  h.caseRows = null;
  h.slaRpc.mockReset().mockResolvedValue({ data: null, error: null });
});

// Broadcast first-reply rotation (migration 236): only the FIRST reply
// to a campaign, only while the switch is on, only a chat nobody holds,
// after the call-history pick and ahead of the follow-up flow.
describe('processMessage — broadcast first-reply rotation', () => {
  const rotationOn = (pool: string[] = []) =>
    h.loadAssignment.mockResolvedValue({
      broadcastRotationEnabled: true,
      broadcastPool: pool,
      compassAssignEnabled: false,
      limitsEnabled: false,
      defaultChatLimit: 30,
    });

  beforeEach(() => {
    h.recipientRows = [
      {
        id: 'rec-1',
        status: 'read',
        broadcast_id: 'bc-1',
        broadcasts: { account_id: 'acct-1', follow_up_flow_id: null },
      },
    ];
    h.assignFromCalls.mockImplementation(async () => {
      h.order.push('calls');
      return null;
    });
    h.rotate.mockImplementation(async () => {
      h.order.push('rotate');
      return { assignedTo: 'agent-2', reason: 'assigned' };
    });
    h.flows.mockImplementation(async () => {
      h.order.push('flows');
      return { consumed: false };
    });
  });

  it('does nothing while the switch is off', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.loadAssignment).toHaveBeenCalledTimes(1);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rotates the first reply through the broadcast pool', async () => {
    rotationOn(['agent-1', 'agent-2']);
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.rotate).toHaveBeenCalledTimes(1);
    expect(h.rotate.mock.calls[0][1]).toEqual({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      poolKey: 'broadcast',
      candidates: ['agent-1', 'agent-2'],
    });
    // The customer's last caller is asked first; the flow sees the result.
    expect(h.order).toEqual(['calls', 'rotate', 'flows']);
  });

  it('is not asked when the message answers no campaign', async () => {
    rotationOn();
    h.recipientRows = [];
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.loadAssignment).not.toHaveBeenCalled();
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('leaves a held or engaged chat alone', async () => {
    rotationOn();
    h.assignee = 'agent-9';
    await processMessage(message, 'acct-1', 'owner-1', channel);
    h.assignee = null;
    h.engagedAt = '2026-01-01T00:00:00Z';
    await processMessage(
      { ...message, id: 'wamid.second' },
      'acct-1',
      'owner-1',
      channel
    );
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('a rotation that throws never stops the fan-out', async () => {
    rotationOn();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rotate.mockRejectedValue(new Error('db down'));
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.flows).toHaveBeenCalledTimes(1);
    expect(h.automations).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('a sender over the rate limit is not rotated', async () => {
    rotationOn();
    await processMessage(message, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });
    expect(h.rotate).not.toHaveBeenCalled();
  });
});

describe('processMessage — desk reminder STOP (migration 234)', () => {
  it('asks the desk to opt the person out on a STOP reply, and only then', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.rpcs).not.toContain('desk_digest_stop');

    await processMessage(
      { ...message, id: 'wamid.stop', text: 'STOP' },
      'acct-1',
      'owner-1',
      channel
    );
    const i = h.rpcs.indexOf('desk_digest_stop');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.rpcArgs[i]).toEqual({
      p_account: 'acct-1',
      p_contact: 'contact-1',
    });
  });
});

describe('processMessage — assigning from call history', () => {
  it('looks up an unassigned chat before the unread bump and the push', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);

    expect(h.assignFromCalls).toHaveBeenCalledTimes(1);
    expect(h.assignFromCalls.mock.calls[0][1]).toEqual({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      contactOwnerId: 'owner-1',
      phone: '971500000001',
    });
    expect(h.rpcsAtAssign).toEqual([]);
    expect(h.rpcs).toEqual([
      'bump_conversation_on_inbound',
      'push_whatsapp_inbound',
    ]);
  });

  it('assigns a sender over the rate limit too', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });
    expect(h.assignFromCalls).toHaveBeenCalledTimes(1);
  });

  it('leaves a chat that already has someone', async () => {
    h.assignee = 'agent-9';
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.assignFromCalls).not.toHaveBeenCalled();
  });

  it('leaves a chat a person replied in or released, with no assignee', async () => {
    h.engagedAt = '2026-11-01T00:00:00Z';
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.assignFromCalls).not.toHaveBeenCalled();
  });

  it('does nothing on a replayed delivery', async () => {
    h.upsertRows = [];
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.assignFromCalls).not.toHaveBeenCalled();
  });

  it('leaves a chat on a personal number with its owner', async () => {
    await processMessage(message, 'acct-1', 'owner-1', {
      ...channel,
      isPersonal: true,
      personalUserId: 'owner-1',
    });
    expect(h.assignFromCalls).not.toHaveBeenCalled();
  });
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
    expect(h.insights).not.toHaveBeenCalled();
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
// HR, 2026-11-13: the CRM rang for every message on a personal number
// (the phone already does) and for every message of a backlog replayed
// when a gateway reconnects.
describe('processMessage — when the push rings', () => {
  it('a message on a personal number is stored but rings nobody', async () => {
    await processMessage(message, 'acct-1', 'owner-1', {
      ...channel,
      isPersonal: true,
      personalUserId: 'owner-1',
    });
    expect(h.rpcs).toContain('bump_conversation_on_inbound');
    expect(h.rpcs).not.toContain('push_whatsapp_inbound');
  });

  it('a message older than five minutes (a backlog replay) rings nobody', async () => {
    vi.setSystemTime(MESSAGE_SENT_MS + 6 * 60_000);
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.rpcs).toContain('bump_conversation_on_inbound');
    expect(h.rpcs).not.toContain('push_whatsapp_inbound');
  });

  it('control: a live message on a company number rings', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.rpcs).toContain('push_whatsapp_inbound');
  });
});

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

describe('processMessage — reminder suggestions', () => {
  it('suggests for a customer message, with the persisted message id', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.reminder).toHaveBeenCalledTimes(1);
    expect(h.reminder.mock.calls[0][0]).toMatchObject({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      // Our messages row, never the gateway id (the suggestion's FK).
      messageId: 'row-1',
      text: 'hello',
      side: 'customer',
      messageAt: '2025-10-09T08:53:20.000Z',
    });
  });

  it('a replayed message suggests nothing', async () => {
    h.upsertRows = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await processMessage(message, 'acct-1', 'owner-1', channel);
    info.mockRestore();
    expect(h.reminder).not.toHaveBeenCalled();
  });
});

// Recruiter agents (migration 202) draft on company and personal chats
// alike, with our messages row id, inside the promise handed to later.
describe('processMessage — recruiter agents hook', () => {
  const expected = {
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    messageId: 'row-1',
    text: 'hello',
  };

  const personal = { ...channel, isPersonal: true, personalUserId: 'owner-1' };

  for (const [name, ch] of [
    ['a company chat', channel],
    ['a personal chat', personal],
  ] as const) {
    it(`runs on ${name}, after the HR-lines auto-open, inside later`, async () => {
      h.autoOpen.mockImplementation(async () => {
        h.order.push('autoOpen');
        return 'opened';
      });
      h.hrAgents.mockImplementation(async () => {
        h.order.push('hrAgents');
      });
      const later: Promise<unknown>[] = [];
      await processMessage(message, 'acct-1', 'owner-1', ch, later);
      expect(h.autoOpen).toHaveBeenCalledTimes(1);
      expect(h.autoOpen.mock.calls[0][0]).toEqual({
        conversationId: 'conv-1',
        channelId: 'ch-1',
      });
      // The agents hook waits on the auto-open: it runs once later settles.
      await Promise.all(later);
      expect(h.hrAgents).toHaveBeenCalledTimes(1);
      expect(h.hrAgents.mock.calls[0][0]).toEqual(expected);
      expect(h.order).toEqual(['autoOpen', 'hrAgents']);
    });

    it(`on ${name}, a rejected auto-open still runs the agents hook`, async () => {
      h.autoOpen.mockRejectedValue(new Error('boom'));
      const later: Promise<unknown>[] = [];
      await processMessage(message, 'acct-1', 'owner-1', ch, later);
      await Promise.all(later);
      expect(h.hrAgents).toHaveBeenCalledTimes(1);
      expect(h.hrAgents.mock.calls[0][0]).toEqual(expected);
    });
  }

  it('never runs over the rate limit (fanOut: false) or on a replay', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });
    h.upsertRows = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await processMessage(message, 'acct-1', 'owner-1', channel);
    info.mockRestore();
    expect(h.hrAgents).not.toHaveBeenCalled();
    expect(h.autoOpen).not.toHaveBeenCalled();
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
    expect(triggers()).toEqual([
      'new_message_received',
      'keyword_match',
      'intent_match',
    ]);
    expect(h.ai).toHaveBeenCalledTimes(1);
  });

  it('hands intent_match the gateway message id as its memo key', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    const call = h.automations.mock.calls.find(
      (c) => (c[0] as { triggerType: string }).triggerType === 'intent_match'
    );
    expect(call?.[0]).toMatchObject({
      context: { message_id: 'wamid.over-limit', conversation_id: 'conv-1' },
    });
  });

  it('tells every automation it dispatches that the customer just wrote', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.automations).toHaveBeenCalled();
    for (const [input] of h.automations.mock.calls) {
      expect(input).toMatchObject({ customerJustWrote: true });
    }
  });

  it('never dispatches intent_match while meaning triggers are off', async () => {
    h.meaningOn = false;
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(triggers()).toEqual(['new_message_received', 'keyword_match']);
  });

  it('skips intent_match when a keyword_match automation acted', async () => {
    h.automations.mockImplementation(
      async (input: { triggerType: string }) =>
        input.triggerType === 'keyword_match'
    );
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(triggers()).toEqual(['new_message_received', 'keyword_match']);
  });

  it.each([
    ['intent_match', true],
    ['first_inbound_message', false],
  ])(
    'tells the AI reply that %s acted: meaning trigger %s',
    async (trigger, acted) => {
      h.automations.mockImplementation(
        async (input: { triggerType: string }) => input.triggerType === trigger
      );
      await processMessage(message, 'acct-1', 'owner-1', channel);
      expect(h.ai).toHaveBeenCalledWith(
        expect.objectContaining({ meaningTriggerActed: acted })
      );
    }
  );

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

    expect(triggers()).toEqual([
      'new_message_received',
      'keyword_match',
      'intent_match',
    ]);
    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(h.webhook).toHaveBeenCalled();
  });
});

// A 1-5 reply to a case rating request (migration 246) is captured after
// Flows: a Flow that consumed it wins; a captured rating is consumed.
describe('processMessage — case CSAT reply', () => {
  const triggers = () =>
    h.automations.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    );
  const rating = { ...message, id: 'wamid.csat', text: '5' };

  it('asks nothing of the database for a message that is not a rating', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.rpcs).not.toContain('case_csat_capture');
  });

  it('a captured rating stands the journey, content automations and AI down', async () => {
    h.csatRpc.mockResolvedValue({ data: true, error: null });
    await processMessage(rating, 'acct-1', 'owner-1', channel);
    const i = h.rpcs.indexOf('case_csat_capture');
    expect(h.rpcArgs[i]).toEqual({
      p_account: 'acct-1',
      p_contact: 'contact-1',
      p_conversation: 'conv-1',
      p_message: 'row-1',
      p_quoted: null,
      p_score: 5,
      p_comment: null,
    });
    expect(h.journey).not.toHaveBeenCalled();
    expect(triggers()).toEqual([]);
    expect(h.ai).not.toHaveBeenCalled();
  });

  it('a captured rating with a comment still reaches the journey and the AI', async () => {
    h.csatRpc.mockResolvedValue({ data: true, error: null });
    await processMessage(
      { ...rating, text: '1, please call me' },
      'acct-1',
      'owner-1',
      channel
    );
    expect(h.rpcs).toContain('case_csat_capture');
    expect(h.journey).toHaveBeenCalledTimes(1);
    expect(h.ai).toHaveBeenCalledTimes(1);
  });

  it('a rating no request was open for fans out as usual', async () => {
    await processMessage(rating, 'acct-1', 'owner-1', channel);
    expect(h.rpcs).toContain('case_csat_capture');
    expect(h.journey).toHaveBeenCalledTimes(1);
    expect(h.ai).toHaveBeenCalledTimes(1);
  });

  it('a Flow that consumed the reply wins: nothing is captured', async () => {
    h.flows.mockResolvedValue({ consumed: true });
    h.csatRpc.mockResolvedValue({ data: true, error: null });
    await processMessage(rating, 'acct-1', 'owner-1', channel);
    expect(h.rpcs).not.toContain('case_csat_capture');
  });

  it('never runs over the rate limit (fanOut: false)', async () => {
    await processMessage(rating, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });
    expect(h.rpcs).not.toContain('case_csat_capture');
  });
});

// Smart insights run after TypeSafe's watch (so its triage row can be
// reused) and are collected in `later` with it, never left floating.
describe('processMessage — Smart insights', () => {
  it('runs after the watch, inside the promise handed to later', async () => {
    let finishWatch!: () => void;
    h.watch.mockReturnValue(
      new Promise<void>((resolve) => {
        finishWatch = resolve;
      })
    );
    const later: Promise<unknown>[] = [];
    await processMessage(message, 'acct-1', 'owner-1', channel, later);

    // The insights chain, the reminder suggestion and the HR agents hook.
    expect(later).toHaveLength(3);
    expect(h.watch).toHaveBeenCalledTimes(1);
    expect(h.insights).not.toHaveBeenCalled();

    finishWatch();
    await Promise.all(later);
    expect(h.insights).toHaveBeenCalledTimes(1);
    expect(h.insights.mock.calls[0][0]).toEqual({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      messageId: 'wamid.over-limit',
      text: 'hello',
      // The stored row's created_at.
      messageAt: '2025-10-09T08:53:20.000Z',
    });
    const upsert = h.calls.find(
      (c) => c.table === 'messages' && c.op === 'upsert'
    );
    expect(upsert?.payload).toMatchObject({
      created_at: '2025-10-09T08:53:20.000Z',
    });
  });

  it('without later, processMessage awaits it before returning', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.insights).toHaveBeenCalledTimes(1);
    expect(h.watch.mock.invocationCallOrder[0]).toBeLessThan(
      h.insights.mock.invocationCallOrder[0]
    );
  });

  it('hands the insights outcome to automatic tagging, in the same chain', async () => {
    let finishAutoTag: () => void = () => {};
    h.autoTag.mockReturnValue(
      new Promise<string>((resolve) => {
        finishAutoTag = () => resolve('applied');
      })
    );
    const later: Promise<unknown>[] = [];
    await processMessage(message, 'acct-1', 'owner-1', channel, later);
    let settled = false;
    void Promise.all(later).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.autoTag).toHaveBeenCalledTimes(1);
    expect(h.autoTag.mock.calls[0]).toEqual([
      { accountId: 'acct-1', conversationId: 'conv-1', contactId: 'contact-1' },
      { skipped: 'off' },
    ]);
    // `later` waits for the automatic tag too, so after() keeps it alive.
    expect(settled).toBe(false);
    finishAutoTag();
    await Promise.all(later);
    expect(settled).toBe(true);
  });
});

// Campaign reply sorting (migration 148): a first reply to a broadcast
// is classified before the follow-up flow starts, the class is seeded
// into the flow's vars, and an interested reply is tagged after Flows.
describe('processMessage — campaign reply sorting', () => {
  beforeEach(() => {
    h.recipientRows = [
      {
        id: 'rec-1',
        status: 'read',
        broadcast_id: 'bc-1',
        broadcasts: { account_id: 'acct-1', follow_up_flow_id: 'flow-9' },
      },
    ];
    h.flows.mockImplementation(async () => {
      h.order.push('flows');
      return { consumed: false };
    });
    h.tagInterested.mockImplementation(async () => {
      h.order.push('tag');
      return 'applied';
    });
    h.automations.mockImplementation(async () => {
      h.order.push('automations');
    });
  });

  it('classifies the first reply with a 1.5 s budget and seeds the class', async () => {
    h.classify.mockResolvedValue({ cls: 'interested', p: 0.91 });
    await processMessage(message, 'acct-1', 'owner-1', channel);

    expect(h.classify).toHaveBeenCalledWith({
      accountId: 'acct-1',
      recipientId: 'rec-1',
      broadcastId: 'bc-1',
      replyText: 'hello',
      tappedButton: null,
      deadlineMs: 1500,
      // The first-reply-since-the-send check runs on this message.
      inboundMessageId: 'row-1',
      conversationId: 'conv-1',
    });
    expect(h.flows.mock.calls[0]![0]).toMatchObject({
      campaign: {
        broadcastId: 'bc-1',
        followUpFlowId: 'flow-9',
        replyClass: { cls: 'interested', p: 0.91 },
      },
    });
    expect(h.tagInterested).toHaveBeenCalledWith({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      replyClass: { cls: 'interested', p: 0.91 },
    });
    // The flow's first message goes out before the tag; the tag lands
    // before automations (relationship triggers still run here).
    expect(h.order.indexOf('flows')).toBeLessThan(h.order.indexOf('tag'));
    expect(h.order.indexOf('tag')).toBeLessThan(h.order.indexOf('automations'));
  });

  it('passes a tapped button as both the reply and the button', async () => {
    await processMessage(
      {
        ...message,
        type: 'interactive',
        text: null,
        interactiveReplyId: 'btn_yes',
        interactiveReplyTitle: 'Yes please',
      } as NormalizedInboundMessage,
      'acct-1',
      'owner-1',
      channel
    );
    expect(h.classify.mock.calls[0]![0]).toMatchObject({
      replyText: 'Yes please',
      tappedButton: 'Yes please',
    });
  });

  it('starts the flow without a class when none came back', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.flows.mock.calls[0]![0]).toMatchObject({
      campaign: { followUpFlowId: 'flow-9', replyClass: null },
    });
  });

  it('without a follow-up flow, classifies alongside Flows and tags with the class', async () => {
    h.recipientRows = [
      {
        id: 'rec-1',
        status: 'read',
        broadcast_id: 'bc-1',
        broadcasts: { account_id: 'acct-1', follow_up_flow_id: null },
      },
    ];
    h.classify.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            h.order.push('classified');
            resolve({ cls: 'interested', p: 0.91 });
          }, 20)
        )
    );
    await processMessage(message, 'acct-1', 'owner-1', channel);

    // Flows did not wait for the judgment…
    expect(h.order.indexOf('flows')).toBeLessThan(
      h.order.indexOf('classified')
    );
    expect(h.flows.mock.calls[0]![0]).toMatchObject({ campaign: null });
    // …and the tag step did.
    expect(h.order.indexOf('classified')).toBeLessThan(h.order.indexOf('tag'));
    expect(h.tagInterested).toHaveBeenCalledWith(
      expect.objectContaining({ replyClass: { cls: 'interested', p: 0.91 } })
    );
  });

  it('classifies nothing when the message answers no campaign', async () => {
    h.recipientRows = [];
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.tagInterested).toHaveBeenCalledWith(
      expect.objectContaining({ replyClass: null })
    );
  });
});

// Customer documents (migration 178): a document or photo the customer
// sends is filed through customer_documents_record, once per stored
// message, after the idempotency boundary and before the fan-out cut.
// These files are already in our own bucket, so they are recorded inline.
describe('processMessage — customer documents', () => {
  const FILE_URL =
    'https://crm.example.com/storage/v1/object/public/chat-media/account-acct-1/inbound/abc.pdf';

  function media(
    type: NormalizedInboundMessage['type'],
    filename: string | null,
    mimeType: string,
    text: string | null
  ): NormalizedInboundMessage {
    return {
      ...message,
      id: `wamid.${type}`,
      type,
      text,
      media: { id: 'media-1', mimeType, link: FILE_URL, filename, fileSize: 1 },
    };
  }

  const docCalls = () =>
    h.rpcs.flatMap((fn, i) =>
      fn === 'customer_documents_record' ? [h.rpcArgs[i]] : []
    );

  it('records a customer document with the stored row, URL and MIME', async () => {
    await processMessage(
      media('document', 'salary.pdf', 'application/pdf', 'my salary slip'),
      'acct-1',
      'owner-1',
      channel
    );

    expect(docCalls()).toEqual([
      {
        p_account_id: 'acct-1',
        p_contact_id: 'contact-1',
        p_source: 'chat',
        p_kind: 'document',
        p_media_url: FILE_URL,
        p_received_at: '2025-10-09T08:53:20.000Z',
        p_conversation_id: 'conv-1',
        p_message_id: 'row-1',
        p_mime: 'application/pdf',
        p_original_name: 'salary.pdf',
        p_caption: 'my salary slip',
      },
    ]);
    // The URL and MIME are the ones written to the row.
    const upsert = h.calls.find(
      (c) => c.table === 'messages' && c.op === 'upsert'
    );
    expect(upsert?.payload).toMatchObject({
      media_url: FILE_URL,
      media_type: 'application/pdf',
      created_at: '2025-10-09T08:53:20.000Z',
    });
    // Then offered to the case desk (migration 230), by the id of the row
    // recorded for this message: the record RPC answers the folder's
    // reference, which the router's uuid argument refuses.
    expect(h.rpcs).toEqual([
      'bump_conversation_on_inbound',
      'push_whatsapp_inbound',
      'customer_documents_record',
      'desk_route_customer_document',
    ]);
    expect(h.rpcArgs.at(-1)).toMatchObject({
      p_account: 'acct-1',
      p_document: DOC_ROW_ID,
      p_channel: channel.id,
    });
  });

  it('records a customer document for a photo, with no caption', async () => {
    await processMessage(
      media('image', null, 'image/jpeg', null),
      'acct-1',
      'owner-1',
      channel
    );

    expect(docCalls()).toEqual([
      expect.objectContaining({
        p_kind: 'image',
        p_media_url: FILE_URL,
        p_message_id: 'row-1',
        p_mime: 'image/jpeg',
        p_original_name: null,
        p_caption: null,
      }),
    ]);
  });

  it.each([
    ['sticker', 'image/webp'],
    ['audio', 'audio/ogg'],
    ['video', 'video/mp4'],
  ] as const)('records nothing for a %s', async (type, mime) => {
    await processMessage(
      media(type, null, mime, null),
      'acct-1',
      'owner-1',
      channel
    );
    expect(docCalls()).toEqual([]);
    expect(h.rpcs).toEqual([
      'bump_conversation_on_inbound',
      'push_whatsapp_inbound',
    ]);
  });

  it('records nothing for a text', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(docCalls()).toEqual([]);
  });

  it('records nothing on a replayed delivery', async () => {
    h.upsertRows = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await processMessage(
      media('document', 'salary.pdf', 'application/pdf', null),
      'acct-1',
      'owner-1',
      channel
    );
    info.mockRestore();
    expect(docCalls()).toEqual([]);
  });

  it('records a customer document from a sender over the rate limit', async () => {
    await processMessage(
      media('document', 'salary.pdf', 'application/pdf', null),
      'acct-1',
      'owner-1',
      channel,
      undefined,
      { fanOut: false }
    );
    expect(docCalls()).toHaveLength(1);
    expect(h.flows).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an error',
      () => Promise.resolve({ data: null, error: { message: 'bad input' } }),
    ],
    ['a rejection', () => Promise.reject(new Error('fetch failed'))],
  ])(
    'a record that fails with %s leaves the pipeline running',
    async (_label, reply) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      h.docRpc.mockImplementation(reply);

      await expect(
        processMessage(
          media('document', 'salary.pdf', 'application/pdf', null),
          'acct-1',
          'owner-1',
          channel
        )
      ).resolves.toBeUndefined();
      log.mockRestore();

      expect(h.rpcs).toEqual([
        'bump_conversation_on_inbound',
        'push_whatsapp_inbound',
        'customer_documents_record',
      ]);
      expect(h.reopen).toHaveBeenCalledTimes(1);
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
    }
  );
});

// A file that is NOT in our own bucket (the number opted out of
// mirroring, the mirror failed, or it was too big) is stored on the row
// as the gateway's link, which the credential-free NAS worker can never
// download. It is filed by a deferred copy instead, never inline.
describe('processMessage — customer documents without our own copy', () => {
  const LOOKASIDE =
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';
  const STORED =
    'https://crm.example.com/storage/v1/object/public/chat-media/account-acct-1/inbound/media-1.pdf';
  const mirror = vi.mocked(mirrorInboundMedia);

  // A Meta number with mirroring off (039): the row keeps the lookaside URL.
  const pdf: NormalizedInboundMessage = {
    ...message,
    id: 'wamid.pdf',
    type: 'document',
    text: null,
    media: {
      id: 'media-1',
      mimeType: 'application/pdf',
      link: LOOKASIDE,
      filename: 'salary.pdf',
      fileSize: 1,
    },
  };

  const docUrls = () =>
    h.rpcs.flatMap((fn, i) =>
      fn === 'customer_documents_record'
        ? [(h.rpcArgs[i] as { p_media_url: string }).p_media_url]
        : []
    );

  beforeEach(() => {
    mirror.mockReset().mockResolvedValue(STORED);
  });

  it('never records the lookaside URL inline', async () => {
    await processMessage(pdf, 'acct-1', 'owner-1', channel);

    expect(docUrls()).not.toContain(LOOKASIDE);
    // The message row is not changed: it keeps the link it had.
    const upsert = h.calls.find(
      (c) => c.table === 'messages' && c.op === 'upsert'
    );
    expect(upsert?.payload).toMatchObject({ media_url: LOOKASIDE });
  });

  it('the deferred copy records the mirrored URL, after the fan-out', async () => {
    await processMessage(pdf, 'acct-1', 'owner-1', channel);

    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        mediaId: 'media-1',
        downloadUrl: LOOKASIDE,
        accessToken: 'token',
        fileName: 'salary.pdf',
      })
    );
    expect(docUrls()).toEqual([STORED]);
    // Recorded, then offered to the case desk (migration 230).
    expect(h.rpcs.slice(-2)).toEqual([
      'customer_documents_record',
      'desk_route_customer_document',
    ]);
    expect(h.flows).toHaveBeenCalledTimes(1);
    expect(h.watch).toHaveBeenCalledTimes(1);
  });

  it('records nothing and logs one line when the copy fails', async () => {
    mirror.mockResolvedValue(null);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processMessage(pdf, 'acct-1', 'owner-1', channel);
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();

    expect(docUrls()).toEqual([]);
    expect(lines).toEqual([
      '[customer-docs] no durable copy for message row-1',
    ]);
  });

  it('runs on fanOut: false too', async () => {
    await processMessage(pdf, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });

    expect(docUrls()).toEqual([STORED]);
    expect(h.flows).not.toHaveBeenCalled();
  });

  it.each([
    ['fans out', {}],
    ['stops at the fan-out cut', { fanOut: false }],
  ] as const)(
    'with a later list it is pushed, not awaited inline, when it %s',
    async (_label, options) => {
      let finishCopy: (url: string) => void = () => {};
      mirror.mockImplementation(
        () => new Promise<string | null>((r) => (finishCopy = r))
      );
      const later: Promise<unknown>[] = [];

      await processMessage(pdf, 'acct-1', 'owner-1', channel, later, options);

      // processMessage returned while the copy is still running.
      expect(mirror).toHaveBeenCalledTimes(1);
      expect(docUrls()).toEqual([]);
      expect(later.length).toBeGreaterThan(0);

      finishCopy(STORED);
      await Promise.all(later);
      expect(docUrls()).toEqual([STORED]);
    }
  );
});

describe('processMessage — personal number (migration 190)', () => {
  const personal: WhatsAppChannel = {
    ...channel,
    isPersonal: true,
    personalUserId: 'owner-1',
  };
  const FILE_URL =
    'https://crm.example.com/storage/v1/object/public/chat-media/account-acct-1/inbound/abc.pdf';

  it('runs no bot: no flow, journey, automation, AI, insights or reply stamp', async () => {
    h.recipientRows = [
      {
        id: 'rec-1',
        status: 'read',
        broadcast_id: 'bc-1',
        broadcasts: { account_id: 'acct-1', follow_up_flow_id: 'flow-9' },
      },
    ];
    await processMessage(message, 'acct-1', 'owner-1', personal);

    expect(h.flows).not.toHaveBeenCalled();
    expect(h.journey).not.toHaveBeenCalled();
    expect(h.automations).not.toHaveBeenCalled();
    expect(h.ai).not.toHaveBeenCalled();
    expect(h.insights).not.toHaveBeenCalled();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.table === 'broadcast_recipients')).toBe(false);
  });

  it('sends no message.received webhook but still runs the opt-out watch', async () => {
    await processMessage(message, 'acct-1', 'owner-1', personal);

    expect(h.webhook).not.toHaveBeenCalled();
    expect(h.watch).toHaveBeenCalledTimes(1);
  });

  it('sends no conversation.created webhook for a new personal chat', async () => {
    h.convRows = [];
    await processMessage(message, 'acct-1', 'owner-1', personal);
    expect(
      h.calls.some((c) => c.table === 'conversations' && c.op === 'insert')
    ).toBe(true);
    expect(h.webhook).not.toHaveBeenCalled();
  });

  it('control: a new shared-number chat still sends conversation.created', async () => {
    h.convRows = [];
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.webhook).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'conversation.created',
      expect.anything()
    );
  });

  it('defers the watch into later when given one', async () => {
    const later: Promise<unknown>[] = [];
    await processMessage(message, 'acct-1', 'owner-1', personal, later);
    expect(later.length).toBeGreaterThan(0);
    await Promise.all(later);
    expect(h.watch).toHaveBeenCalledTimes(1);
  });

  it('files no customer document, even with a stored copy', async () => {
    const pdf: NormalizedInboundMessage = {
      ...message,
      id: 'wamid.personal-doc',
      type: 'document',
      media: {
        id: 'media-1',
        mimeType: 'application/pdf',
        link: FILE_URL,
        filename: 'salary.pdf',
        fileSize: 1,
      },
    };
    await processMessage(pdf, 'acct-1', 'owner-1', personal);

    expect(h.rpcs).not.toContain('customer_documents_record');
    expect(h.flows).not.toHaveBeenCalled();
  });

  it('control: a shared number still runs flows and automations', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.flows).toHaveBeenCalledTimes(1);
    expect(h.automations).toHaveBeenCalled();
    expect(h.ai).toHaveBeenCalledTimes(1);
  });
});

describe('processMessage — personal chats (migration 191)', () => {
  const convCalls = (op: Call['op']) =>
    h.calls.filter((c) => c.table === 'conversations' && c.op === op);

  it('a company inbound looks only in the company chat (personal_owner_id IS NULL)', async () => {
    await processMessage(message, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });
    const lookup = convCalls('select')[0];
    expect(lookup.filters).toContainEqual(['is', 'personal_owner_id', null]);
    expect(lookup.filters?.some(([, col]) => col === 'personal_owner_id')).toBe(
      true
    );
    expect(lookup.filters).not.toContainEqual(
      expect.arrayContaining(['eq', 'personal_owner_id'])
    );
  });

  it('an inbound on a personal number finds the owner’s personal chat', async () => {
    const personal = {
      ...channel,
      isPersonal: true,
      personalUserId: 'person-1',
    };
    await processMessage(message, 'acct-1', 'owner-1', personal, undefined, {
      fanOut: false,
    });
    expect(convCalls('select')[0].filters).toContainEqual([
      'eq',
      'personal_owner_id',
      'person-1',
    ]);
    expect(convCalls('insert')).toHaveLength(0);
  });

  it('creates the personal chat owned by and assigned to the person, on that number', async () => {
    h.convRows = [];
    const personal = {
      ...channel,
      isPersonal: true,
      personalUserId: 'person-1',
    };
    await processMessage(message, 'acct-1', 'owner-1', personal, undefined, {
      fanOut: false,
    });
    expect(convCalls('insert')[0].payload).toEqual({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      user_id: 'person-1',
      assigned_agent_id: 'person-1',
      channel_id: 'ch-1',
      personal_owner_id: 'person-1',
    });
  });
});

// Durable inbound (264): the queue's processor asks for a throw, so a
// message that was not stored is retried instead of settled.
describe('processMessage: onPersistFailure', () => {
  const run = (opts?: { onPersistFailure: 'throw' }) =>
    processMessage(message, 'acct-1', 'owner-1', channel, undefined, opts);

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    h.refuse = null;
    h.convRows = null;
    vi.restoreAllMocks();
  });

  it.each([
    ['conversations:select', 'conversation', null],
    ['messages:upsert', 'message', '57014'],
  ])('%s refused: throws only when asked to', async (refuse, stage, code) => {
    h.refuse = refuse;
    await expect(run()).resolves.toBeUndefined();
    await expect(run({ onPersistFailure: 'throw' })).rejects.toMatchObject({
      name: 'InboundPersistError',
      stage,
      code,
    });
    expect(h.rpcs).toEqual([]);
    expect(h.flows).not.toHaveBeenCalled();
  });

  it('a retry that finds the message stored repeats no side effect', async () => {
    h.upsertRows = [];
    await expect(run({ onPersistFailure: 'throw' })).resolves.toBeUndefined();
    expect(h.rpcs).toEqual([]);
    for (const fn of [h.flows, h.automations, h.ai, h.webhook, h.watch]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('a failure after the boundary does not throw', async () => {
    h.upsertRows = [{ id: 'row-1' }];
    h.refuse = 'conversations:update';
    await expect(run({ onPersistFailure: 'throw' })).resolves.toBeUndefined();
    expect(h.rpcs).toContain('bump_conversation_on_inbound');
  });
});

// A case without a live WhatsApp group is answered in this chat: its
// customer reply timer stops and a snooze ends (case_sla_event_system).
describe('processMessage — an open case without a group hears the customer', () => {
  const caseReads = () => h.calls.filter((c) => c.table === 'cases');

  it('sends the event to each open case this chat answers, once', async () => {
    const group = (over: Record<string, unknown>) => ({
      wa_mode: 'group',
      status: 'ACTIVE',
      wa_group_id: '1203@g.us',
      wa_closed_at: null,
      ...over,
    });
    h.caseRows = [
      { id: 'lead', group_id: null, group: null },
      {
        id: 'no-whatsapp',
        group_id: 'g-1',
        group: group({ wa_mode: 'none', wa_group_id: null }),
      },
      {
        id: 'ended',
        group_id: 'g-2',
        group: group({ status: 'ENDED' }),
      },
      // Creating it failed, or is still to come.
      {
        id: 'not-made',
        group_id: 'g-5',
        group: group({ wa_group_id: null }),
      },
      {
        id: 'closed',
        group_id: 'g-6',
        group: group({ wa_closed_at: '2026-11-20T09:00:00Z' }),
      },
      // Its own group tells it.
      { id: 'live-group', group_id: 'g-3', group: group({}) },
      // A group that could not be read is not taken for none.
      { id: 'unknown', group_id: 'g-4', group: null },
    ];
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(caseReads().map((c) => c.filters)).toEqual([
      [
        ['eq', 'account_id', 'acct-1'],
        ['eq', 'contact_id', 'contact-1'],
        ['is', 'closed_at', null],
      ],
    ]);
    expect(h.slaRpc.mock.calls.map(([a]) => a)).toEqual(
      ['lead', 'no-whatsapp', 'ended', 'not-made', 'closed'].map((id) => ({
        p_case: id,
        p_event: 'customer_message',
        p_now: expect.any(String),
      }))
    );
  });

  it('one read and nothing else for a contact with no lead', async () => {
    h.caseRows = [];
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(caseReads()).toHaveLength(1);
    expect(h.slaRpc).not.toHaveBeenCalled();
  });

  it('a sender over the rate limit answered too', async () => {
    h.caseRows = [{ id: 'lead-1' }];
    await processMessage(message, 'acct-1', 'owner-1', channel, undefined, {
      fanOut: false,
    });
    expect(h.slaRpc).toHaveBeenCalledTimes(1);
  });

  it('never on a replay or a personal number', async () => {
    h.caseRows = [{ id: 'lead-1' }];
    await processMessage(message, 'acct-1', 'owner-1', {
      ...channel,
      isPersonal: true,
      personalUserId: 'owner-1',
    });
    h.upsertRows = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await processMessage(message, 'acct-1', 'owner-1', channel);
    info.mockRestore();
    expect(caseReads()).toHaveLength(0);
    expect(h.slaRpc).not.toHaveBeenCalled();
  });

  it('a failed read or event is logged; the message still fans out', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.caseRows = [{ id: 'lead-1' }, { id: 'lead-2' }];
    h.slaRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'timeout' },
    });
    await processMessage(message, 'acct-1', 'owner-1', channel);
    expect(h.slaRpc).toHaveBeenCalledTimes(2);
    expect(h.flows).toHaveBeenCalledTimes(1);

    h.refuse = 'cases:select';
    await processMessage(message, 'acct-1', 'owner-1', channel);
    h.refuse = null;
    expect(h.slaRpc).toHaveBeenCalledTimes(2);
    expect(h.flows).toHaveBeenCalledTimes(2);
    expect(
      error.mock.calls.filter(([m]) => String(m).startsWith('[cases]'))
    ).toHaveLength(2);
    error.mockRestore();
  });
});
