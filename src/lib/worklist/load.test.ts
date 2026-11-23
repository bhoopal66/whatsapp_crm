import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { loadWorklistInputs } from './load';

type Answer = { data: unknown; error: unknown } | 'throw';

/** A chainable query whose every method returns itself and awaits to `answer`. */
function fakeSupabase(answers: Record<string, Answer>): SupabaseClient {
  return {
    from(table: string) {
      const answer = answers[table] ?? { data: [], error: null };
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'like', 'lt', 'order', 'limit'])
        q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        answer === 'throw'
          ? Promise.reject(new Error('boom')).then(ok, bad)
          : Promise.resolve(answer).then(ok, bad);
      return q;
    },
  } as unknown as SupabaseClient;
}

const jsonFetch = (status: number, body: unknown) =>
  vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  ) as unknown as typeof fetch;

describe('loadWorklistInputs', () => {
  const EMPTY = {
    hrConversations: [],
    hrTasks: [],
    hrRules: [],
    drafts: [],
    cases: [],
  };

  it('names every part that could not be read, never calls it empty', async () => {
    const sb = fakeSupabase({
      hr_conversations: { data: null, error: { message: 'timeout' } },
      hr_agent_drafts: { data: null, error: { message: 'x' } },
    });
    const out = await loadWorklistInputs(sb, jsonFetch(500, { error: 'x' }));
    expect(out).toEqual({
      inputs: EMPTY,
      failed: ['hr', 'drafts', 'cases'],
      casesTruncated: false,
    });
  });

  it('counts the HR part as failed when only its tasks or rule fail', async () => {
    const ok = jsonFetch(200, { rows: [], nextCursor: null });
    const tasks = await loadWorklistInputs(
      fakeSupabase({ tasks: 'throw' }),
      ok
    );
    expect(tasks.failed).toEqual(['hr']);
    const rules = await loadWorklistInputs(
      fakeSupabase({ hr_workflow_rules: { data: null, error: {} } }),
      ok
    );
    expect(rules.failed).toEqual(['hr']);
  });

  it('a fetch that throws is a failed case inbox', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const out = await loadWorklistInputs(fakeSupabase({}), f);
    expect(out.failed).toEqual(['cases']);
  });

  it('a 403 case inbox and an HR table that is not there are just empty', async () => {
    const gone = { data: null, error: { code: 'PGRST205' } };
    const sb = fakeSupabase({
      hr_conversations: gone,
      hr_workflow_rules: gone,
      hr_agent_drafts: { data: null, error: { code: '42P01' } },
    });
    const f = jsonFetch(403, {
      error: 'Your department does not have access to this',
    });
    const out = await loadWorklistInputs(sb, f);
    expect(out).toEqual({
      inputs: EMPTY,
      failed: [],
      casesTruncated: false,
    });
    expect(
      String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatch(/^\/api\/cases\?.*limit=200/);
  });

  it('attaches owner ids from the embedded chat and keeps no names', async () => {
    const sb = fakeSupabase({
      hr_conversations: {
        data: [
          {
            conversation_id: 'c-1',
            inbox: 'recruiter',
            closed_at: null,
            chat: { assigned_agent_id: 'u-1' },
          },
          {
            conversation_id: 'c-2',
            inbox: 'dept',
            closed_at: null,
            chat: null,
          },
        ],
        error: null,
      },
      hr_agent_drafts: {
        data: [
          {
            id: 'd-1',
            conversation_id: 'c-1',
            status: 'pending',
            created_at: '2026-11-19T00:00:00Z',
            hr: { inbox: 'recruiter', chat: [{ assigned_agent_id: 'u-1' }] },
          },
        ],
        error: null,
      },
    });
    const f = jsonFetch(200, { rows: [], nextCursor: null });
    const { inputs: out } = await loadWorklistInputs(sb, f);
    expect(
      out.hrConversations.map((c) => [c.conversation_id, c.ownerId])
    ).toEqual([
      ['c-1', 'u-1'],
      ['c-2', null],
    ]);
    expect(out.hrConversations[0]).not.toHaveProperty('chat');
    expect(out.drafts).toEqual([
      {
        id: 'd-1',
        conversation_id: 'c-1',
        status: 'pending',
        created_at: '2026-11-19T00:00:00Z',
        inbox: 'recruiter',
        ownerId: 'u-1',
      },
    ]);
  });

  it('orders the capped HR read by newest inbound first, nulls last', async () => {
    const orders: unknown[][] = [];
    const sb = {
      from(table: string) {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'like', 'lt', 'limit'])
          q[m] = () => q;
        q.order = (...args: unknown[]) => {
          if (table === 'hr_conversations') orders.push(args);
          return q;
        };
        q.then = (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(ok);
        return q;
      },
    } as unknown as SupabaseClient;
    await loadWorklistInputs(sb, jsonFetch(200, { rows: [] }));
    expect(orders).toEqual([
      ['last_inbound_at', { ascending: false, nullsFirst: false }],
    ]);
  });
});

