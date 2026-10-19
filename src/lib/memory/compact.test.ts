// Ported from wacrm module 019b (CRM memory), reference package 2026-10-18 (test/019b/compact.test.ts). The reference
// ran against a real Postgres; here the store runs on a fake supabase-js client (as in store.test.ts), so this file
// pins what compactScope sends and how it reads the answers. Selection (live, not summary, untrusted only, age,
// order, ACL) and the one-transaction apply (supersede, dedupe, 40001 rollback, audit) are migration 129's and
// supabase/ci/verify-crm-memory.sql's.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryStore,
  MemoryStoreError,
  contentHash,
  type CompactOptions,
  type MemoryScope,
  type Summariser,
} from './store';

type Args = Record<string, unknown>;
type Answer = { data?: unknown; error?: { message: string; code?: string } };

/** memory_compact_candidates returns `rows`; memory_compact_apply answers `apply`. Every call is logged. */
class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  constructor(
    readonly rows: Record<string, unknown>[],
    readonly apply: Answer = {}
  ) {}
  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    // Only the filtered candidates function is a valid source: anything else answers unfiltered rows (a verified one).
    const a: Answer =
      fn === 'memory_compact_candidates'
        ? { data: this.rows }
        : fn === 'memory_compact_apply'
          ? this.apply
          : { data: [...this.rows, VERIFIED_ROW] };
    return { data: a.data ?? null, error: a.error ?? null };
  }
  of(fn: string): Args[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const SUMMARY = '99999999-9999-4999-8999-999999999999';
const SCOPE: MemoryScope = {
  type: 'case',
  id: '44444444-4444-4444-8444-444444444444',
};
const VERIFIED_ROW = {
  id: 'verified-1',
  kind: 'fact',
  content: 'verified fact',
  trust: 'verified',
  created_at: '2026-01-01T00:00:00.000Z',
};

/** n stored (already redacted) candidate rows, oldest first. */
const seed = (n: number, prefix = 'old note') =>
  Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    kind: 'fact',
    content: `${prefix} ${i} [PHONE:567]`,
    created_at: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(),
  }));
const applied = (over: Partial<Record<string, unknown>> = {}): Answer => ({
  data: [{ summary_id: SUMMARY, deduped: false, superseded: 10, ...over }],
});
const fixed = (text: string) => vi.fn(async () => text);
function run(
  db: FakeDb,
  summariser: Summariser,
  extra: Partial<CompactOptions> = {}
) {
  return new MemoryStore(db.client).compactScope(ACCOUNT, SCOPE, {
    summariser,
    actor: ACTOR,
    ...extra,
  });
}

describe('MemoryStore.compactScope: success', () => {
  it('selects as the actor with the defaults, gives the summariser the stored rows oldest first, applies once', async () => {
    const rows = seed(12);
    const db = new FakeDb(rows, applied({ superseded: 12 }));
    const summariser = vi.fn<Summariser>(
      async (items) => `Summary of ${items.length} notes: fee waived`
    );
    const r = await run(db, summariser);
    expect(r).toEqual({
      ok: true,
      summaryId: SUMMARY,
      deduped: false,
      compacted: 12,
    });
    expect(db.of('memory_compact_candidates')).toEqual([
      {
        p_actor: ACTOR,
        p_account_id: ACCOUNT,
        p_scope_type: 'case',
        p_scope_id: SCOPE.id,
        p_older_than_days: 30,
        p_limit: 50,
      },
    ]);
    expect(summariser).toHaveBeenCalledTimes(1);
    expect(summariser.mock.calls[0]![0]).toEqual(
      rows.map((x) => ({
        id: x.id,
        kind: 'fact',
        content: x.content,
        createdAt: new Date(x.created_at),
      }))
    );
    expect(db.of('memory_compact_apply')).toEqual([
      {
        p_account_id: ACCOUNT,
        p_scope_type: 'case',
        p_scope_id: SCOPE.id,
        p_ids: rows.map((x) => x.id),
        p_summary: 'Summary of 12 notes: fee waived',
        p_summary_hash: contentHash('Summary of 12 notes: fee waived'),
        p_actor: ACTOR,
      },
    ]);
    expect(db.calls.map((c) => c.fn)).toEqual([
      'memory_compact_candidates',
      'memory_compact_apply',
    ]);
  });

  it('passes olderThanDays and maxBatch through', async () => {
    const db = new FakeDb(seed(3), applied({ superseded: 3 }));
    await run(db, fixed('s'), { olderThanDays: 7, maxBatch: 3, minItems: 3 });
    expect(db.of('memory_compact_candidates')[0]).toMatchObject({
      p_older_than_days: 7,
      p_limit: 3,
    });
  });

  it('a raw Emirates ID in the summary is redacted before apply; the hash is of the redacted text', async () => {
    const db = new FakeDb(seed(10), applied());
    const r = await run(
      db,
      fixed('  Customer Emirates ID 784-1990-1234567-1 agreed the fee \n')
    );
    expect(r).toMatchObject({ ok: true, compacted: 10 });
    const a = db.of('memory_compact_apply')[0]!;
    expect(a.p_summary).toBe('Customer Emirates ID [EID] agreed the fee');
    expect(a.p_summary_hash).toBe(contentHash(String(a.p_summary)));
    expect(JSON.stringify(db.calls)).not.toMatch(/784-?1990/);
  });

  it('a replay of the same summary hash returns the existing item with deduped: true', async () => {
    const db = new FakeDb(seed(10), applied({ deduped: true, superseded: 0 }));
    expect(await run(db, fixed('the one summary'))).toEqual({
      ok: true,
      summaryId: SUMMARY,
      deduped: true,
      compacted: 0,
    });
  });

  it('only the candidates function selects: a verified item is never sent to the summariser or apply', async () => {
    const rows = seed(10);
    const db = new FakeDb(rows, applied());
    const summariser = vi.fn<Summariser>(async () => 's');
    await run(db, summariser);
    const sent = summariser.mock.calls[0]![0].map((x) => x.id);
    expect(sent).toEqual(rows.map((x) => x.id));
    expect(sent).not.toContain(VERIFIED_ROW.id);
    expect(db.of('memory_compact_apply')[0]!.p_ids).toEqual(sent);
  });
});

