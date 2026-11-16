import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

import { runHrSweep } from './sweep';

beforeEach(() => {
  h.rpc.mockReset();
});

describe('runHrSweep', () => {
  it('calls hr_sweep with the given time and returns its counts', async () => {
    h.rpc.mockResolvedValue({ data: { created: 2, skipped: 5 }, error: null });
    const now = new Date('2026-11-16T08:00:00Z');
    await expect(runHrSweep(now)).resolves.toEqual({ created: 2, skipped: 5 });
    expect(h.rpc).toHaveBeenCalledWith('hr_sweep', {
      p_now: '2026-11-16T08:00:00.000Z',
    });
  });

  it('answers null and logs once on an RPC error', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'denied' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runHrSweep()).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('never throws when the request itself fails', async () => {
    h.rpc.mockRejectedValue(new Error('network'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runHrSweep()).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
