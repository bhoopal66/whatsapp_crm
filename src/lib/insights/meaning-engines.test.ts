import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// Meaning triggers across both engines: the real Flows dispatch, the
// real automation dispatch and the real judgeMeanings over one fake
// Supabase, with only the decision layer and the settings stubbed. One
// inbound must cost exactly one Jev request, whichever engine asks
// first.
// ============================================================

const h = vi.hoisted(() => ({
  intentMatch: vi.fn(),
  flows: [] as Record<string, unknown>[],
  automations: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/ai/admin-client', async () => ({
  supabaseAdmin: () => fakeDb(),
}));
vi.mock('@/lib/flows/admin-client', async () => ({
  supabaseAdmin: () => fakeDb(),
}));
vi.mock('@/lib/automations/admin-client', async () => ({
  supabaseAdmin: () => fakeDb(),
}));
vi.mock('@/lib/insights/settings', () => ({
  insightsAvailable: () => true,
  getInsightSettings: async () => ({ meaningTriggersEnabled: true }),
}));
vi.mock('@/lib/typesafe', () => ({
  getDecisionLayer: () => ({ intentMatch: h.intentMatch }),
}));
vi.mock('@/lib/flows/channel-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'w1' })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'w2' })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: 'w3',
  })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: 'w4' })),
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => 'skipped'),
}));

function fakeDb() {
  const rows = (t: string): unknown[] =>
    t === 'flows'
      ? h.flows
      : t === 'automations'
        ? h.automations
        : t === 'contacts'
          ? [{ id: 'ct-1' }]
          : [];
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      is: () => b,
      not: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: () => b,
      insert: () => b,
      upsert: () => b,
      delete: () => b,
      maybeSingle: async () => ({
        data:
          table === 'contacts' || table === 'automation_logs'
            ? { id: `${table}-1` }
            : null,
        error: null,
      }),
      single: async () => ({ data: { id: `${table}-1` }, error: null }),
      then: (resolve: (r: unknown) => unknown) =>
        resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { __resetMeaningMemo } from './meaning';

const trigger = (description: string) => ({
  description,
  sensitivity: 'balanced',
});

beforeEach(() => {
  __resetMeaningMemo();
  h.intentMatch.mockReset();
  h.flows = [
    {
      id: 'f1',
      account_id: 'acct-1',
      user_id: 'u-1',
      status: 'active',
      entry_node_id: 'start',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      trigger_type: 'intent',
      trigger_config: trigger('The customer wants a car loan'),
    },
  ];
  h.automations = [
    {
      id: 'a1',
      account_id: 'acct-1',
      user_id: 'u-1',
      is_active: true,
      updated_at: '2026-01-01T00:00:00Z',
      trigger_type: 'intent_match',
      trigger_config: trigger('The customer asks about opening hours'),
    },
  ];
  // Neither matches: both engines run their full meaning path.
  h.intentMatch.mockImplementation(
    async (input: { candidates: unknown[] }) => ({
      ok: true,
      latencyMs: 5,
      p: input.candidates.map(() => 0.1),
    })
  );
});

describe('one inbound, both engines', () => {
  it('makes exactly one Jev request covering the flow and the automation', async () => {
    const flowResult = await dispatchInboundToFlows({
      accountId: 'acct-1',
      userId: 'u-1',
      contactId: 'ct-1',
      conversationId: 'cv-1',
      message: {
        kind: 'text',
        text: 'what time do you open?',
        meta_message_id: 'wamid.x',
      },
      isFirstInboundMessage: false,
    });
    expect(flowResult.consumed).toBe(false);

    await runAutomationsForTrigger({
      accountId: 'acct-1',
      triggerType: 'intent_match',
      contactId: 'ct-1',
      context: {
        message_text: 'what time do you open?',
        conversation_id: 'cv-1',
        message_id: 'wamid.x',
      },
    });

    expect(h.intentMatch).toHaveBeenCalledTimes(1);
    const sent = (
      h.intentMatch.mock.calls[0]![0] as {
        candidates: { description: string }[];
      }
    ).candidates.map((c) => c.description);
    expect(sent.sort()).toEqual(
      [
        'The customer asks about opening hours',
        'The customer wants a car loan',
      ].sort()
    );
  });
});
