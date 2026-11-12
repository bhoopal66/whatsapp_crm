import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: vi.fn(),
}));

import { supabaseAdmin } from '@/lib/submission-groups/server';

import {
  BestEffortBrainSink,
  brainSinkCounters,
  recordGroupCustomerText,
  type SinkEvent,
} from './sink';
import { MemPorts, memDeps } from './test-fakes';

function fakes(opts: { marked?: string[]; enabled?: boolean } = {}) {
  const m = new MemPorts();
  const enabled = vi.fn(async () => opts.enabled ?? true);
  const sink = new BestEffortBrainSink({
    ...memDeps(m),
    enabled,
    marked: async (_a, c) => (opts.marked ?? []).includes(c),
  });
  return { sink, m, enabled };
}
const ref = { accountId: 'a1', caseId: null, contactId: 'c1', createdBy: 'u1' };
const msg = (text: string, contactId = 'c1'): SinkEvent => ({
  kind: 'message',
  ref: { ...ref, contactId },
  messageId: 'm1',
  text,
});

beforeEach(() => {
  brainSinkCounters.brain_ingest_failures = 0;
  brainSinkCounters.brain_ingest_skipped_marked = 0;
  brainSinkCounters.brain_page_dirty_failures = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('022b BrainSink', () => {
  it('stores a note while the switch is on', async () => {
    const { sink, m } = fakes();
    await sink.record({
      kind: 'note',
      ref,
      noteId: 'n1',
      body: 'call the bank',
    });
    expect(m.items.map((i) => [i.sourceKind, i.sourceId])).toEqual([
      ['note', 'n1'],
    ]);
  });

  it('does nothing while the switch is off: no store call', async () => {
    const { sink, m, enabled } = fakes({ enabled: false });
    const upsert = vi.spyOn(m, 'upsert');
    await sink.record({ kind: 'note', ref, noteId: 'n1', body: 'hello' });
    expect(enabled).toHaveBeenCalledWith('a1');
    expect(upsert).not.toHaveBeenCalled();
    expect(m.vecs.size).toBe(0);
  });

  it('a failing store is counted and logged without the text, not thrown', async () => {
    const { sink, m } = fakes();
    m.upsert = async () => {
      throw new Error('pg down');
    };
    await expect(
      sink.record({ kind: 'note', ref, noteId: 'n1', body: 'secret words' })
    ).resolves.toBeUndefined();
    expect(brainSinkCounters.brain_ingest_failures).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[brain-sink]',
      'note',
      'pg down'
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      'secret words'
    );
  });

  it('a failing switch read is counted, not thrown', async () => {
    const m = new MemPorts();
    const sink = new BestEffortBrainSink({
      ...memDeps(m),
      enabled: async () => {
        throw new Error('settings down');
      },
      marked: async () => false,
    });
    await expect(sink.record(msg('hi'))).resolves.toBeUndefined();
    expect(brainSinkCounters.brain_ingest_failures).toBe(1);
  });

  it('does not ingest a message of an opted-out / deletion-marked contact', async () => {
    const { sink, m } = fakes({ marked: ['c-opted'] });
    await sink.record(msg('please call me tomorrow about the loan', 'c-opted'));
    await sink.record(msg('please call me tomorrow about the loan', 'c1'));
    expect(m.items.map((u) => u.contactId)).toEqual(['c1']);
    expect(brainSinkCounters.brain_ingest_skipped_marked).toBe(1);
    expect(brainSinkCounters.brain_ingest_failures).toBe(0);
  });

  it('a chunk the store refuses (NULL) is neither a failure nor counted as marked', async () => {
    const { sink, m } = fakes();
    m.refuse = () => true;
    await sink.record({ kind: 'note', ref, noteId: 'n1', body: 'hello' });
    await sink.record(msg('hello'));
    expect(m.items).toEqual([]);
    expect(brainSinkCounters.brain_ingest_failures).toBe(0);
    expect(brainSinkCounters.brain_ingest_skipped_marked).toBe(0);
  });

  it('redacts text before it reaches the store', async () => {
    const { sink, m } = fakes();
    await sink.record(msg('my account number is 1234567890123 thanks'));
    expect(m.items).toHaveLength(1);
    expect(m.items[0]!.text).not.toContain('1234567890123');
  });

  it('carries the system writer of inbound customer text', async () => {
    const { sink, m } = fakes();
    await sink.record({
      kind: 'message',
      ref: {
        accountId: 'a1',
        caseId: 'k1',
        contactId: 'c1',
        createdBy: null,
        systemLabel: 'system:inbound',
      },
      messageId: 'w1',
      text: 'I sent the salary letter',
    });
    expect(m.items[0]).toMatchObject({
      caseId: 'k1',
      createdBy: null,
      systemLabel: 'system:inbound',
    });
  });
});

describe('recordGroupCustomerText', () => {
  const msgArgs = {
    accountId: 'a1',
    groupId: 'g1',
    waMessageId: 'wa-1',
    body: 'hello',
  };
  function fakeDb(o: {
    enabled?: boolean;
    row?: unknown;
    lookupThrows?: boolean;
  }) {
    const tables: string[] = [];
    const db = {
      from: (table: string) => {
        tables.push(table);
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            if (table === 'cases' && o.lookupThrows) throw new Error('boom');
            return table === 'cases'
              ? { data: o.row ?? null, error: null }
              : { data: { brain_enabled: o.enabled ?? true }, error: null };
          },
        };
        return chain;
      },
    };
    vi.mocked(supabaseAdmin).mockReturnValue(db as never);
    return tables;
  }
  const record = () => vi.spyOn(BestEffortBrainSink.prototype, 'record');

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('switch off: no cases query and no record', async () => {
    const tables = fakeDb({ enabled: false, row: { id: 'k1' } });
    const rec = record().mockResolvedValue();
    await recordGroupCustomerText(msgArgs);
    expect(tables).not.toContain('cases');
    expect(rec).not.toHaveBeenCalled();
  });

  it('switch on with a case: records as system:inbound with null author', async () => {
    fakeDb({
      row: { id: 'k1', contact_id: 'c9', bank_code: 'ADCB' },
    });
    const rec = record().mockResolvedValue();
    await recordGroupCustomerText(msgArgs);
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledWith({
      kind: 'message',
      ref: {
        accountId: 'a1',
        caseId: 'k1',
        contactId: 'c9',
        bankCode: 'ADCB',
        createdBy: null,
        systemLabel: 'system:inbound',
      },
      messageId: 'wa-1',
      text: 'hello',
    });
  });

  it('a group without a case records nothing', async () => {
    fakeDb({ row: null });
    const rec = record().mockResolvedValue();
    await recordGroupCustomerText(msgArgs);
    expect(rec).not.toHaveBeenCalled();
  });

  it('a throwing lookup resolves and counts one failure', async () => {
    fakeDb({ lookupThrows: true });
    const rec = record().mockResolvedValue();
    await expect(recordGroupCustomerText(msgArgs)).resolves.toBeUndefined();
    expect(rec).not.toHaveBeenCalled();
    expect(brainSinkCounters.brain_ingest_failures).toBe(1);
  });
});

