import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  waiting: 0,
  teardown: vi.fn(),
  deleted: 0,
}));

vi.mock('./waiting-messages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  waitingMessages: async () => h.waiting,
}));
vi.mock('./personal-numbers', () => ({
  personalNumbersAdmin: () => ({}),
  promoteOldestToPrimary: async () => {},
}));
vi.mock('./openwa-cleanup', () => ({ teardownOpenWASession: h.teardown }));

import { disconnectOpenWANumber } from './openwa-number';

const row = { id: 'cfg-1', phone_number_id: 'sess-1' };

function db() {
  const b: Record<string, unknown> = {};
  b.delete = () => {
    h.deleted++;
    return b;
  };
  b.eq = () => b;
  b.then = (r: (v: unknown) => unknown) => r({ error: null });
  return { from: () => b } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.stubEnv('OPENWA_API_KEY', 'admin-key');
  h.waiting = 2;
  h.deleted = 0;
  h.teardown.mockReset();
  h.teardown.mockResolvedValue(true);
});

describe('disconnectOpenWANumber — waiting customer messages', () => {
  it('answers 409 before the gateway or the row is touched', async () => {
    const res = await disconnectOpenWANumber(db(), 'acc', row, {
      force: false,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'messages_waiting',
      count: 2,
    });
    expect(h.teardown).not.toHaveBeenCalled();
    expect(h.deleted).toBe(0);
  });

  it('removes the number when forced', async () => {
    const res = await disconnectOpenWANumber(db(), 'acc', row, {
      force: true,
    });
    expect(res.status).toBe(200);
    expect(h.teardown).toHaveBeenCalled();
    expect(h.deleted).toBe(1);
  });
});
