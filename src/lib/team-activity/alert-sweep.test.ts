import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { runTeamActivityAlertSweep } from './alert-sweep';

function client(result: unknown): SupabaseClient {
  return {
    rpc: vi.fn(async () => result),
  } as unknown as SupabaseClient;
}

describe('runTeamActivityAlertSweep', () => {
  it('returns the summary', async () => {
    const db = client({ data: { alerts: 2, notifications: 5 }, error: null });
    expect(await runTeamActivityAlertSweep(db)).toEqual({
      alerts: 2,
      notifications: 5,
    });
    expect(db.rpc).toHaveBeenCalledWith('team_activity_alert_sweep');
  });

  it('answers null, quietly, before migration 068', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = client({
      data: null,
      error: { code: 'PGRST202', message: 'missing' },
    });
    expect(await runTeamActivityAlertSweep(db)).toBeNull();
    expect(await runTeamActivityAlertSweep(db)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      rpc: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    } as unknown as SupabaseClient;
    expect(await runTeamActivityAlertSweep(db)).toBeNull();
    expect(
      await runTeamActivityAlertSweep(
        client({ data: null, error: { code: 'XX000', message: 'boom' } })
      )
    ).toBeNull();
    error.mockRestore();
  });
});
