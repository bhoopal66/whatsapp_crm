import { describe, expect, it, vi } from 'vitest';

import { runStagedMediaSweep } from './staged-media-sweep';

function admin(names: unknown, remove = vi.fn()) {
  const rpc = vi.fn().mockResolvedValue({ data: names, error: null });
  const from = vi.fn(() => ({ remove }));
  return { rpc, from, remove, client: { rpc, storage: { from } } as never };
}
const ok = async (p: string[]) => ({
  data: p.map((name) => ({ name })),
  error: null,
});

describe('runStagedMediaSweep', () => {
  it('asks for 30-day-old orphans, at most 500', async () => {
    const a = admin([]);
    await runStagedMediaSweep(a.client);
    expect(a.rpc).toHaveBeenCalledWith('chat_media_staged_orphans', {
      p_min_age: '30 days',
      p_limit: 500,
    });
  });

  it('removes names from chat-media in batches of 100', async () => {
    const names = Array.from(
      { length: 205 },
      (_, i) => `account-a/staged/${i}-f`
    );
    const a = admin(names, vi.fn(ok));
    expect(await runStagedMediaSweep(a.client)).toEqual({
      found: 205,
      deleted: 205,
      failed: [],
    });
    expect(a.from).toHaveBeenCalledWith('chat-media');
    expect(a.remove.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 5]);
  });

  it('makes no remove call for an empty list', async () => {
    const a = admin([]);
    expect(await runStagedMediaSweep(a.client)).toEqual({
      found: 0,
      deleted: 0,
      failed: [],
    });
    expect(a.remove).not.toHaveBeenCalled();
  });

  it('throws on an rpc error and removes nothing', async () => {
    const a = admin(null);
    a.rpc.mockResolvedValue({
      data: null,
      error: { message: 'permission denied' },
    });
    await expect(runStagedMediaSweep(a.client)).rejects.toThrow(
      'permission denied'
    );
    expect(a.remove).not.toHaveBeenCalled();
  });

  it('retries a failing batch once, then reports it without throwing', async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'blip' } })
      .mockImplementationOnce(ok)
      .mockResolvedValue({ data: null, error: { message: 'down' } });
    const names = Array.from({ length: 150 }, (_, i) => `p${i}`);
    const r = await runStagedMediaSweep(admin(names, remove).client);
    expect(r).toEqual({ found: 150, deleted: 100, failed: names.slice(100) });
    expect(remove).toHaveBeenCalledTimes(4);
  });

  it('reports a rejected remove as failed', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('network'));
    expect(await runStagedMediaSweep(admin(['p'], remove).client)).toEqual({
      found: 1,
      deleted: 0,
      failed: ['p'],
    });
  });

  it('ignores non-string entries', async () => {
    const a = admin(['a', 5, null, '', { x: 1 }, 'b'], vi.fn(ok));
    expect(await runStagedMediaSweep(a.client)).toMatchObject({
      found: 2,
      deleted: 2,
    });
    expect(a.remove).toHaveBeenCalledWith(['a', 'b']);
  });
});
