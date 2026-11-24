import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  UNKNOWN_FACTS,
  hiddenFacts,
  keepFacts,
  loadCallFacts,
  loadVisibleFacts,
  parseCallFacts,
  type CallFacts,
} from './call-facts';

const ROW = { name: 'Omar', company: null, phone: null, user_id: 'rm' };
const LIVE = { connectionId: 'c1', pbxCallId: 'p1', ended: false };

/** The reads by table: the rows, or 'fail'. */
function client(
  reads: Partial<Record<string, unknown[] | 'fail'>> = {}
): SupabaseClient {
  const all: Record<string, unknown[] | 'fail' | undefined> = {
    contacts: [ROW],
    deals: [{ title: 'Loan', stage: { name: 'New' } }],
    conversations: [{ id: 'cv' }],
    messages: [{ content_text: 'hi', content_type: 'text', created_at: 't' }],
    ...reads,
  };
  return {
    from: (table: string) => {
      const rows = all[table];
      const answer =
        rows === 'fail' || !rows
          ? { data: null, error: { message: 'down' } }
          : { data: rows, error: null };
      const q: Record<string, unknown> = {
        maybeSingle: async () => ({
          ...answer,
          data: answer.data?.[0] ?? null,
        }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(answer).then(ok),
      };
      for (const m of ['select', 'eq', 'is', 'order', 'limit']) q[m] = () => q;
      return q;
    },
  } as unknown as SupabaseClient;
}
const route = (status: number, body: unknown = {}) => {
  const fetch = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
afterEach(() => vi.unstubAllGlobals());

describe('loadVisibleFacts', () => {
  it('says when a read did not come through', async () => {
    expect(await loadVisibleFacts(client(), 'k')).toMatchObject({
      incomplete: false,
      deal: 'Loan · New',
      last: { text: 'hi' },
    });
    for (const table of ['deals', 'conversations', 'messages'])
      expect(
        await loadVisibleFacts(client({ [table]: 'fail' }), 'k'),
        table
      ).toMatchObject({ incomplete: true, name: 'Omar' });
    // None of them existing is not a failure.
    expect(
      await loadVisibleFacts(client({ deals: [], conversations: [] }), 'k')
    ).toMatchObject({ incomplete: false, deal: null, last: null });
  });

  it('keeps the flag through the route', async () => {
    const facts = await loadVisibleFacts(client({ deals: 'fail' }), 'k');
    expect(parseCallFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });
});

describe('loadCallFacts', () => {
  it('asks the route for a live call, and never for one that ended', async () => {
    const live = route(200, hiddenFacts({ name: 'Omar' }, 'Rania'));
    expect(await loadCallFacts(client(), 'k', LIVE)).toMatchObject({
      hidden: true,
      ownerName: 'Rania',
    });
    expect(live).toHaveBeenCalledTimes(1);

    const over = route(404);
    for (const gone of [{ ...LIVE, ended: true }, null])
      expect(await loadCallFacts(client(), 'k', gone)).toMatchObject({
        hidden: false,
        name: 'Omar',
      });
    expect(over).not.toHaveBeenCalled();
  });

  it('tells a contact it may not see from one it could not read', async () => {
    const none = client({ contacts: [] });
    const failed = { ...UNKNOWN_FACTS, incomplete: true };
    route(404);
    expect(await loadCallFacts(none, 'k', LIVE)).toEqual(UNKNOWN_FACTS);
    expect(
      await loadCallFacts(client({ contacts: 'fail' }), 'k', LIVE)
    ).toEqual(failed);
    route(500);
    expect(await loadCallFacts(none, 'k', LIVE)).toEqual(failed);
  });
});

describe('keepFacts', () => {
  const good: CallFacts = hiddenFacts({ name: 'Omar' }, 'Rania');
  const part: CallFacts = { ...good, incomplete: true };
  const at = (facts: CallFacts, contactId = 'k', callKey = 'c1:p1') => ({
    contactId,
    callKey,
    facts,
  });

  it('keeps the better facts of the same contact on the same call', () => {
    expect(keepFacts(at(good), at(UNKNOWN_FACTS)).facts).toBe(good);
    expect(keepFacts(at(good), at(part)).facts).toBe(good);
    expect(keepFacts(at(part), at(UNKNOWN_FACTS)).facts).toBe(part);
  });

  it('takes the new ones when as good, or of another contact or call', () => {
    const next = { ...good, ownerName: 'Sara' };
    expect(keepFacts(at(good), at(next)).facts).toBe(next);
    expect(keepFacts(at(part), at(good)).facts).toBe(good);
    for (const other of [
      at(UNKNOWN_FACTS, 'k2'),
      at(UNKNOWN_FACTS, 'k', 'c1:p2'),
    ])
      expect(keepFacts(at(good), other)).toBe(other);
  });
});
