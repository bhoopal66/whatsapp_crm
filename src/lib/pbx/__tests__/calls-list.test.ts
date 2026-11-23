import { describe, expect, it, vi } from 'vitest';

import { loadCallsList } from '../calls-list';

const NOW = Date.parse('2026-11-23T10:00:00Z');
const SINCE = encodeURIComponent('2026-11-16T10:00:00.000Z');

/** Answers by path; a missing one fails, as a refused fetch does. */
const answers = (byPath: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    if (!(path in byPath)) throw new Error('500');
    return byPath[path];
  });

describe('loadCallsList', () => {
  it('reads only the missed-call tasks of the calls’ own window', async () => {
    const getJson = answers({
      '/api/pbx/calls': { calls: [{ id: 'c1' }] },
      '/api/tasks': { tasks: [{ id: 't1' }], truncated: false },
    });
    const list = await loadCallsList('missed', true, NOW, getJson);
    expect(getJson.mock.calls.map(([u]) => u)).toEqual([
      `/api/pbx/calls?scope=missed&limit=200&from=${SINCE}`,
      `/api/tasks?scope=all&status=all&kind=missed_call&updatedSince=${SINCE}&limit=200`,
    ]);
    expect(list).toEqual({
      calls: [{ id: 'c1' }],
      tasks: [{ id: 't1' }],
      tasksTruncated: false,
      numbers: [],
    });
  });

  it('says when there were more tasks than it read', async () => {
    const list = await loadCallsList(
      'missed',
      false,
      NOW,
      answers({
        '/api/pbx/calls': { calls: [] },
        '/api/tasks': { tasks: [], truncated: true },
      })
    );
    expect(list?.tasksTruncated).toBe(true);
  });

  it('fails, rather than list calls without badges, when the tasks fail', async () => {
    await expect(
      loadCallsList(
        'missed',
        false,
        NOW,
        answers({ '/api/pbx/calls': { calls: [{ id: 'c1' }] } })
      )
    ).rejects.toThrow('500');
  });

  it('reads no tasks for a tab without badges, and nothing for a tab that loads its own', async () => {
    const getJson = answers({ '/api/pbx/calls': { calls: [], numbers: [] } });
    expect((await loadCallsList('mine', false, NOW, getJson))?.tasks).toEqual(
      []
    );
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(await loadCallsList('keypad', false, NOW, getJson)).toBeNull();
    expect(getJson).toHaveBeenCalledTimes(1);
  });
});
