import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { runResponseEscalationSweep } from './sweep';

function client(result: unknown): SupabaseClient {
  return {
    rpc: vi.fn(async () => result),
  } as unknown as SupabaseClient;
}

describe('runResponseEscalationSweep', () => {
  it('returns the summary', async () => {
    const db = client({
      data: { accounts: 2, failed: 0, chats: 3, notifications: 4, trimmed: 0 },
      error: null,
    });
    expect(await runResponseEscalationSweep(db)).toEqual({
      accounts: 2,
      failed: 0,
      chats: 3,
      notifications: 4,
    });
    expect(db.rpc).toHaveBeenCalledWith('response_escalation_sweep');
  });

  it('reads a malformed answer as zeros', async () => {
    expect(
      await runResponseEscalationSweep(client({ data: 3, error: null }))
    ).toEqual({ accounts: 0, failed: 0, chats: 0, notifications: 0 });
  });

  it('answers null, warning once, before migration 237', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = client({
      data: null,
      error: { code: 'PGRST202', message: 'missing' },
    });
    expect(await runResponseEscalationSweep(db)).toBeNull();
    expect(await runResponseEscalationSweep(db)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('answers null on an error and never throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await runResponseEscalationSweep(
        client({ data: null, error: { code: 'XX000', message: 'boom' } })
      )
    ).toBeNull();
    const throwing = {
      rpc: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    } as unknown as SupabaseClient;
    expect(await runResponseEscalationSweep(throwing)).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
