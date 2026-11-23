import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  // requireRole's refusal is a 403; anything else the route throws, a 500.
  toErrorResponse: vi.fn((err: unknown) =>
    err instanceof Error && err.message === 'forbidden'
      ? Response.json({ error: 'Forbidden' }, { status: 403 })
      : Response.json({ error: 'Internal error' }, { status: 500 })
  ),
}));

import { GET } from './route';

const NOW = new Date('2026-10-13T10:00:00Z');
const LEADER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const MY_TEAM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOT_MINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CALL1 = 'c1111111-1111-4111-8111-111111111111';
const CALL2 = 'c2222222-2222-4222-8222-222222222222';

// A PostgREST query is a chain of calls, awaited at the end: record the
// chain, and answer by table (and, for calls, by the columns asked for).
type Step = [string, unknown[]];
interface Query {
  table: string;
  steps: Step[];
}
let queries: Query[];
let answer: (q: Query) => { data: unknown; error: null };

function from(table: string) {
  const q: Query = { table, steps: [] };
  queries.push(q);
  const chain: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then')
          return (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown
          ) => Promise.resolve(answer(q)).then(resolve, reject);
        return (...args: unknown[]) => {
          q.steps.push([String(prop), args]);
          return chain;
        };
      },
    }
  );
  return chain;
}
// pbx_sees_all_calls() (198): a flagged call reviewer.
let reviewer = false;
const rpc = vi.fn(async (fn: string) =>
  fn === 'team_activity_limits'
    ? { data: [{ timezone: 'Asia/Dubai' }], error: null }
    : fn === 'pbx_sees_all_calls'
      ? { data: reviewer, error: null }
      : { data: [LEADER, AGENT], error: null }
);

const step = (q: Query, name: string) => q.steps.find(([n]) => n === name)?.[1];
const callQueries = () => queries.filter((q) => q.table === 'calls');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  queries = [];
  reviewer = false;
  answer = (q) => {
    switch (q.table) {
      case 'profiles':
        return {
          data: [
            { user_id: LEADER, full_name: 'Lina', account_role: 'team_leader' },
            { user_id: AGENT, full_name: 'Sara', account_role: 'agent' },
          ],
          error: null,
        };
      case 'teams':
        return { data: [{ id: MY_TEAM, name: 'Cards' }], error: null };
      case 'team_members':
        return { data: [{ team_id: MY_TEAM, user_id: AGENT }], error: null };
      case 'calls': {
        const columns = String(step(q, 'select')?.[0]);
        if (columns.startsWith('user_id'))
          return {
            data: [
              {
                user_id: AGENT,
                answered_at: '2026-10-12T08:00:00Z',
                recording_state: 'fetched',
                talk_seconds: 90,
                started_at: '2026-10-12T08:00:00Z',
              },
            ],
            error: null,
          };
        return {
          data: [CALL1, CALL2].map((id, i) => ({
            id,
            pbx_call_id: `p${i}`,
            direction: 'inbound',
            status: 'answered',
            started_at: `2026-10-12T0${8 - i}:00:00+00:00`,
            answered_at: null,
            ended_at: null,
            ring_seconds: 5,
            talk_seconds: 90,
            remote_number: '971500005678',
            did_number: null,
            extension: '101',
            contact_id: null,
            user_id: AGENT,
            disposition: null,
            notes: null,
            recording_state: 'fetched',
            meta: null,
          })),
          error: null,
        };
      }
      case 'call_recordings':
        return {
          data: [
            {
              call_id: CALL2,
              legal_hold: false,
              erased_at: '2026-10-13T00:00:00Z',
            },
          ],
          error: null,
        };
      default:
        return { data: [], error: null };
    }
  };
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc, from },
    accountId: 'acct-1',
    userId: LEADER,
    role: 'team_leader',
  });
});
afterEach(() => vi.useRealTimers());

const get = (query = '') =>
  GET(new Request(`http://x/api/pbx/calls/recordings${query}`));

