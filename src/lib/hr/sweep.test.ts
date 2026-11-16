import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

import { runHrSweep } from './sweep';

type Answer = { data: unknown; error: unknown } | Error;

/** Answer each RPC by name; an Error is thrown as a failed request. */
function answer(byName: Record<string, Answer>) {
  h.rpc.mockImplementation(async (fn: string) => {
    const a = byName[fn];
    if (a instanceof Error) throw a;
    return a;
  });
}

beforeEach(() => {
  h.rpc.mockReset();
});

describe('runHrSweep', () => {
  it('calls hr_sweep then hr_agent_expire with the given time', async () => {
    answer({
      hr_sweep: { data: { created: 2, skipped: 5 }, error: null },
      hr_agent_expire: { data: 3, error: null },
    });
    const now = new Date('2026-11-16T08:00:00Z');
    await expect(runHrSweep(now)).resolves.toEqual({
      created: 2,
      skipped: 5,
      expired: 3,
    });
    expect(h.rpc.mock.calls).toEqual([
      ['hr_sweep', { p_now: '2026-11-16T08:00:00.000Z' }],
      ['hr_agent_expire', { p_now: '2026-11-16T08:00:00.000Z' }],
    ]);
  });

  it('still expires drafts when hr_sweep fails, and logs once', async () => {
    answer({
      hr_sweep: { data: null, error: { message: 'denied' } },
      hr_agent_expire: { data: 4, error: null },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runHrSweep()).resolves.toEqual({
      created: 0,
      skipped: 0,
      expired: 4,
    });
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('keeps the sweep counts when hr_agent_expire throws', async () => {
    answer({
      hr_sweep: { data: { created: 1, skipped: 0 }, error: null },
      hr_agent_expire: new Error('network'),
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runHrSweep()).resolves.toEqual({
      created: 1,
      skipped: 0,
      expired: 0,
    });
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('answers null, never throwing, when both fail', async () => {
    answer({
      hr_sweep: new Error('network'),
      hr_agent_expire: { data: null, error: { message: 'denied' } },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runHrSweep()).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
