/**
 * 022c: the ExtractiveSummariser (deterministic, cited, capped, digit-safe),
 * the supabase-js page adapter (exact RPC names and parameters) and
 * rebuildDirtyPages (one retry on CONFLICT, failures counted).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  ExtractiveSummariser,
  PAGE_HEADER,
  SupabaseBrainPageStore,
  rebuildDirtyPages,
  type BrainPageStore,
  type PageSourceItem,
} from './pages';
import { brainRedact } from './redact';
import { BrainError } from './store';

const DIGIT_GUARD = /[0-9]([-. ]?[0-9]){8,}/; // what brain_page_put refuses
const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
const item = (
  id: string,
  sourceKind: string,
  text: string,
  m: number
): PageSourceItem => ({ id, sourceKind, text, createdAt: at(m) });
const id = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const id8 = (n: number) => `[item:${String(n).padStart(8, '0')}]`;

describe('022c ExtractiveSummariser', () => {
  const s = new ExtractiveSummariser();
  const items = [
    item(id(1), 'timeline', 'Stage changed from new to docs', 1),
    item(id(2), 'note', 'follow up on salary letter', 2),
    item(id(3), 'message', 'hello there', 3),
    item(id(4), 'message', 'x'.repeat(300), 4),
    item(id(5), 'message', 'second', 5),
    item(id(6), 'message', 'third', 6),
    item(id(7), 'pinned', 'bank cut-off is noon', 7),
  ];

  it('is deterministic: same items in any order give the same page', async () => {
    const a = await s.summarise('case', items);
    expect(await s.summarise('case', [...items].reverse())).toBe(a);
    const order = [3, 0, 6, 1, 5, 2, 4].map((i) => items[i]!);
    expect(await s.summarise('case', order)).toBe(a);
  });

  it('header first; every fact line cites its item; caps hold', async () => {
    const lines = (await s.summarise('case', items)).split('\n');
    expect(lines[0]).toBe(PAGE_HEADER);
    for (const l of lines.slice(1)) expect(l).toMatch(/^\[item:[0-9a-f]{8}\] /);
    expect(lines[1]).toBe(
      `${id8(1)} Last stage change: Stage changed from new to docs`
    );
    expect(lines).toContain(
      `${id8(2)} Open task mentioned: follow up on salary letter`
    );
    const msgs = lines.filter((l) => l.includes(' Message: '));
    expect(msgs.map((l) => l.slice(0, 15))).toEqual([id8(6), id8(5), id8(4)]);
    for (const m of msgs)
      expect(m.length - `${id8(1)} Message: `.length).toBeLessThanOrEqual(120);
    expect(lines.some((l) => l.includes('Pinned'))).toBe(false);
    expect((await s.summarise('bank', items)).split('\n')).toContain(
      `${id8(7)} Pinned: bank cut-off is noon`
    );
    expect(await s.summarise('contact', [])).toBe(
      `${PAGE_HEADER}\nNo facts extracted yet.`
    );
  });

  it('digit guard: redacted sources and digit id prefixes never yield a 9+ digit run', async () => {
    const red = brainRedact(
      'call me on +971 50 123 4567 about account 123456789012'
    );
    expect(red.ok).toBe(true);
    const text = red.ok ? red.text : '';
    const page = await s.summarise('case', [
      item(id(12345678), 'message', text, 1),
      item(id(87654321), 'note', `todo ${text}`, 2),
    ]);
    expect(page).toContain(id8(12345678));
    expect(page).not.toMatch(DIGIT_GUARD);
  });
});

type Reply = { data: unknown; error: unknown };
function fakeClient(replies: Record<string, Reply> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return replies[fn] ?? { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const A = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';

describe('SupabaseBrainPageStore', () => {
  it('calls each brain_page_* function with its exact parameters', async () => {
    const { client, calls } = fakeClient({
      brain_page_mark_dirty: { data: 3, error: null },
      brain_page_dirty_list: {
        data: [
          { kind: 'case', key: 'c1', version: 2 },
          { kind: 'nope', key: 'x', version: 1 },
        ],
        error: null,
      },
      brain_page_dirty_count: { data: 7, error: null },
      brain_page_version: { data: 4, error: null },
      brain_page_sources: {
        data: [
          {
            item_id: id(1),
            text: 't',
            created_at: '2026-01-01T00:00:00Z',
            source_kind: 'note',
          },
        ],
        error: null,
      },
      brain_page_put: { data: 5, error: null },
      brain_page_forget: { data: 2, error: null },
    });
    const s = new SupabaseBrainPageStore(client);
    expect(await s.markDirty(A, [id(1)])).toBe(3);
    expect(await s.dirty(A, 20)).toEqual([
      { kind: 'case', key: 'c1', version: 2 },
    ]);
    expect(await s.remaining(A)).toBe(7);
    expect(await s.version(A, 'bank', 'ADCB')).toBe(4);
    expect(await s.sources(A, 'case', 'c1', 200)).toEqual([
      {
        id: id(1),
        text: 't',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        sourceKind: 'note',
      },
    ]);
    expect(await s.put(A, 'case', 'c1', 4, 'sum', [id(1)])).toBe(5);
    expect(await s.forget({ actorId: U }, A, 'k1', 'opt_out')).toBe(2);
    expect(calls).toEqual([
      {
        fn: 'brain_page_mark_dirty',
        args: { p_account: A, p_item_ids: [id(1)] },
      },
      { fn: 'brain_page_dirty_list', args: { p_account: A, p_limit: 20 } },
      { fn: 'brain_page_dirty_count', args: { p_account: A } },
      {
        fn: 'brain_page_version',
        args: { p_account: A, p_kind: 'bank', p_key: 'ADCB' },
      },
      {
        fn: 'brain_page_sources',
        args: { p_account: A, p_kind: 'case', p_key: 'c1', p_limit: 200 },
      },
      {
        fn: 'brain_page_put',
        args: {
          p_account: A,
          p_kind: 'case',
          p_key: 'c1',
          p_expected_version: 4,
          p_summary: 'sum',
          p_item_ids: [id(1)],
        },
      },
      {
        fn: 'brain_page_forget',
        args: {
          p_actor: U,
          p_system_label: null,
          p_account: A,
          p_contact: 'k1',
          p_reason: 'opt_out',
        },
      },
    ]);
  });

  it('read: no row is null; citations are only the cited sources', async () => {
    const summary = `${PAGE_HEADER}\n${id8(1)} Message: hi\n${id8(1)} again\n[item:deadbeef] unknown`;
    const { client, calls } = fakeClient({
      brain_page_read: {
        data: [
          {
            summary,
            version: 3,
            built_at: '2026-11-01T00:00:00Z',
            sources: [
              { id: id(1), kind: 'message' },
              { id: id(2), kind: 'note' },
            ],
          },
        ],
        error: null,
      },
    });
    const page = await new SupabaseBrainPageStore(client).read(
      U,
      A,
      'case',
      'c1'
    );
    expect(calls[0]).toEqual({
      fn: 'brain_page_read',
      args: { p_actor: U, p_account: A, p_kind: 'case', p_key: 'c1' },
    });
    expect(page).toEqual({
      summary,
      version: 3,
      builtAt: new Date('2026-11-01T00:00:00Z'),
      citations: [{ kind: 'message', id: id(1) }],
    });
    const empty = fakeClient({ brain_page_read: { data: [], error: null } });
    expect(
      await new SupabaseBrainPageStore(empty.client).read(U, A, 'case', 'c1')
    ).toBeNull();
  });

  it('a CONFLICT hint becomes BrainError reason CONFLICT', async () => {
    const { client } = fakeClient({
      brain_page_put: {
        data: null,
        error: { code: 'P0001', hint: 'CONFLICT', message: 'stale' },
      },
    });
    await expect(
      new SupabaseBrainPageStore(client).put(A, 'case', 'c1', 1, 's', [])
    ).rejects.toMatchObject({ name: 'BrainError', reason: 'CONFLICT' });
  });
});

function memStore(putErrors: unknown[]): BrainPageStore & {
  puts: number[];
} {
  const puts: number[] = [];
  return {
    puts,
    markDirty: async () => 0,
    dirty: async () => [
      { kind: 'case', key: 'c1', version: 1 },
      { kind: 'contact', key: 'k1', version: 1 },
    ],
    remaining: async () => 0,
    version: async () => 9,
    sources: async () => [item(id(1), 'message', 'hi', 1)],
    put: async (_a, _k, _key, v) => {
      puts.push(v);
      const e = putErrors.shift();
      if (e) throw e;
      return v + 1;
    },
    read: async () => null,
    forget: async () => 0,
  };
}

describe('rebuildDirtyPages', () => {
  const summariser = new ExtractiveSummariser();
  const conflict = new BrainError('brain_page_put', 'CONFLICT', 'P0001');

  it('retries once with the fresh version on CONFLICT', async () => {
    const store = memStore([conflict]);
    const r = await rebuildDirtyPages({
      store,
      summariser,
      accountId: A,
      limit: 20,
    });
    expect(r).toEqual({ rebuilt: 2, failed: 0, remaining: 0 });
    expect(store.puts).toEqual([1, 9, 1]);
  });

  it('a second CONFLICT or another error is counted, never thrown', async () => {
    const store = memStore([conflict, conflict, new Error('boom')]);
    const r = await rebuildDirtyPages({
      store,
      summariser,
      accountId: A,
      limit: 20,
    });
    expect(r).toEqual({ rebuilt: 0, failed: 2, remaining: 0 });
  });
});
