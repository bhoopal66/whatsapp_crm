/**
 * 022d SupabaseDigestSource over a fake supabase-js client: exact RPC names
 * and parameters, the case inbox called as the actor, related cases kept
 * only where case_can_read says so, and marked contacts dropped in TS.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { SupabaseDigestSource } from './digest-store';

const A = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
type Reply = { data: unknown; error: unknown };

function fakeClient(o: {
  rpc?: (fn: string, args: Record<string, unknown>) => Reply;
  tables?: Record<string, Reply>;
}) {
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const queries: { table: string; ops: unknown[][] }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return o.rpc?.(fn, args) ?? { data: null, error: null };
    },
    from: (table: string) => {
      const q = { table, ops: [] as unknown[][] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const m of [
        'select',
        'eq',
        'neq',
        'in',
        'not',
        'lt',
        'order',
        'limit',
      ])
        b[m] = (...args: unknown[]) => {
          q.ops.push([m, ...args]);
          return b;
        };
      b.then = (res: (r: Reply) => unknown) =>
        Promise.resolve(o.tables?.[table] ?? { data: [], error: null }).then(
          res
        );
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, rpcs, queries };
}

const inboxRow = (id: string, contact: string | null) => ({
  case_id: id,
  bank_code: 'ADCB',
  stage: 'Submitted',
  agent_id: U,
  priority: 'normal',
  last_activity_at: '2026-11-01T00:00:00Z',
  opened_at: '2026-10-01T00:00:00Z',
  closed_at: null,
  snoozed_until: null,
  contact_id: contact,
});

describe('SupabaseDigestSource', () => {
  it('cases: case_inbox as the actor (all snoozed, stalest, 200); marked contacts dropped', async () => {
    const now = new Date('2026-11-12T08:00:00Z');
    const { client, rpcs } = fakeClient({
      rpc: (fn, args) =>
        fn === 'case_inbox'
          ? {
              data: [
                inboxRow('c1', 'k1'),
                inboxRow('c2', 'k2'),
                inboxRow('c3', null),
              ],
              error: null,
            }
          : fn === 'brain_contact_marked'
            ? { data: args.p_contact === 'k2', error: null }
            : { data: null, error: null },
    });
    const out = await new SupabaseDigestSource(client).cases(U, A, now);
    expect(out.map((c) => c.caseId)).toEqual(['c1', 'c3']);
    expect(out[0]).toMatchObject({
      bankCode: 'ADCB',
      contactId: 'k1',
      outcome: null,
    });
    expect(rpcs[0]).toEqual({
      fn: 'case_inbox',
      args: {
        p_actor: U,
        p_account: A,
        p_filters: expect.objectContaining({ snoozed: 'all', sort: 'stalest' }),
        p_now: now.toISOString(),
        p_limit: 200,
        p_after: null,
      },
    });
    expect(
      rpcs.filter((r) => r.fn === 'brain_contact_marked').map((r) => r.args)
    ).toEqual([
      { p_account: A, p_contact: 'k1' },
      { p_account: A, p_contact: 'k2' },
    ]);
  });

  it('messages: brain_digest_messages with account, actor, since; marked dropped', async () => {
    const since = new Date('2026-10-29T08:00:00Z');
    const { client, rpcs } = fakeClient({
      rpc: (fn, args) =>
        fn === 'brain_digest_messages'
          ? {
              data: [
                {
                  item_id: 'i1',
                  case_id: 'c1',
                  contact_id: 'k1',
                  text: 'I will send',
                  created_by: U,
                  created_at: '2026-11-10T00:00:00Z',
                },
                {
                  item_id: 'i2',
                  case_id: 'c2',
                  contact_id: 'k2',
                  text: 'shortly',
                  created_by: U,
                  created_at: '2026-11-10T00:00:00Z',
                },
              ],
              error: null,
            }
          : { data: args.p_contact === 'k2', error: null },
    });
    const out = await new SupabaseDigestSource(client).messages(U, A, since);
    expect(out.map((m) => m.itemId)).toEqual(['i1']);
    expect(rpcs[0]).toEqual({
      fn: 'brain_digest_messages',
      args: { p_account: A, p_actor: U, p_since: since.toISOString() },
    });
  });

  it('closedCases: account-scoped closed cases with an outcome, only those case_can_read allows', async () => {
    const closed = (id: string, contact: string) => ({
      id,
      contact_id: contact,
      bank_code: 'ADCB',
      stage: 'Declined',
      outcome: 'Declined',
      closed_at: '2026-10-01T00:00:00Z',
    });
    const { client, rpcs, queries } = fakeClient({
      tables: {
        cases: {
          data: [closed('r1', 'k1'), closed('r2', 'k1'), closed('r3', 'k9')],
          error: null,
        },
      },
      rpc: (fn, args) =>
        fn === 'case_can_read'
          ? { data: args.p_case !== 'r2', error: null }
          : { data: args.p_contact === 'k9', error: null },
    });
    const out = await new SupabaseDigestSource(client).closedCases(
      U,
      A,
      ['k1'],
      ['ADCB']
    );
    expect(out.map((c) => c.caseId)).toEqual(['r1']);
    expect(out[0]).toMatchObject({
      outcome: 'Declined',
      closedAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(queries.map((q) => q.table)).toEqual(['cases', 'cases']);
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ['eq', 'account_id', A],
        ['in', 'contact_id', ['k1']],
        ['not', 'closed_at', 'is', null],
        ['not', 'outcome', 'is', null],
      ])
    );
    expect(queries[1]!.ops).toContainEqual(['in', 'bank_code', ['ADCB']]);
    expect(
      rpcs.filter((r) => r.fn === 'case_can_read').map((r) => r.args)
    ).toEqual([
      { p_case: 'r1', p_user: U },
      { p_case: 'r2', p_user: U },
      { p_case: 'r3', p_user: U },
    ]);
  });

  it('closedCases: no contacts and no banks reads nothing', async () => {
    const { client, rpcs, queries } = fakeClient({});
    expect(
      await new SupabaseDigestSource(client).closedCases(U, A, [], [])
    ).toEqual([]);
    expect(queries).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("tasksDueBefore: the actor's not-done case_tasks in the account due before the instant", async () => {
    const before = new Date('2026-11-12T20:00:00Z');
    const { client, queries } = fakeClient({
      tables: {
        case_tasks: {
          data: [
            {
              id: 't1',
              case_id: 'c1',
              title: 'Call bank',
              owner_id: U,
              due_at: '2026-11-12T09:00:00Z',
              status: 'open',
            },
          ],
          error: null,
        },
      },
    });
    const out = await new SupabaseDigestSource(client).tasksDueBefore(
      U,
      A,
      before
    );
    expect(out).toEqual([
      {
        taskId: 't1',
        caseId: 'c1',
        title: 'Call bank',
        ownerId: U,
        dueAt: new Date('2026-11-12T09:00:00Z'),
        status: 'open',
      },
    ]);
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ['eq', 'account_id', A],
        ['eq', 'owner_id', U],
        ['neq', 'status', 'done'],
        ['lt', 'due_at', before.toISOString()],
      ])
    );
  });

  it('a query error becomes a BrainError without the database text', async () => {
    const { client } = fakeClient({
      tables: {
        case_tasks: {
          data: null,
          error: { code: '42501', message: 'secret detail' },
        },
      },
    });
    await expect(
      new SupabaseDigestSource(client).tasksDueBefore(U, A, new Date())
    ).rejects.toMatchObject({
      name: 'BrainError',
      code: '42501',
      reason: null,
    });
  });
});
