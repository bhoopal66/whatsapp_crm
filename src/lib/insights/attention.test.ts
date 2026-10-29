import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// applyInsightAttention: a recording fake stands in for PostgREST, with
// the conversation as one real row (updates apply their filters to it)
// and a list of messages the "person replied" read filters.
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
  op: 'select' | 'update' | 'insert';
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
/** Runs just before the pin's update lands (a race). */
let beforeUpdate: (() => void) | null;

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

const db = {
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

const notes = () =>
  calls.filter((c) => c.table === 'conversation_events' && c.op === 'insert');

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
  h.notify.mockReset().mockResolvedValue(true);
});

describe('applyInsightAttention — pinning', () => {
  it('pins an open, unpinned chat at the message time, notes it and rings the assignee', async () => {
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'pinned', notified: true });
    expect(conv).toMatchObject({
      insight_attention_at: MESSAGE_AT,
      insight_attention_reason: 'upset',
    });
    const pin = calls.find(
      (c) => c.table === 'conversations' && c.op === 'update'
    )!;
    expect(pin.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(pin.filters).toContainEqual(['is', 'insight_attention_at', null]);
    expect(pin.filters).toContainEqual(['neq', 'status', 'closed']);
    expect(notes().map((c) => c.payload)).toEqual([
      {
        account_id: 'acct-1',
        conversation_id: 'conv-1',
        kind: 'insight_attention_set',
        actor_user_id: null,
        details: { reason: 'upset' },
      },
    ]);
    expect(h.notify).toHaveBeenCalledWith(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      recipientUserId: AGENT,
      reason: 'upset',
      contactName: 'Fatima',
    });
  });

  it('a person reply before the message does not stop the pin', async () => {
    messages = [
      {
        conversation_id: 'conv-1',
        sender_type: 'agent',
        sender_id: AGENT,
        created_at: '2026-10-29T07:59:59.000Z',
      },
    ];
    expect((await applyInsightAttention(db, args())).result).toBe('pinned');
  });

  it('is not re-pinned when a person replied at or after the message', async () => {
    messages = [
      {
        conversation_id: 'conv-1',
        sender_type: 'agent',
        sender_id: AGENT,
        created_at: '2026-10-29T08:00:02.000Z',
      },
    ];
    const out = await applyInsightAttention(db, args());
    expect(out.result).toBe('answered');
    expect(conv!.insight_attention_at).toBeNull();
    expect(notes()).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a bot or system message after the message does not count as a reply', async () => {
    messages = [
      {
        conversation_id: 'conv-1',
        sender_type: 'agent',
        sender_id: null,
        created_at: '2026-10-29T08:00:02.000Z',
      },
      {
        conversation_id: 'conv-1',
        sender_type: 'bot',
        sender_id: null,
        created_at: '2026-10-29T08:00:02.000Z',
      },
    ];
    expect((await applyInsightAttention(db, args())).result).toBe('pinned');
  });

  it('a closed chat is not pinned', async () => {
    conv!.status = 'closed';
    const out = await applyInsightAttention(db, args());
    expect(out.result).toBe('closed');
    expect(conv!.insight_attention_at).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a chat closed during the run is not pinned (compare-and-set)', async () => {
    beforeUpdate = () => {
      conv!.status = 'closed';
    };
    const out = await applyInsightAttention(db, args());
    expect(out.result).toBe('superseded');
    expect(conv!.insight_attention_at).toBeNull();
    expect(notes()).toEqual([]);
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
    expect(
      notes().map((c) => (c.payload as { details: unknown }).details)
    ).toEqual([{ reason: 'urgent', raisedFrom: 'callback' }]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('the same or a lower reason changes nothing', async () => {
    conv!.insight_attention_reason = 'wants_person';
    for (const reason of ['wants_person', 'upset', 'callback'] as const) {
      expect((await applyInsightAttention(db, args({ reason }))).result).toBe(
        'kept'
      );
    }
    expect(conv!.insight_attention_reason).toBe('wants_person');
    expect(calls.filter((c) => c.op !== 'select')).toEqual([]);
  });

  it('a pin a person cleared meanwhile is not raised back: no note, no bell', async () => {
    beforeUpdate = () => {
      conv!.insight_attention_at = null;
      conv!.insight_attention_reason = null;
    };
    const out = await applyInsightAttention(db, args({ reason: 'urgent' }));
    expect(out.result).toBe('superseded');
    expect(conv!.insight_attention_at).toBeNull();
    expect(notes()).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('applyInsightAttention — the compare-and-set on a new pin', () => {
  it('a pin set by another judgment meanwhile wins: no note, no bell', async () => {
    beforeUpdate = () => {
      conv!.insight_attention_at = '2026-10-29T08:00:01.000Z';
      conv!.insight_attention_reason = 'urgent';
    };
    const out = await applyInsightAttention(db, args());
    expect(out.result).toBe('superseded');
    expect(conv!.insight_attention_reason).toBe('urgent');
    expect(notes()).toEqual([]);
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
  for (const key of [
    'conversations:select',
    'messages:select',
    'conversations:update',
  ]) {
    it(`${key} failing is logged and reported as error`, async () => {
      fail[key] = 'down';
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = await applyInsightAttention(db, args());
      expect(out.result).toBe('error');
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });
  }

  it('a failed recipient read keeps the pin and rings nobody', async () => {
    fail['profiles:select'] = 'down';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'pinned', notified: false });
    expect(conv!.insight_attention_reason).toBe('upset');
    expect(h.notify).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a failed note keeps the pin and still rings', async () => {
    fail['conversation_events:insert'] = 'down';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await applyInsightAttention(db, args());
    expect(out).toEqual({ result: 'pinned', notified: true });
    err.mockRestore();
  });
});
