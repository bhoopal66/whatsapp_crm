import { describe, expect, it, vi } from 'vitest';

import { loadCallsList } from '../calls-list';

const NOW = Date.parse('2026-11-23T10:00:00Z');
const SINCE = encodeURIComponent('2026-11-16T10:00:00.000Z');

describe('loadCallsList', () => {
  it('asks for the missed calls of the last seven days, and no tasks of its own', async () => {
    const getJson = vi.fn(async (_url: string) => ({ calls: [{ id: 'c1' }] }));
    const list = await loadCallsList('missed', true, NOW, getJson);
    expect(getJson.mock.calls.map(([u]) => u)).toEqual([
      `/api/pbx/calls?scope=missed&limit=200&from=${SINCE}`,
    ]);
    expect(list).toEqual({ calls: [{ id: 'c1' }], numbers: [] });
  });

  it('reads nothing for a tab that loads its own', async () => {
    const getJson = vi.fn(async () => ({}));
    expect(await loadCallsList('keypad', false, NOW, getJson)).toBeNull();
    expect(getJson).not.toHaveBeenCalled();
  });
});