describe('MemoryStore.compactScope: no-op', () => {
  it('fewer than minItems (or an actor who may not read: zero rows) calls neither the summariser nor apply', async () => {
    const summariser = fixed('never');
    const few = new FakeDb(seed(9));
    expect(await run(few, summariser)).toEqual({
      ok: true,
      summaryId: null,
      compacted: 0,
      candidates: 9,
    });
    const none = new FakeDb([]);
    expect(await run(none, summariser, { minItems: 1 })).toEqual({
      ok: true,
      summaryId: null,
      compacted: 0,
      candidates: 0,
    });
    expect(summariser).not.toHaveBeenCalled();
    expect([...few.calls, ...none.calls].map((c) => c.fn)).toEqual([
      'memory_compact_candidates',
      'memory_compact_candidates',
    ]);
  });
});

describe('MemoryStore.compactScope: a failure changes nothing', () => {
  const cases: [string, Summariser, string, Partial<CompactOptions>?][] = [
    [
      'throws',
      async () => {
        throw new Error('model down: 784-1990-1234567-1');
      },
      'THREW',
    ],
    [
      'times out',
      () => new Promise<string>(() => {}),
      'TIMEOUT',
      { timeoutMs: 20 },
    ],
    ['returns blank', async () => '  \n\t ', 'EMPTY'],
    ['returns 5000 chars', async () => 'x'.repeat(5000), 'TOO_LONG'],
    // 571 emails of 6 chars + a space = 3997 raw chars; each [EMAIL] is one longer, so 4567 after redaction.
    [
      'is over 4000 only after redaction',
      async () => 'a@b.co '.repeat(571),
      'TOO_LONG',
    ],
    [
      'returns a non-string (redaction refuses)',
      async () => 42 as unknown as string,
      'REFUSED',
    ],
  ];
  for (const [name, summariser, reason, extra] of cases) {
    it(`summariser ${name} -> { ok: false, reason: ${reason} } and no apply`, async () => {
      const db = new FakeDb(seed(10), applied());
      const r = await run(db, summariser, extra);
      expect(r).toMatchObject({ ok: false, reason });
      expect(db.of('memory_compact_apply')).toEqual([]);
      expect(JSON.stringify(r)).not.toMatch(/784|model down/);
    });
  }

  it('the raw 4000-char boundary passes (4000 is applied)', async () => {
    const db = new FakeDb(seed(10), applied());
    expect(await run(db, fixed('x'.repeat(4000)))).toMatchObject({ ok: true });
    expect(db.of('memory_compact_apply')).toHaveLength(1);
  });

  it('on timeout the summariser signal is aborted', async () => {
    let signal: AbortSignal | undefined;
    const db = new FakeDb(seed(10), applied());
    const r = await run(
      db,
      (_items, s) => {
        signal = s;
        return new Promise<string>(() => {});
      },
      { timeoutMs: 20 }
    );
    expect(r).toMatchObject({ ok: false, reason: 'TIMEOUT' });
    expect(signal?.aborted).toBe(true);
  });

  it('apply raising 40001 (a source no longer live / untrusted / in scope) is CONFLICT, not a throw', async () => {
    const db = new FakeDb(seed(10), {
      error: { message: 'memory_compact_apply: source changed', code: '40001' },
    });
    expect(await run(db, fixed('summary of ten notes'))).toMatchObject({
      ok: false,
      reason: 'CONFLICT',
    });
    expect(db.of('memory_compact_apply')).toHaveLength(1);
  });

  it('any other database error throws MemoryStoreError without its text; a malformed answer too', async () => {
    const bad = new FakeDb(seed(10), {
      error: { message: 'old note 3', code: '22023' },
    });
    const err = await run(bad, fixed('s')).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect(err).toMatchObject({
      message: 'memory: memory_compact_apply failed',
      code: '22023',
    });
    const empty = new FakeDb(seed(10), { data: [] });
    const err2 = await run(empty, fixed('s')).catch((e) => e);
    expect(err2).toMatchObject({ fn: 'memory_compact_apply', code: null });
  });
});
