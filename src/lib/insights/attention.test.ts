import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// applyInsightAttention: a recording fake stands in for PostgREST, with
// the conversation as one real row and a list of messages. The
// insight_pin_attention RPC is modelled on 153's function: one atomic
// step (verify-insights-v2.sql asserts the SQL itself). Plain table
// reads and updates are kept so the older two-request path still runs
// against this fake.
// ============================================================

const h = vi.hoisted(() => ({
  notify: vi.fn(),
}));
vi.mock('@/lib/notifications/insight-attention', () => ({
  notifyInsightAttention: h.notify,
}));

import { applyInsightAttention, type AttentionArgs } from './attention';

type Filter = [string, ...unknown[]];
interface Call {
  table: string;
  op: 'select' | 'update' | 'insert' | 'rpc';
  payload?: unknown;
  filters: Filter[];
}
type Result = { data: unknown; error: { message: string } | null };

const MESSAGE_AT = '2026-10-29T08:00:00.000Z';
const AGENT = 'user-agent';
const OWNER = 'user-owner';

let calls: Call[];
let conv: Record<string, unknown> | null;
let messages: Record<string, unknown>[];
let liveUsers: string[];
let fail: Partial<Record<string, string>>;
/** Runs just before the pin lands (a race): before the RPC's atomic
 *  step, or before a plain conversations update. */
let beforeUpdate: (() => void) | null;
/** insight_attention_set notes the RPC wrote (their details). */
let events: Record<string, unknown>[];
/** Overrides what the RPC answers. */
let rpcAnswer: unknown;

const ORDER = ['urgent', 'wants_person', 'upset', 'callback'];
const rank = (r: unknown) => {
  const i = ORDER.indexOf(String(r));
  return i < 0 ? ORDER.length : i;
};

const ms = (v: unknown) => Date.parse(String(v));

function matches(row: Record<string, unknown>, filters: Filter[]) {
  for (const [op, col, a, b] of filters) {
    const v = row[col as string];
    if (op === 'eq' && v !== a) return false;
    if (op === 'neq' && v === a) return false;
    if (op === 'is' && v !== a) return false;
    if (op === 'not' && a === 'is' && b === null && v == null) return false;
    if (op === 'gte' && !(ms(v) >= ms(a))) return false;
    if (op === 'in' && !(a as unknown[]).includes(v)) return false;
  }
  return true;
}

function respond(call: Call): Result {
  const key = `${call.table}:${call.op}`;
  if (fail[key]) return { data: null, error: { message: fail[key]! } };
  if (call.table === 'conversations') {
    if (call.op === 'select') return { data: conv && { ...conv }, error: null };
    beforeUpdate?.();
    if (!conv || !matches(conv, call.filters)) return { data: [], error: null };
    Object.assign(conv, call.payload);
    return { data: [{ id: conv.id }], error: null };
  }
  if (call.table === 'messages')
    return {
      data: messages.filter((m) => matches(m, call.filters)).slice(0, 1),
      error: null,
    };
  if (call.table === 'profiles')
    return {
      data: liveUsers
        .map((user_id) => ({
          user_id,
          account_id: 'acct-1',
          deactivated_at: null,
          account_role: 'agent',
        }))
        .filter((p) => matches(p, call.filters)),
      error: null,
    };
  if (call.table === 'contacts')
    return { data: { name: 'Fatima' }, error: null };
  return { data: null, error: null };
}

/** 153's insight_pin_attention, as one atomic step. */
function pinRpc(p: Record<string, unknown>): string {
  beforeUpdate?.();
  if (!conv || conv.account_id !== p.p_account || conv.status === 'closed')
    return 'closed';
  const answered = messages.some(
    (m) =>
      m.conversation_id === p.p_conv &&
      m.sender_type === 'agent' &&
      m.sender_id != null &&
      ms(m.created_at) >= ms(p.p_message_at)
  );
  if (answered) return 'answered';
  if (conv.insight_attention_at != null) {
    const from = conv.insight_attention_reason;
    if (rank(p.p_reason) >= rank(from)) return 'superseded';
    conv.insight_attention_reason = p.p_reason;
    events.push({ reason: p.p_reason, raisedFrom: from });
    return 'raised';
  }
  conv.insight_attention_at = p.p_message_at;
  conv.insight_attention_reason = p.p_reason;
  events.push({ reason: p.p_reason });
  return 'pinned';
}