describe('loadWorklistInputs cases option', () => {
  it('cases: false never calls fetch and yields no cases', async () => {
    const f = jsonFetch(200, { rows: [], nextCursor: null });
    const out = await loadWorklistInputs(fakeSupabase({}), f, Date.now(), {
      cases: false,
    });
    expect(out.inputs.cases).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('reads the cases by default', async () => {
    const f = jsonFetch(200, { rows: [], nextCursor: null });
    await loadWorklistInputs(fakeSupabase({}), f);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('loadWorklistInputs reads every page of cases', () => {
  const caseRow = (id: string) => ({
    caseId: id,
    stage: 'submitted',
    agentId: 'u-1',
    lastActivityAt: '2026-11-20T00:00:00Z',
  });
  /** Answers each `after` with its page; a number is an error status. */
  const paged = (
    pages: Record<string, { rows: string[]; next: string | null } | number>
  ) => {
    const asked: string[] = [];
    const f = vi.fn(async (url: string) => {
      const after = new URL(url, 'http://x').searchParams.get('after') ?? '';
      asked.push(after);
      const page = pages[after];
      if (typeof page === 'number') {
        return new Response('{"error":"x"}', { status: page });
      }
      return new Response(
        JSON.stringify({ rows: page.rows.map(caseRow), nextCursor: page.next })
      );
    }) as unknown as typeof fetch;
    return { f, asked };
  };
  const load = (f: typeof fetch) => loadWorklistInputs(fakeSupabase({}), f);
  const ids = (out: Awaited<ReturnType<typeof load>>) =>
    out.inputs.cases.map((c) => (c as unknown as { caseId: string }).caseId);

  it('follows nextCursor to the end, one row per case', async () => {
    const { f, asked } = paged({
      '': { rows: ['a', 'b'], next: 'k1' },
      k1: { rows: ['b', 'c'], next: 'k2' },
      k2: { rows: ['d'], next: null },
    });
    const out = await load(f);
    expect(asked).toEqual(['', 'k1', 'k2']);
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd']);
    expect([out.failed, out.casesTruncated]).toEqual([[], false]);
  });

  it('stops at 1,000 and says the list is cut', async () => {
    const { f, asked } = paged(
      Object.fromEntries(
        ['', 'k1', 'k2', 'k3', 'k4', 'k5'].map((k, i) => [
          k,
          { rows: [`c${i}`], next: `k${i + 1}` },
        ])
      )
    );
    const out = await load(f);
    expect(asked).toEqual(['', 'k1', 'k2', 'k3', 'k4']);
    expect(ids(out)).toHaveLength(5);
    expect([out.failed, out.casesTruncated]).toEqual([[], true]);
  });

  it.each([500, 403])(
    'a later page answering %i leaves the ones read, marked cut',
    async (status) => {
      const { f } = paged({ '': { rows: ['a'], next: 'k1' }, k1: status });
      const out = await load(f);
      expect(ids(out)).toEqual(['a']);
      expect([out.failed, out.casesTruncated]).toEqual([[], true]);
    }
  );

  it('a first page that fails is the part that failed', async () => {
    const { f } = paged({ '': 500 });
    const out = await load(f);
    expect(ids(out)).toEqual([]);
    expect([out.failed, out.casesTruncated]).toEqual([['cases'], false]);
  });
});