describe('GET /api/pbx/calls/recordings', () => {
  it('is for staff only', async () => {
    mocks.requireRole.mockRejectedValueOnce(new Error('forbidden'));
    const res = await get();
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(res.status).toBe(403);
    expect(queries).toEqual([]);
  });

  it('refuses an agent who is not a call reviewer', async () => {
    mocks.requireRole.mockResolvedValueOnce({
      supabase: { rpc, from },
      accountId: 'acct-1',
      userId: AGENT,
      role: 'agent',
    });
    const res = await get();
    expect(res.status).toBe(403);
    expect(rpc).toHaveBeenCalledWith('pbx_sees_all_calls');
    expect(queries).toEqual([]);
  });

  it('gives a call reviewer agent every person and every team (198)', async () => {
    reviewer = true;
    mocks.requireRole.mockResolvedValueOnce({
      supabase: { rpc, from },
      accountId: 'acct-1',
      userId: AGENT,
      role: 'agent',
    });
    const res = await get();
    expect(res.status).toBe(200);
    // All-scope: nobody asked who is visible, no narrowing by leader.
    expect(rpc).not.toHaveBeenCalledWith('pbx_visible_user_ids');
    expect(
      step(
        queries.find((q) => q.table === 'profiles')!,
        'in'
      )
    ).toBeUndefined();
    expect(queries.find((q) => q.table === 'teams')!.steps).not.toContainEqual([
      'eq',
      ['leader_user_id', AGENT],
    ]);
    const body = await res.json();
    expect(body.calls.map((c: { id: string }) => c.id)).toEqual([CALL1]);
  });

  it('refuses a team the leader does not lead', async () => {
    const res = await get(`?team=${NOT_MINE}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You cannot view that team’s calls',
    });
    expect(callQueries()).toEqual([]);
  });

  it('refuses a person outside the scope', async () => {
    const res = await get(`?user=${OTHER}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You cannot view that person’s calls',
    });
    expect(callQueries()).toEqual([]);
  });

  it('reads only the people in scope, and drops erased recordings', async () => {
    const res = await get('?limit=1&minTalk=60');
    expect(res.status).toBe(200);
    // A leader's people: pbx_visible_user_ids among live staff.
    expect(
      step(
        queries.find((q) => q.table === 'profiles')!,
        'in'
      )
    ).toEqual(['user_id', [LEADER, AGENT]]);
    expect(queries.find((q) => q.table === 'teams')!.steps).toContainEqual([
      'eq',
      ['leader_user_id', LEADER],
    ]);
    const [summaryRead, listRead] = callQueries();
    for (const q of [summaryRead, listRead])
      expect(step(q, 'in')).toEqual(['user_id', [LEADER, AGENT]]);
    expect(listRead.steps).toContainEqual(['gte', ['talk_seconds', 60]]);
    expect(listRead.steps).toContainEqual(['limit', [2]]);

    const body = await res.json();
    expect(body.people.map((p: { userId: string }) => p.userId)).toEqual([
      LEADER,
      AGENT,
    ]);
    expect(body.teams).toEqual([
      { id: MY_TEAM, name: 'Cards', memberIds: [AGENT] },
    ]);
    expect(body.summary).toEqual([
      expect.objectContaining({ userId: LEADER, calls: 0, recorded: 0 }),
      expect.objectContaining({
        userId: AGENT,
        calls: 1,
        recorded: 1,
        recordedSeconds: 90,
      }),
    ]);
    expect(body.summaryCapped).toBe(false);
    // limit=1 over a limit+1 read: one row, and a cursor past it.
    expect(body.calls.map((c: { id: string }) => c.id)).toEqual([CALL1]);
    expect(body.next).toBe(`2026-10-12T08:00:00Z|${CALL1}`);
  });

  it('narrows to the team asked for', async () => {
    const res = await get(`?team=${MY_TEAM}`);
    expect(res.status).toBe(200);
    for (const q of callQueries())
      expect(step(q, 'in')).toEqual(['user_id', [AGENT]]);
    const body = await res.json();
    // An erased recording has nothing to play.
    expect(body.calls.map((c: { id: string }) => c.id)).toEqual([CALL1]);
    expect(body.next).toBeNull();
  });

  it('skips the per-person summary on a Load more page', async () => {
    const res = await get(`?before=2026-10-12T08:00:00Z|${CALL1}`);
    expect(res.status).toBe(200);
    for (const q of callQueries())
      expect(String(step(q, 'select')?.[0])).not.toMatch(/^user_id/);
    expect(callQueries()).toHaveLength(1);
    const body = await res.json();
    expect(body.summary).toEqual([]);
    expect(body.summaryCapped).toBe(false);
    expect(body.calls.map((c: { id: string }) => c.id)).toEqual([CALL1]);
  });

  it('names only in-scope people among who rang', async () => {
    const base = answer;
    answer = (q) => {
      const res = base(q);
      if (
        q.table === 'calls' &&
        !String(step(q, 'select')?.[0]).startsWith('user_id')
      )
        (res.data as { meta: unknown }[])[0].meta = {
          rang_user_ids: [AGENT, OTHER],
        };
      if (
        q.table === 'profiles' &&
        step(q, 'select')?.[0] === 'user_id, full_name'
      )
        return {
          data: [
            { user_id: AGENT, full_name: 'Sara' },
            { user_id: OTHER, full_name: 'Outsider' },
          ].filter((p) => (step(q, 'in')?.[1] as string[]).includes(p.user_id)),
          error: null,
        };
      return res;
    };
    const body = await (await get()).json();
    const lookup = queries.filter(
      (q) =>
        q.table === 'profiles' &&
        step(q, 'select')?.[0] === 'user_id, full_name'
    );
    expect(lookup).toHaveLength(1);
    expect(step(lookup[0], 'in')?.[1]).not.toContain(OTHER);
    expect(body.calls[0].rangNames).toEqual(['Sara']);
    expect(JSON.stringify(body)).not.toContain('Outsider');
  });
});
