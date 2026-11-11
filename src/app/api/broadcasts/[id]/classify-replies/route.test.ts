import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/broadcasts/[id]/classify-replies: the backfill over a
// broadcast's replied, unclassified recipients.

type Filters = [string, string, unknown][];
interface Q {
  table: string;
  filters: Filters;
  head: boolean;
  limit?: number;
  orders: string[];
}

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  on: true,
  classify: vi.fn(),
  broadcast: { id: 'b' } as unknown,
  recipients: [] as unknown[],
  /** customer message per conversation id */
  messages: {} as Record<string, unknown>,
  remaining: 0,
  queries: [] as Q[],
}));

function fakeSupabase() {
  return {
    from(table: string) {
      const q: Q = { table, filters: [], head: false, orders: [] };
      h.queries.push(q);
      const single = async () => {
        if (table === 'broadcasts') return { data: h.broadcast, error: null };
        if (table === 'conversations') {
          const contact = q.filters.find(([, c]) => c === 'contact_id')![2];
          return { data: { id: `conv-${contact}` }, error: null };
        }
        const conv = q.filters.find(([, c]) => c === 'conversation_id')![2];
        return { data: h.messages[conv as string] ?? null, error: null };
      };
      const b: Record<string, unknown> = {
        select: (_c: string, opts?: { head?: boolean }) => {
          q.head = Boolean(opts?.head);
          return b;
        },
        order: (c: string) => {
          q.orders.push(c);
          return b;
        },
        limit: (n: number) => {
          q.limit = n;
          return b;
        },
        maybeSingle: single,
        then: (res: (r: unknown) => unknown) =>
          Promise.resolve(
            q.head
              ? { count: h.remaining, error: null }
              : { data: h.recipients, error: null }
          ).then(res),
      };
      for (const f of ['eq', 'is', 'gte', 'gt'])
        b[f] = (c: string, v: unknown) => {
          q.filters.push([f, c, v]);
          return b;
        };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  assertSalesAccess: (c: unknown) => c,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/broadcasts/reply-class', () => ({
  replyClassOn: async () => h.on,
  classifyCampaignReply: (...a: unknown[]) => h.classify(...a),
}));

import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const post = (id = ID, body?: unknown) =>
  POST(
    new Request(`http://localhost/api/broadcasts/${id}/classify-replies`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) }
  );
const rid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  h.queries = [];
  h.on = true;
  h.broadcast = { id: ID };
  h.recipients = [
    {
      id: 'r1',
      contact_id: 'c1',
      sent_at: '2026-10-01T10:00:00Z',
      created_at: 'x',
    },
    {
      id: 'r2',
      contact_id: 'c2',
      sent_at: null,
      created_at: '2026-10-01T09:00:00Z',
    },
    {
      id: 'r3',
      contact_id: 'c3',
      sent_at: '2026-10-01T10:00:00Z',
      created_at: 'x',
    },
  ];
  h.messages = {
    'conv-c1': { content_text: 'yes please', interactive_reply_id: null },
    'conv-c2': { content_text: 'Interested', interactive_reply_id: 'btn_1' },
  };
  h.remaining = 1;
  h.classify.mockReset().mockResolvedValue({ cls: 'interested', p: 0.9 });
  h.requireRole.mockReset().mockResolvedValue({
    supabase: fakeSupabase(),
    accountId: 'acct-1',
    userId: 'u-1',
    role: 'admin',
  });
});

describe('POST /api/broadcasts/[id]/classify-replies', () => {
  it('classifies each replied recipient against its first reply', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      classified: 2,
      processed: 3,
      nextCursor: null,
      remaining: 1,
    });
    expect(h.requireRole).toHaveBeenCalledWith('admin');

    const recipientsQ = h.queries.find(
      (q) => q.table === 'broadcast_recipients' && !q.head
    )!;
    expect(recipientsQ.limit).toBe(500);
    expect(recipientsQ.orders).toEqual(['id']);
    expect(recipientsQ.filters).toEqual([
      ['eq', 'broadcast_id', ID],
      ['eq', 'status', 'replied'],
      ['is', 'reply_class', null],
    ]);
    // The reply is the first customer message since the send (else the
    // row's creation, for a recipient never stamped sent).
    const msgQs = h.queries.filter((q) => q.table === 'messages');
    expect(msgQs.map((q) => q.filters)).toContainEqual([
      ['eq', 'conversation_id', 'conv-c2'],
      ['eq', 'sender_type', 'customer'],
      ['gte', 'created_at', '2026-10-01T09:00:00Z'],
    ]);
    // Deterministic among messages sharing a (whole-second) created_at.
    for (const q of msgQs) expect(q.orders).toEqual(['created_at', 'id']);
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        recipientId: 'r1',
        broadcastId: ID,
        replyText: 'yes please',
        tappedButton: null,
      })
    );
    expect(h.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 'r2',
        replyText: 'Interested',
        tappedButton: 'Interested',
      })
    );
    const deadlines = h.classify.mock.calls.map(
      (c) => (c[0] as { deadlineMs: number }).deadlineMs
    );
    expect(Math.max(...deadlines)).toBeLessThanOrEqual(2500);
  });

  it('counts only replies that got a class', async () => {
    h.classify.mockResolvedValueOnce(null);
    expect(await (await post()).json()).toMatchObject({ classified: 1 });
  });

  it('walks past a full page of replies that cannot be sorted', async () => {
    // 500 voice notes: nothing classifiable, yet the cursor moves on so
    // the replies after them are reached on the next call.
    h.recipients = Array.from({ length: 500 }, (_, i) => ({
      id: rid(i + 1),
      contact_id: `v${i}`,
      sent_at: '2026-10-01T10:00:00Z',
      created_at: 'x',
    }));
    h.messages = {};
    const first = await (await post()).json();
    expect(first).toMatchObject({
      classified: 0,
      processed: 500,
      nextCursor: rid(500),
    });

    h.queries = [];
    h.recipients = [
      { id: rid(501), contact_id: 'c1', sent_at: 'x', created_at: 'x' },
    ];
    h.messages = {
      'conv-c1': { content_text: 'yes please', interactive_reply_id: null },
    };
    const second = await (await post(ID, { after: first.nextCursor })).json();
    expect(second).toMatchObject({
      classified: 1,
      processed: 1,
      nextCursor: null,
    });
    const recipientsQ = h.queries.find(
      (q) => q.table === 'broadcast_recipients' && !q.head
    )!;
    expect(recipientsQ.filters).toContainEqual(['gt', 'id', rid(500)]);
  });

  it('counts a reply as classified only when a class was written', async () => {
    h.classify.mockResolvedValue(null);
    expect(await (await post()).json()).toMatchObject({
      classified: 0,
      processed: 3,
    });
  });

  it('400s a cursor that is not a recipient id', async () => {
    expect((await post(ID, { after: 'r1; drop' })).status).toBe(400);
  });

  it('409s when reply sorting is off, before reading recipients', async () => {
    h.on = false;
    const res = await post();
    expect(res.status).toBe(409);
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.table === 'broadcast_recipients')).toBe(
      false
    );
  });

  it('404s a broadcast the caller cannot read, 400s a bad id', async () => {
    h.broadcast = null;
    expect((await post()).status).toBe(404);
    expect((await post('nope')).status).toBe(400);
  });

  it('refuses a caller below admin', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await post()).status).toBe(403);
  });
});