describe('022c BrainSink page dirty marks', () => {
  // The block above spies on BestEffortBrainSink.prototype.record.
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  const note: SinkEvent = {
    kind: 'note',
    ref,
    noteId: 'n1',
    body: 'call the bank',
  };
  const withPages = (
    markDirty: (a: string, ids: readonly string[]) => Promise<number>
  ) => {
    const m = new MemPorts();
    const sink = new BestEffortBrainSink({
      ...memDeps(m),
      enabled: async () => true,
      marked: async () => false,
      pages: { markDirty },
    });
    return { sink, m };
  };

  it('marks the stored item ids dirty in the event account', async () => {
    const markDirty = vi.fn(async () => 1);
    const { sink, m } = withPages(markDirty);
    await sink.record(note);
    expect(m.items.length).toBe(1);
    expect(markDirty).toHaveBeenCalledWith('a1', [m.items[0].id]);
    expect(brainSinkCounters.brain_page_dirty_failures).toBe(0);
  });

  it('a rejecting markDirty leaves record() resolved and is counted apart', async () => {
    const { sink } = withPages(async () => {
      throw new Error('pages down');
    });
    await expect(sink.record(note)).resolves.toBeUndefined();
    expect(brainSinkCounters.brain_page_dirty_failures).toBe(1);
    expect(brainSinkCounters.brain_ingest_failures).toBe(0);
  });

  it('no dirty mark when nothing was stored (opted-out contact)', async () => {
    const markDirty = vi.fn(async () => 1);
    const m = new MemPorts();
    const sink = new BestEffortBrainSink({
      ...memDeps(m),
      enabled: async () => true,
      marked: async () => true,
      pages: { markDirty },
    });
    await sink.record(msg('hello there'));
    expect(markDirty).not.toHaveBeenCalled();
  });
});
