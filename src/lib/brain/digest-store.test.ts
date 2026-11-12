/**
 * 022d SupabaseDigestSource over a fake supabase-js client: exact RPC names
 * and parameters, the case inbox called as the actor, one batched marks
 * lookup and one batched related-cases lookup.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { buildDigest } from './digest';
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
  it('cases: case_inbox as the actor (all snoozed, stalest, 200); marked contacts dropped with ONE brain_contacts_marked', async () => {
    const now = new Date('2026-11-12T08:00:00Z');
    const { client, rpcs } = fakeClient({
      rpc: (fn) =>
        fn === 'case_inbox'
          ? {
              data: [
                inboxRow('c1', 'k1'),
                inboxRow('c2', 'k2'),
                inboxRow('c3', null),
                inboxRow('c4', 'k1'),
              ],
              error: null,
            }
          : fn === 'brain_contacts_marked'
            ? { data: ['k2'], error: null }
            : { data: null, error: null },
    });
    const out = await new SupabaseDigestSource(client).cases(U, A, now);
    expect(out.map((c) => c.caseId)).toEqual(['c1', 'c3', 'c4']);
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
    expect(rpcs.slice(1)).toEqual([
      {
        fn: 'brain_contacts_marked',
        args: { p_account: A, p_contacts: ['k1', 'k2'] },
      },
    ]);
  });

  it('cases: no contacts on the page skips brain_contacts_marked', async () => {
    const { client, rpcs } = fakeClient({
      rpc: (fn) =>
        fn === 'case_inbox'
          ? { data: [inboxRow('c1', null)], error: null }
          : { data: null, error: null },
    });
    const out = await new SupabaseDigestSource(client).cases(
      U,
      A,
      new Date('2026-11-12T08:00:00Z')
    );
    expect(out.map((c) => c.caseId)).toEqual(['c1']);
    expect(rpcs.map((r) => r.fn)).toEqual(['case_inbox']);
  });

  it('messages: brain_digest_messages with account, actor, since; source_id mapped, no other calls', async () => {
    const since = new Date('2026-10-29T08:00:00Z');
    const { client, rpcs } = fakeClient({
      rpc: () => ({
        data: [
          {
            item_id: 'i1',
            source_id: 's1',
            case_id: 'c1',
            contact_id: 'k1',
            text: 'I will send',
            created_by: U,
            created_at: '2026-11-10T00:00:00Z',
          },
          {
            item_id: 'i2',
            source_id: null,
            case_id: 'c2',
            contact_id: 'k2',
            text: 'no source',
            created_by: U,
            created_at: '2026-11-10T00:00:00Z',
          },
        ],
        error: null,
      }),
    });
    const out = await new SupabaseDigestSource(client).messages(U, A, since);
    expect(out).toEqual([
      {
        itemId: 'i1',
        sourceId: 's1',
        caseId: 'c1',
        contactId: 'k1',
        text: 'I will send',
        createdBy: U,
        createdAt: new Date('2026-11-10T00:00:00Z'),
      },
    ]);
    expect(rpcs).toEqual([
      {
        fn: 'brain_digest_messages',
        args: { p_account: A, p_actor: U, p_since: since.toISOString() },
      },
    ]);
  });

  it('closedCases: ONE brain_digest_related, mapped with an empty stage', async () => {
    const { client, rpcs, queries } = fakeClient({
      rpc: () => ({
        data: [
          {
            case_id: 'r1',
            contact_id: 'k1',
            bank_code: 'ADCB',
            outcome: 'Declined',
            closed_at: '2026-10-01T00:00:00Z',
          },
        ],
        error: null,
      }),
    });
    const out = await new SupabaseDigestSource(client).closedCases(
      U,
      A,
      ['k1'],
      ['ADCB']
    );
    expect(out).toEqual([
      {
        caseId: 'r1',
        bankCode: 'ADCB',
        stage: '',
        contactId: 'k1',
        lastActivityAt: new Date('2026-10-01T00:00:00Z'),
        snoozedUntil: null,
        outcome: 'Declined',
        closedAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]);
    expect(rpcs).toEqual([
      {
        fn: 'brain_digest_related',
        args: {
          p_account: A,
          p_actor: U,
          p_contacts: ['k1'],
          p_banks: ['ADCB'],
          p_per: 2,
        },
      },
    ]);
    expect(queries).toEqual([]);
  });

  it('closedCases: no contacts and no banks reads nothing', async () => {
    const { client, rpcs, queries } = fakeClient({});
    expect(
      await new SupabaseDigestSource(client).closedCases(U, A, [], [])
    ).toEqual([]);
    expect(queries).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it('buildDigest over 30 cases, 30 contacts and several banks makes a constant number of RPCs', async () => {
    const now = new Date('2026-11-12T08:00:00Z');
    const n = 30;
    const inbox = Array.from({ length: n }, (_, i) => ({
      ...inboxRow(`c${i}`, `k${i}`),
      bank_code: `B${i % 5}`,
      last_activity_at: '2026-10-01T00:00:00Z',
    }));
    const { client, rpcs, queries } = fakeClient({
      rpc: (fn) => {
        if (fn === 'case_inbox') return { data: inbox, error: null };
        if (fn === 'brain_contacts_marked')
          return { data: ['k3'], error: null };
        if (fn === 'brain_digest_messages')
          return {
            data: inbox.map((r, i) => ({
              item_id: `i${i}`,
              source_id: `s${i}`,
              case_id: r.case_id,
              contact_id: r.contact_id,
              text: 'I will send it tomorrow',
              created_by: U,
              created_at: '2026-11-10T00:00:00Z',
            })),
            error: null,
          };
        if (fn === 'brain_digest_related')
          return {
            data: [
              {
                case_id: 'z1',
                contact_id: 'k0',
                bank_code: 'B0',
                outcome: 'Declined',
                closed_at: '2026-09-01T00:00:00Z',
              },
            ],
            error: null,
          };
        return { data: null, error: null };
      },
    });
    const d = await buildDigest({
      actorId: U,
      accountId: A,
      now,
      source: new SupabaseDigestSource(client),
    });
    // 29 unmarked open cases, each with a promise: the digest is not empty.
    expect(
      d.sections.find((s) => s.kind === 'promises')!.items.length
    ).toBeGreaterThan(0);
    expect(
      d.sections.find((s) => s.kind === 'related')!.items.length
    ).toBeGreaterThan(0);
    expect(rpcs.map((r) => r.fn)).toEqual([
      'case_inbox',
      'brain_contacts_marked',
      'brain_digest_messages',
      'brain_digest_related',
    ]);
    expect(queries.map((q) => q.table)).toEqual(['case_tasks']);
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
