import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMyOpenTasks } from './sources';

function answer(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchMyOpenTasks', () => {
  it("carries the route's truncated flag, so a cut list is not read as exact", async () => {
    answer({ tasks: [{ id: 't1' }], truncated: true });
    expect(await fetchMyOpenTasks()).toEqual({
      tasks: [{ id: 't1' }],
      truncated: true,
    });
  });

  it('is not truncated when the route says nothing', async () => {
    answer({ tasks: [] });
    expect(await fetchMyOpenTasks()).toEqual({ tasks: [], truncated: false });
  });
});
