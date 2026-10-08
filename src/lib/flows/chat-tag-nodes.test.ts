import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// Chat tags in a running flow: the "Set chat tag" node (node type
// `set_tag`) and the `chat_tag` condition subject.
//
// Drives the real `dispatchInboundToFlows` against a fake Supabase, the
// way dispatch.test.ts does, so "the run followed its edge" is asserted
// by the next node's send actually happening.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    flows: [] as unknown[],
    nodes: [] as unknown[],
    /** What the conversations lookup answers (the chat's tags). */
    conversation: null as Record<string, unknown> | null,
    conversationError: null as { message: string } | null,
    /** Every eq() filter applied to a conversations read. */
    conversationFilters: [] as [string, unknown][],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    insertedRun: null as Record<string, unknown> | null,
  },
}));

vi.mock('./admin-client', () => {
  function rows(table: string): unknown[] {
    if (table === 'flows') return h.state.flows;
    if (table === 'flow_nodes') return h.state.nodes;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        if (table === 'conversations') {
          h.state.conversationFilters.push([col, val]);
        }
        return b;
      },
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: () => b,
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        if (table === 'flow_runs') {
          h.state.insertedRun = {
            id: 'run-1',
            vars: {},
            reprompt_count: 0,
            ...row,
          };
        }
        return b;
      },
      maybeSingle: async () => {
        if (table === 'flow_runs') {
          return { data: h.state.insertedRun, error: null };
        }
        if (table === 'conversations') {
          return {
            data: h.state.conversationError ? null : h.state.conversation,
            error: h.state.conversationError,
          };
        }
        return { data: rows(table)[0] ?? null, error: null };
      },
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (
        resolve: (r: { data: unknown[]; error: null; count: number }) => unknown
      ) => resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }

  const db = {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ error: null }),
  };
  return { supabaseAdmin: () => db };
});

const engineSendText = vi.fn<
  (args: { text: string }) => Promise<{ whatsapp_message_id: string }>
>(async () => ({
  whatsapp_message_id: 'wamid.1',
}));
vi.mock('./channel-send', () => ({
  engineSendText: (args: { text: string }) => engineSendText(args),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'wamid.2' })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: 'wamid.3',
  })),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: 'wamid.4',
  })),
}));

vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => 'skipped'),
}));

const writeChatTags = vi.fn();
vi.mock('@/lib/chat-tags/server', () => ({
  writeConversationChatTags: (...a: unknown[]) => writeChatTags(...a),
}));

const dispatchChatTagSet = vi.fn<(args: unknown) => Promise<void>>(
  async () => undefined
);
vi.mock('@/lib/automations/chat-tag-dispatch', () => ({
  dispatchChatTagSet: (args: unknown) => dispatchChatTagSet(args),
}));

import { supabaseAdmin } from './admin-client';
import { dispatchInboundToFlows } from './engine';

const FLOW = {
  id: 'flow-1',
  account_id: 'acct-1',
  user_id: 'u-1',
  status: 'active',
  trigger_type: 'keyword',
  trigger_config: { keywords: ['go'] },
  entry_node_id: 'start',
  created_at: '2026-01-01T00:00:00Z',
};

function node(
  node_key: string,
  node_type: string,
  config: Record<string, unknown>
) {
  return {
    id: `n-${node_key}`,
    flow_id: 'flow-1',
    node_key,
    node_type,
    config,
  };
}

/** start → `step` → … with "yes" / "no" send_message nodes to land on. */
function flowWith(step: ReturnType<typeof node>) {
  return [
    node('start', 'start', { next_node_key: step.node_key }),
    step,
    node('yes', 'send_message', { text: 'yes', next_node_key: 'done' }),
    node('no', 'send_message', { text: 'no', next_node_key: 'done' }),
    node('done', 'end', {}),
  ];
}

function run() {
  return dispatchInboundToFlows({
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    message: { kind: 'text', text: 'go', meta_message_id: 'm1' },
    isFirstInboundMessage: false,
  });
}

function sentTexts(): string[] {
  return engineSendText.mock.calls.map(([args]) => args.text);
}

function errorEvents(): Record<string, unknown>[] {
  return h.state.inserted
    .filter(
      (i) => i.table === 'flow_run_events' && i.row.event_type === 'error'
    )
    .map((i) => i.row.payload as Record<string, unknown>);
}

const SAVED_OK = {
  ok: true,
  conversationId: 'cv-1',
  contactId: 'ct-1',
  previous: { chat_tag_id: null, chat_sub_tag_id: null },
  saved: { chat_tag_id: 'main-1', chat_sub_tag_id: 'sub-1' },
};

beforeEach(() => {
  h.state.flows = [FLOW];
  h.state.nodes = [];
  h.state.conversation = null;
  h.state.conversationError = null;
  h.state.conversationFilters = [];
  h.state.inserted = [];
  h.state.insertedRun = null;
  engineSendText.mockClear();
  writeChatTags.mockReset();
  writeChatTags.mockResolvedValue(SAVED_OK);
  dispatchChatTagSet.mockClear();
});

