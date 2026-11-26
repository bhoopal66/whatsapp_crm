import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const disconnect = vi.hoisted(() => vi.fn());
vi.mock('./openwa-number', () => ({ disconnectOpenWANumber: disconnect }));

const waiting = vi.hoisted(() => ({ count: 0 }));
vi.mock('./waiting-messages', () => ({
  waitingMessages: async () => waiting.count,
}));

import { disconnectPersonalNumbersOf } from './personal-offboarding';

function fakeDb(rows: Array<{ id: string; phone_number_id: string }>) {
  const filters: unknown[][] = [];
  const updates: unknown[] = [];
  const b: Record<string, unknown> = {
    select: () => b,
    update: (patch: unknown) => (updates.push(patch), b),
    eq: (...args: unknown[]) => (filters.push(args), b),
    then: (done: (v: unknown) => unknown) => done({ data: rows, error: null }),
  };
  return {
    db: { from: () => b } as unknown as SupabaseClient,
    filters,
    updates,
  };
}

const ROW = { id: 'cfg-9', phone_number_id: 'sess-9' };
const answer = (gatewayCleanup: string) =>
  Response.json({ ok: true, gatewayCleanup });

beforeEach(() => {
  disconnect.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('disconnectPersonalNumbersOf', () => {
  it('disconnects only the personal numbers of that person in that account', async () => {
    const f = fakeDb([ROW]);
    disconnect.mockResolvedValue(answer('complete'));
    expect(await disconnectPersonalNumbersOf(f.db, 'acc', 'user')).toBe(true);
    expect(disconnect).toHaveBeenCalledWith(f.db, 'acc', ROW, {
      force: true,
    });
    expect(f.filters).toEqual([
      ['account_id', 'acc'],
      ['user_id', 'user'],
      ['provider', 'openwa'],
      ['is_personal', true],
    ]);
    expect(f.updates).toEqual([]);
  });

  it('says so when the gateway could not be cleaned up', async () => {
    const f = fakeDb([ROW]);
    disconnect.mockResolvedValue(answer('incomplete'));
    expect(await disconnectPersonalNumbersOf(f.db, 'acc', 'user')).toBe(false);
    expect(f.updates).toEqual([]);
  });

  it.each([
    [
      'cannot be deleted',
      () => Promise.resolve(new Response('', { status: 500 })),
    ],
    ['throws', () => Promise.reject(new Error('+971500000001'))],
  ])(
    'marks the row when the disconnect %s, and never throws',
    async (_n, go) => {
      const f = fakeDb([ROW]);
      disconnect.mockImplementation(go);
      expect(await disconnectPersonalNumbersOf(f.db, 'acc', 'user')).toBe(
        false
      );
      expect(f.updates).toEqual([
        { status: 'disconnected', verify_token: null },
      ]);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        '9715'
      );
    }
  );
});

describe('disconnectPersonalNumbersOf — waiting customer messages', () => {
  it('still disconnects at once, only logging the count', async () => {
    waiting.count = 5;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeDb([ROW]);
    disconnect.mockResolvedValue(answer('complete'));
    expect(await disconnectPersonalNumbersOf(f.db, 'acc', 'user')).toBe(true);
    waiting.count = 0;
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('5 customer'));
  });
});
