import { describe, expect, it, vi } from 'vitest';

import { readRecycleSettings, saveRecycleSettings } from './settings';

const ROW = {
  days: 30,
  chat_tag_ids: ['t1'],
  case_outcomes: ['Declined'],
  updated_at: 'v2',
};
const NEXT = {
  days: 45,
  chatTagIds: ['t1'],
  caseOutcomes: ['Declined' as const],
};

function fakeDb(data: unknown, error: unknown = null) {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data, error }),
  };
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  return { db: { from: () => query, rpc } as never, rpc };
}

describe('readRecycleSettings', () => {
  it('a failed read is not the defaults', async () => {
    const { db } = fakeDb(null, { message: 'offline' });
    expect(await readRecycleSettings(db, 'a1')).toBeNull();
  });

  it('no row is the defaults; a row is itself', async () => {
    expect(await readRecycleSettings(fakeDb(null).db, 'a1')).toMatchObject({
      settings: { days: 90 },
      updatedAt: null,
    });
    expect(await readRecycleSettings(fakeDb(ROW).db, 'a1')).toEqual({
      settings: { days: 30, chatTagIds: ['t1'], caseOutcomes: ['Declined'] },
      updatedAt: 'v2',
    });
  });
});

describe('saveRecycleSettings', () => {
  it.each([
    ['a colleague saved since', ROW, null, 'v1', 'conflict'],
    ['a colleague made the first save', ROW, null, null, 'conflict'],
    ['the version could not be read', null, { message: 'x' }, 'v2', 'failed'],
  ])('%s: nothing is written', async (_n, row, error, loadedAt, expected) => {
    const { db, rpc } = fakeDb(row, error);
    expect(await saveRecycleSettings(db, 'a1', NEXT, loadedAt)).toBe(expected);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('the version it was loaded from: saved', async () => {
    const { db, rpc } = fakeDb(ROW);
    expect(await saveRecycleSettings(db, 'a1', NEXT, 'v2')).toBe('saved');
    expect(rpc).toHaveBeenCalledWith('recycle_settings_set', {
      p_days: 45,
      p_chat_tag_ids: ['t1'],
      p_case_outcomes: ['Declined'],
    });
  });
});