describe('Set chat tag node (set_tag)', () => {
  it("writes the run's chat with the service-role client, dispatches, and follows its edge", async () => {
    h.state.nodes = flowWith(
      node('tag', 'set_tag', {
        chat_tag_id: 'main-1',
        chat_sub_tag_id: 'sub-1',
        next_node_key: 'yes',
      })
    );

    const result = await run();

    expect(result.consumed).toBe(true);
    expect(writeChatTags).toHaveBeenCalledTimes(1);
    expect(writeChatTags).toHaveBeenCalledWith(supabaseAdmin(), {
      accountId: 'acct-1',
      conversationId: 'cv-1',
      next: { chat_tag_id: 'main-1', chat_sub_tag_id: 'sub-1' },
    });
    expect(dispatchChatTagSet).toHaveBeenCalledWith({
      accountId: 'acct-1',
      contactId: 'ct-1',
      conversationId: 'cv-1',
      previous: SAVED_OK.previous,
      saved: SAVED_OK.saved,
    });
    expect(sentTexts()).toEqual(['yes']);
    expect(errorEvents()).toEqual([]);
  });

  it('clears both tags when the main tag is null', async () => {
    h.state.nodes = flowWith(
      node('tag', 'set_tag', {
        chat_tag_id: null,
        chat_sub_tag_id: 'sub-1',
        next_node_key: 'yes',
      })
    );

    await run();

    expect(writeChatTags).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        next: { chat_tag_id: null, chat_sub_tag_id: null },
      })
    );
  });

  it('logs a failed write, dispatches nothing, and still follows its edge', async () => {
    writeChatTags.mockResolvedValue({
      ok: false,
      reason: 'invalid',
      message: 'sub-tag of another main tag',
    });
    h.state.nodes = flowWith(
      node('tag', 'set_tag', {
        chat_tag_id: 'main-1',
        chat_sub_tag_id: 'sub-x',
        next_node_key: 'yes',
      })
    );

    const result = await run();

    expect(result.consumed).toBe(true);
    expect(dispatchChatTagSet).not.toHaveBeenCalled();
    expect(errorEvents()).toEqual([
      { reason: 'set_tag_failed', detail: 'sub-tag of another main tag' },
    ]);
    expect(sentTexts()).toEqual(['yes']);
  });

  it('treats a legacy contact-tag config as a logged no-op that follows its edge', async () => {
    h.state.nodes = flowWith(
      node('tag', 'set_tag', {
        mode: 'add',
        tag_id: 'contact-tag-1',
        next_node_key: 'yes',
      })
    );

    const result = await run();

    expect(result.consumed).toBe(true);
    expect(writeChatTags).not.toHaveBeenCalled();
    expect(dispatchChatTagSet).not.toHaveBeenCalled();
    expect(errorEvents()).toEqual([{ reason: 'set_tag_contact_tag_retired' }]);
    expect(sentTexts()).toEqual(['yes']);
  });
});

describe('condition on a chat tag', () => {
  function conditionOn(
    subject: string,
    subject_key: string,
    operator = 'present'
  ) {
    return flowWith(
      node('if', 'condition', {
        subject,
        subject_key,
        operator,
        true_next: 'yes',
        false_next: 'no',
      })
    );
  }

  it("is true when the chat's main tag is the operand", async () => {
    h.state.conversation = { chat_tag_id: 'main-1', chat_sub_tag_id: 'sub-1' };
    h.state.nodes = conditionOn('chat_tag', 'main-1');

    await run();

    expect(sentTexts()).toEqual(['yes']);
    // The run's own chat, in the run's account.
    expect(h.state.conversationFilters).toEqual([
      ['account_id', 'acct-1'],
      ['id', 'cv-1'],
    ]);
  });

  it("is true when the chat's sub-tag is the operand", async () => {
    h.state.conversation = { chat_tag_id: 'main-1', chat_sub_tag_id: 'sub-1' };
    h.state.nodes = conditionOn('chat_tag', 'sub-1');

    await run();

    expect(sentTexts()).toEqual(['yes']);
  });

  it('is false when neither tag matches', async () => {
    h.state.conversation = { chat_tag_id: 'main-2', chat_sub_tag_id: null };
    h.state.nodes = conditionOn('chat_tag', 'main-1');

    await run();

    expect(sentTexts()).toEqual(['no']);
  });

  it('is negated by "is absent"', async () => {
    h.state.conversation = { chat_tag_id: 'main-2', chat_sub_tag_id: null };
    h.state.nodes = conditionOn('chat_tag', 'main-1', 'absent');

    await run();

    expect(sentTexts()).toEqual(['yes']);
  });

  it('evaluates the retired contact-tag subject false, with a log', async () => {
    h.state.nodes = conditionOn('tag', 'contact-tag-1');

    const result = await run();

    expect(result.consumed).toBe(true);
    expect(sentTexts()).toEqual(['no']);
    expect(errorEvents()).toEqual([
      { reason: 'condition_subject_unsupported', subject: 'tag' },
    ]);
    // Nothing read: neither a contact-tag lookup nor the chat's tags.
    expect(h.state.conversationFilters).toEqual([]);
  });
});
