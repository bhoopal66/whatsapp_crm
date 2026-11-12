/**
 * The supabase-js adapters: exact function and parameter names (the SQL
 * contract written in parallel), null for absent optionals, defensive row
 * parsing, and the refusal hint carried by BrainError.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { BrainError, SupabaseBrainStore, SupabaseCosineIndex } from './store';

type Reply = { data: unknown; error: unknown };

function fakeClient(reply: Reply = { data: null, error: null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return reply;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const keys = (o: Record<string, unknown>) => Object.keys(o).sort();

describe('SupabaseBrainStore', () => {
  it('upsert calls brain_item_upsert with every parameter, absent optionals null', async () => {
    const { client, calls } = fakeClient({ data: 'item-1', error: null });
    const id = await new SupabaseBrainStore(client).upsert({
      accountId: 'acc',
      sourceKind: 'note',
      sourceId: 'n1',
      text: 'hello',
    });
    expect(id).toBe('item-1');
    expect(calls).toEqual([
      {
        fn: 'brain_item_upsert',
        args: {
          p_account: 'acc',
          p_source_kind: 'note',
          p_source_id: 'n1',
          p_case: null,
          p_contact: null,
          p_bank_code: null,
          p_text: 'hello',
          p_ai_generated: false,
          p_restricted_role: null,
          p_created_by: null,
          p_system_label: null,
        },
      },
    ]);
  });

  it('isLive calls brain_item_live with the chunk and reads true', async () => {
    const { client, calls } = fakeClient({ data: true, error: null });
    const live = await new SupabaseBrainStore(client).isLive({
      accountId: 'acc',
      sourceKind: 'remember',
      sourceId: 'u1',
      text: 'hello',
    });
    expect(live).toBe(true);
    expect(calls).toEqual([
      {
        fn: 'brain_item_live',
        args: {
          p_account: 'acc',
          p_source_kind: 'remember',
          p_source_id: 'u1',
          p_text: 'hello',
        },
      },
    ]);
  });

  it('upsert passes the given fields and reads null as nothing stored', async () => {
    const { client, calls } = fakeClient({ data: null, error: null });
    const id = await new SupabaseBrainStore(client).upsert({
      accountId: 'acc',
      sourceKind: 'message',
      sourceId: 'wamid.1',
      caseId: 'case',
      contactId: 'contact',
      bankCode: 'ADCB',
      text: 't',
      aiGenerated: true,
      restrictedRole: 'coordinator',
      createdBy: null,
      systemLabel: 'system:inbound',
    });
    expect(id).toBeNull();
    expect(calls[0]!.args).toMatchObject({
      p_case: 'case',
      p_contact: 'contact',
      p_bank_code: 'ADCB',
      p_ai_generated: true,
      p_restricted_role: 'coordinator',
      p_created_by: null,
      p_system_label: 'system:inbound',
    });
  });

  it('forget sends one scope, the writer and the reason; the count may arrive as a string', async () => {
    const { client, calls } = fakeClient({ data: '3', error: null });
    const store = new SupabaseBrainStore(client);
    const at = new Date('2026-01-01T00:00:00Z');
    expect(
      await store.forget(
        { actorId: null, systemLabel: 'system:retention' },
        'acc',
        { olderThan: at },
        'retention'
      )
    ).toBe(3);
    await store.forget({ actorId: 'u1' }, 'acc', { itemId: 'i1' }, 'wrong');
    await store.forget({ actorId: 'u1' }, 'acc', { contactId: 'k1' }, 'gdpr');
    expect(calls.map((c) => c.fn)).toEqual([
      'brain_item_forget',
      'brain_item_forget',
      'brain_item_forget',
    ]);
    expect(calls[0]!.args).toEqual({
      p_actor: null,
      p_system_label: 'system:retention',
      p_account: 'acc',
      p_item: null,
      p_contact: null,
      p_older_than: '2026-01-01T00:00:00.000Z',
      p_reason: 'retention',
    });
    expect(calls[1]!.args).toMatchObject({
      p_actor: 'u1',
      p_system_label: null,
      p_item: 'i1',
      p_contact: null,
      p_older_than: null,
    });
    expect(calls[2]!.args).toMatchObject({ p_item: null, p_contact: 'k1' });
  });

  it('markContact and audit use their exact parameter names', async () => {
    const { client, calls } = fakeClient();
    const store = new SupabaseBrainStore(client);
    await store.markContact('u1', 'acc', 'k1', 'opt_out');
    await store.audit('acc', 'u1', 'ab'.repeat(32), 4);
    expect(calls).toEqual([
      {
        fn: 'brain_contact_mark',
        args: {
          p_actor: 'u1',
          p_account: 'acc',
          p_contact: 'k1',
          p_kind: 'opt_out',
        },
      },
      {
        fn: 'brain_audit_record',
        args: {
          p_account: 'acc',
          p_actor: 'u1',
          p_query_sha256: 'ab'.repeat(32),
          p_result_count: 4,
        },
      },
    ]);
  });

  it('maps a refusal hint to BrainError.reason', async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: 'raw db text', code: 'P0001', hint: 'TEXT_UNREDACTED' },
    });
    const err = await new SupabaseBrainStore(client)
      .upsert({ accountId: 'a', sourceKind: 'note', sourceId: 's', text: 't' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrainError);
    expect(err).toMatchObject({
      reason: 'TEXT_UNREDACTED',
      fn: 'brain_item_upsert',
      code: 'P0001',
    });
    expect((err as Error).message).not.toContain('raw db text');
  });

  it('maps NOT_ALLOWED, and an unknown error to reason null without its text', async () => {
    const refused = fakeClient({
      data: null,
      error: { message: 'x', code: '42501', hint: 'NOT_ALLOWED' },
    });
    await expect(
      new SupabaseBrainStore(refused.client).markContact(
        'u',
        'a',
        'k',
        'deletion'
      )
    ).rejects.toMatchObject({ reason: 'NOT_ALLOWED' });
    const broken = fakeClient({
      data: null,
      error: { message: 'secret detail', code: '57014', hint: 'whatever' },
    });
    const err = await new SupabaseBrainStore(broken.client)
      .audit('a', 'u', 'h', 0)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: 'BrainError',
      reason: null,
      code: '57014',
      fn: 'brain_audit_record',
    });
    expect((err as Error).message).not.toContain('secret detail');
  });
});

describe('SupabaseCosineIndex', () => {
  it('put calls brain_embedding_put with a plain array', async () => {
    const { client, calls } = fakeClient();
    await new SupabaseCosineIndex(client).put(
      'acc',
      'i1',
      'hashing-v1-256',
      [0.5, -0.5]
    );
    expect(calls).toEqual([
      {
        fn: 'brain_embedding_put',
        args: {
          p_account: 'acc',
          p_item: 'i1',
          p_model: 'hashing-v1-256',
          p_vec: [0.5, -0.5],
        },
      },
    ]);
  });

  it('candidates sends every parameter and parses rows defensively', async () => {
    const { client, calls } = fakeClient({
      data: [
        {
          item_id: 'i1',
          source_kind: 'note',
          source_id: 'n1',
          case_id: 'c1',
          contact_id: null,
          bank_code: 'ADCB',
          text: 'hello',
          ai_generated: false,
          created_at: '2026-11-01T00:00:00+00:00',
          cosine: '0.75',
          kw_rank: 0.25,
        },
        {
          item_id: 'i2',
          source_kind: 'unknown_kind',
          created_at: '2026-11-01',
        },
        { item_id: 'i3', source_kind: 'note', created_at: 'not a date' },
      ],
      error: null,
    });
    const cands = await new SupabaseCosineIndex(client).candidates({
      actorId: 'u1',
      accountId: 'acc',
      queryText: 'hello',
      vector: [1, 0],
      model: 'hashing-v1-256',
      limit: 50,
    });
    expect(calls).toEqual([
      {
        fn: 'brain_search_candidates',
        args: {
          p_actor: 'u1',
          p_account: 'acc',
          p_query: 'hello',
          p_qvec: [1, 0],
          p_model: 'hashing-v1-256',
          p_case: null,
          p_contact: null,
          p_bank_code: null,
          p_limit: 50,
        },
      },
    ]);
    expect(cands).toEqual([
      {
        itemId: 'i1',
        sourceKind: 'note',
        sourceId: 'n1',
        caseId: 'c1',
        contactId: null,
        bankCode: 'ADCB',
        text: 'hello',
        aiGenerated: false,
        createdAt: new Date('2026-11-01T00:00:00Z'),
        cosine: 0.75,
        kwRank: 0.25,
      },
    ]);
  });

  it('candidates passes the filters', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    await new SupabaseCosineIndex(client).candidates({
      actorId: 'u1',
      accountId: 'acc',
      queryText: 'q',
      vector: [],
      model: 'm',
      filters: { caseId: 'c', contactId: 'k', bankCode: 'FAB' },
      limit: 5,
    });
    expect(Object.keys(calls[0]!.args).sort()).toEqual(
      keys({
        p_actor: 0,
        p_account: 0,
        p_query: 0,
        p_qvec: 0,
        p_model: 0,
        p_case: 0,
        p_contact: 0,
        p_bank_code: 0,
        p_limit: 0,
      })
    );
    expect(calls[0]!.args).toMatchObject({
      p_case: 'c',
      p_contact: 'k',
      p_bank_code: 'FAB',
    });
  });
});
