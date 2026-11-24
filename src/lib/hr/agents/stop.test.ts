import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown> | null;
type Err = { code: string } | null;

const h = vi.hoisted(() => ({
  hrChat: null as Record<string, unknown> | null,
  hrLine: null as Record<string, unknown> | null,
  contact: { opted_out_at: null } as Record<string, unknown> | null,
  /** Errors to answer reads of a table with, first to last. */
  errors: {} as Record<string, { code: string }[]>,
  reads: [] as { table: string; filters: Record<string, unknown> }[],
  rpcs: [] as { fn: string; args: unknown }[],
  rpcError: null as { code: string } | null,
  optOut: vi.fn(),
}));

vi.mock('@/lib/ai/opt-out', () => ({
  markOptedOut: (...a: unknown[]) => h.optOut(...a),
}));

import { recordHrStop } from './stop';

const db = {
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, v: unknown) => {
      filters[col] = v;
      return q;
    };
    q.maybeSingle = async (): Promise<{ data: Row; error: Err }> => {
      h.reads.push({ table, filters });
      const error = h.errors[table]?.shift() ?? null;
      if (error) return { data: null, error };
      // `hr_lines` itself: no role has SELECT on it (213).
      if (table === 'hr_lines') return { data: null, error: { code: '42501' } };
      const data = table === 'hr_conversations' ? h.hrChat : h.contact;
      return { data, error: null };
    };
    return q;
  },
  rpc: async (fn: string, args: unknown) => {
    if (fn === 'hr_is_line') {
      h.reads.push({ table: fn, filters: args as Record<string, unknown> });
      const error = h.errors[fn]?.shift() ?? null;
      return { data: error ? null : h.hrLine !== null, error };
    }
    h.rpcs.push({ fn, args });
    return { data: 0, error: h.rpcError };
  },
} as unknown as SupabaseClient;

const run = (text: string, extra: { retry?: boolean } = {}) =>
  recordHrStop(db, {
    accountId: 'acct-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    channelId: 'ch-1',
    text,
    ...extra,
  });

const tables = () => h.reads.map((r) => r.table);
const SUPERSEDE = {
  fn: 'hr_agent_supersede',
  args: { p_account_id: 'acct-1', p_contact_id: 'contact-1' },
};
let err: ReturnType<typeof vi.spyOn>;
const logged = () =>
  err.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

beforeEach(() => {
  h.hrChat = { conversation_id: 'conv-1' };
  h.hrLine = null;
  h.contact = { opted_out_at: null };
  h.errors = {};
  h.reads = [];
  h.rpcs = [];
  h.rpcError = null;
  h.optOut.mockReset().mockResolvedValue(true);
  vi.restoreAllMocks();
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordHrStop', () => {
  it('another text reads and writes nothing', async () => {
    expect(await run('I sent my CV')).toBe(true);
    expect(h.reads).toEqual([]);
    expect(h.optOut).not.toHaveBeenCalled();
    expect(h.rpcs).toEqual([]);
  });

  it('a STOP in a chat outside HR, on a number that is no HR line: nothing', async () => {
    h.hrChat = null;
    expect(await run('STOP')).toBe(true);
    expect(h.reads).toEqual([
      {
        table: 'hr_conversations',
        filters: { conversation_id: 'conv-1', account_id: 'acct-1' },
      },
      { table: 'hr_is_line', filters: { p_channel: 'ch-1' } },
    ]);
    expect(h.optOut).not.toHaveBeenCalled();
    expect(h.rpcs).toEqual([]);
  });

  it('stamps on an HR chat whatever the switches say, reading none of them', async () => {
    expect(await run('STOP')).toBe(true);
    expect(tables()).toEqual(['hr_conversations']);
    expect(h.optOut).toHaveBeenCalledWith(db, {
      accountId: 'acct-1',
      contactId: 'contact-1',
    });
    expect(h.rpcs).toEqual([SUPERSEDE]);
  });

  it('stamps on an HR line before the chat has an HR row', async () => {
    h.hrChat = null;
    h.hrLine = { channel_id: 'ch-1' };
    expect(await run('إلغاء')).toBe(true);
    expect(h.optOut).toHaveBeenCalledTimes(1);
  });

  it('a contact already stamped, or gone, is done in one try', async () => {
    h.optOut.mockResolvedValue(false);
    h.contact = { opted_out_at: '2026-11-01T00:00:00Z' };
    expect(await run('STOP')).toBe(true);
    h.contact = null;
    expect(await run('STOP')).toBe(true);
    expect(h.optOut).toHaveBeenCalledTimes(2);
    expect(err).not.toHaveBeenCalled();
  });

  it.each(['hr_conversations', 'hr_is_line', 'contacts'])(
    'a failed read of %s is tried again',
    async (table) => {
      if (table === 'hr_is_line') {
        h.hrChat = null;
        h.hrLine = { channel_id: 'ch-1' };
      }
      if (table === 'contacts') h.optOut.mockResolvedValueOnce(false);
      h.errors[table] = [{ code: '57014' }];
      expect(await run('STOP')).toBe(true);
      expect(h.optOut).toHaveBeenLastCalledWith(db, expect.anything());
      expect(logged()).not.toContain('OPT-OUT NOT RECORDED');
    }
  );

  it('answers false after three failed stamps, and says so', async () => {
    h.optOut.mockResolvedValue(false);
    expect(await run('STOP')).toBe(false);
    expect(h.optOut).toHaveBeenCalledTimes(3);
    expect(logged()).toContain('OPT-OUT NOT RECORDED for contact contact-1');
    expect(h.rpcs).toEqual([SUPERSEDE]);
  });

  it('answers false while nobody can tell whether the chat is an HR one', async () => {
    h.errors.hr_conversations = Array(3).fill({ code: '57014' });
    expect(await run('STOP')).toBe(false);
    expect(h.optOut).not.toHaveBeenCalled();
  });

  it('a retry repeats the stamp only', async () => {
    expect(await run('STOP', { retry: true })).toBe(true);
    expect(h.optOut).toHaveBeenCalledTimes(1);
    expect(h.rpcs).toEqual([]);
  });

  it('an install without the HR tables owes nothing', async () => {
    h.errors.hr_conversations = [{ code: 'PGRST205' }];
    h.errors.hr_is_line = [{ code: 'PGRST202' }];
    expect(await run('STOP')).toBe(true);
    expect(h.optOut).not.toHaveBeenCalled();
  });

  it('a failed supersede is logged; the STOP is recorded all the same', async () => {
    h.rpcError = { code: '57014' };
    expect(await run('STOP')).toBe(true);
    expect(logged()).toContain('supersede after a STOP failed');
  });
});
