import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { searchContactsForBar } from './contact-search';

// A failed read is not "nobody": the bar says the search failed.

type Answer = { data?: unknown; error?: unknown };

const client = (rpc: Answer, contacts: Answer) => {
  const answer = Promise.resolve({
    data: contacts.data ?? null,
    error: contacts.error ?? null,
  });
  const chain = new Proxy(answer, {
    get: (t, k) =>
      k === 'then' ? answer.then.bind(answer) : k in t ? t : () => chain,
  }) as unknown;
  return {
    rpc: async () => ({ data: rpc.data ?? null, error: rpc.error ?? null }),
    from: () => chain,
  } as unknown as SupabaseClient;
};

const down = { error: { code: '57014', message: 'timeout' } };
const hit = { data: [{ contact_id: 'a', score: 1, exact: true }] };
const search = (sb: SupabaseClient) =>
  searchContactsForBar(sb, 'ali', () => true, false);

describe('searchContactsForBar', () => {
  it('lists the contacts found', async () => {
    const sb = client(hit, { data: [{ id: 'a', name: 'Ali', phone: '1' }] });
    expect(await search(sb)).toMatchObject([{ id: 'a', name: 'Ali' }]);
  });

  it('answers nobody only when nobody was found', async () => {
    expect(await search(client({ data: [] }, { data: [] }))).toEqual([]);
  });

  it('throws when the search or the contacts cannot be read', async () => {
    await expect(search(client(down, { data: [] }))).rejects.toMatchObject({
      code: '57014',
    });
    await expect(search(client(hit, down))).rejects.toMatchObject({
      code: '57014',
    });
    // The search function is missing (before 193): the plain filter fails.
    const missing = { error: { code: 'PGRST202', message: 'no function' } };
    await expect(search(client(missing, down))).rejects.toMatchObject({
      code: '57014',
    });
  });
});