const db = {
  rpc(fn: string, params: Record<string, unknown>) {
    const call: Call = {
      table: `rpc:${fn}`,
      op: 'rpc',
      payload: params,
      filters: [],
    };
    calls.push(call);
    if (fail[call.table])
      return Promise.resolve({
        data: null,
        error: { message: fail[call.table]! },
      });
    const data = pinRpc(params);
    return Promise.resolve({
      data: rpcAnswer === undefined ? data : rpcAnswer,
      error: null,
    });
  },
  from(table: string) {
    const call: Call = { table, op: 'select', filters: [] };
    const run = () => {
      calls.push(call);
      return Promise.resolve(respond(call));
    };
    const b: Record<string, unknown> = {};
    b.update = (payload: unknown) => {
      call.op = 'update';
      call.payload = payload;
      return b;
    };
    b.insert = (payload: unknown) => {
      call.op = 'insert';
      call.payload = payload;
      return b;
    };
    for (const name of [
      'select',
      'eq',
      'neq',
      'is',
      'not',
      'gte',
      'in',
      'limit',
      'order',
    ]) {
      b[name] = (...args: unknown[]) => {
        if (name !== 'select') call.filters.push([name, ...args]);
        return b;
      };
    }
    b.maybeSingle = () => run();
    b.then = (
      resolve: (r: Result) => unknown,
      reject?: (e: unknown) => unknown
    ) => run().then(resolve, reject);
    return b;
  },
} as unknown as SupabaseClient;

const args = (over: Partial<AttentionArgs> = {}): AttentionArgs => ({
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  messageAt: MESSAGE_AT,
  reason: 'upset',
  notify: true,
  ...over,
});

beforeEach(() => {
  calls = [];
  conv = {
    id: 'conv-1',
    account_id: 'acct-1',
    status: 'open',
    insight_attention_at: null,
    insight_attention_reason: null,
    assigned_agent_id: AGENT,
    user_id: OWNER,
  };
  messages = [];
  liveUsers = [AGENT, OWNER];
  fail = {};
  beforeUpdate = null;
  events = [];
  rpcAnswer = undefined;
  h.notify.mockReset().mockResolvedValue(true);
});

const PERSON_REPLY = {
  conversation_id: 'conv-1',
  sender_type: 'agent',
  sender_id: AGENT,
  created_at: '2026-10-29T08:00:02.000Z',
};

describe('applyInsightAttention — pinning', () => {
  it('pins an open, unpinned chat in one RPC call, and rings the assignee', async () => {
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'pinned', notified: true });
    const rpcs = calls.filter((c) => c.op === 'rpc');
    expect(rpcs.map((c) => [c.table, c.payload])).toEqual([
      [
        'rpc:insight_pin_attention',
        {
          p_account: 'acct-1',
          p_conv: 'conv-1',
          p_message_at: MESSAGE_AT,
          p_reason: 'upset',
        },
      ],
    ]);
    // The pin and its note are the RPC's; nothing else writes them.
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toEqual(
      []
    );
    expect(events).toEqual([{ reason: 'upset' }]);
    expect(h.notify).toHaveBeenCalledWith(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      recipientUserId: AGENT,
      reason: 'upset',
      contactName: 'Fatima',
    });
  });

  it('a person reply before the message does not stop the pin', async () => {
    messages = [{ ...PERSON_REPLY, created_at: '2026-10-29T07:59:59.000Z' }];
    expect((await applyInsightAttention(db, args())).result).toBe('pinned');
  });

  it('is not pinned when a person replied at or after the message', async () => {
    messages = [PERSON_REPLY];
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'answered', notified: false });
    expect(conv!.insight_attention_at).toBeNull();
    expect(events).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a bot or system message after the message does not count as a reply', async () => {
    messages = [
      { ...PERSON_REPLY, sender_id: null },
      { ...PERSON_REPLY, sender_type: 'bot', sender_id: null },
    ];
    expect((await applyInsightAttention(db, args())).result).toBe('pinned');
  });

  it('a closed chat is not pinned', async () => {
    conv!.status = 'closed';
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'closed', notified: false });
    expect(conv!.insight_attention_at).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('another account’s chat is not pinned', async () => {
    const out = await applyInsightAttention(db, args({ accountId: 'acct-2' }));
    expect(out.result).toBe('closed');
    expect(conv!.insight_attention_at).toBeNull();
  });
});

