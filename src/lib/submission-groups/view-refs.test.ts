import { describe, expect, it } from 'vitest';

import {
  GROUP_CONTACT_EMBED,
  matchingContactIds,
  SEARCH_CONTACT_MAX,
} from './view-refs';

/** A recording stand-in for the contacts query chain. */
function recorder(rows: unknown[]) {
  const calls: [string, ...unknown[]][] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'ilike', 'order', 'limit'])
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a]);
      return m === 'limit' ? Promise.resolve({ data: rows, error: null }) : q;
    };
  return { admin: { from: () => q } as never, calls };
}

describe('matchingContactIds', () => {
  it('counts only contacts that hold a submission group', async () => {
    const { admin, calls } = recorder([{ id: 'c1' }, { id: 'c2' }]);
    expect(await matchingContactIds(admin, 'acct', 'acme')).toEqual([
      'c1',
      'c2',
    ]);
    const select = calls.find((c) => c[0] === 'select');
    expect(String(select?.[1])).toContain(GROUP_CONTACT_EMBED);
    expect(GROUP_CONTACT_EMBED).toContain('!inner');
    expect(calls).toContainEqual(['limit', SEARCH_CONTACT_MAX]);
  });
});