describe('applyInsightAttention — races are settled under the row lock', () => {
  it('a person reply committed just before the pin wins: answered, no pin, no bell', async () => {
    beforeUpdate = () => {
      messages.push(PERSON_REPLY);
    };
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'answered', notified: false });
    expect(conv!.insight_attention_at).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a chat closed just before the pin is not pinned', async () => {
    beforeUpdate = () => {
      conv!.status = 'closed';
    };
    const out = await applyInsightAttention(db, args());
    expect(out.result).toBe('closed');
    expect(conv!.insight_attention_at).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a pin set by another judgment first wins: no note, no bell', async () => {
    beforeUpdate = () => {
      conv!.insight_attention_at = '2026-10-29T08:00:01.000Z';
      conv!.insight_attention_reason = 'urgent';
    };
    const out = await applyInsightAttention(db, args());
    expect(out.result).toBe('superseded');
    expect(conv!.insight_attention_reason).toBe('urgent');
    expect(events).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('applyInsightAttention — an existing pin', () => {
  const PINNED_AT = '2026-10-29T07:00:00.000Z';
  beforeEach(() => {
    conv!.insight_attention_at = PINNED_AT;
    conv!.insight_attention_reason = 'callback';
  });

  it('a higher-precedence reason raises the reason, keeps the time, no bell', async () => {
    const out = await applyInsightAttention(db, args({ reason: 'urgent' }));
    expect(out).toEqual({ result: 'raised', notified: false });
    expect(conv).toMatchObject({
      insight_attention_at: PINNED_AT,
      insight_attention_reason: 'urgent',
    });
    expect(events).toEqual([{ reason: 'urgent', raisedFrom: 'callback' }]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === 'profiles')).toBe(false);
  });

  it('the same or a lower reason is superseded and changes nothing', async () => {
    conv!.insight_attention_reason = 'wants_person';
    for (const reason of ['wants_person', 'upset', 'callback'] as const) {
      expect(await applyInsightAttention(db, args({ reason }))).toEqual({
        result: 'superseded',
        notified: false,
      });
    }
    expect(conv!.insight_attention_reason).toBe('wants_person');
    expect(events).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('applyInsightAttention — the bell', () => {
  it('falls back to the owner when the assignee is not live staff here', async () => {
    liveUsers = [OWNER];
    await applyInsightAttention(db, args());
    expect(h.notify.mock.calls[0][1].recipientUserId).toBe(OWNER);
  });

  it('goes to the owner of an unassigned chat', async () => {
    conv!.assigned_agent_id = null;
    await applyInsightAttention(db, args());
    expect(h.notify.mock.calls[0][1].recipientUserId).toBe(OWNER);
  });

  it('rings nobody when neither is a live member, but the pin stays', async () => {
    liveUsers = [];
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'pinned', notified: false });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('rings nobody when the workspace switched the bell off', async () => {
    const out = await applyInsightAttention(db, args({ notify: false }));
    expect(out).toEqual({ result: 'pinned', notified: false });
    expect(h.notify).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === 'profiles')).toBe(false);
  });
});

describe('applyInsightAttention — failures never throw', () => {
  it('a failed RPC is logged and reported as error', async () => {
    fail['rpc:insight_pin_attention'] = 'down';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'error', notified: false });
    expect(h.notify).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('an answer the RPC never gives is reported as error, no bell', async () => {
    rpcAnswer = 'kept';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'error', notified: false });
    expect(h.notify).not.toHaveBeenCalled();
    err.mockRestore();
  });

  for (const key of ['conversations:select', 'profiles:select']) {
    it(`${key} failing keeps the pin and rings nobody`, async () => {
      fail[key] = 'down';
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = await applyInsightAttention(db, args());
      expect(out).toEqual({ result: 'pinned', notified: false });
      expect(conv!.insight_attention_reason).toBe('upset');
      expect(h.notify).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });
  }
});
