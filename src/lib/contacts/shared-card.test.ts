import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findCardContact, saveCardContact } from './shared-card';

type Answer = { data: { id: string } | null; error: unknown };

/** Answers the contact lookups in order, and the insert. */
function fakeClient(lookups: Answer[], insert?: Answer) {
  const inserted: unknown[] = [];
  const client = {
    from: () => {
      let answer: Answer | undefined;
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit']) q[m] = () => q;
      q.insert = (v: unknown) => {
        inserted.push(v);
        answer = insert;
        return q;
      };
      q.maybeSingle = async () => lookups.shift();
      q.single = async () => answer;
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, inserted };
}

const none: Answer = { data: null, error: null };
const down: Answer = { data: null, error: { code: '57014', message: 'x' } };
const taken: Answer = {
  data: null,
  error: { code: '23505', message: 'duplicate key value violates …' },
};
const card = {
  accountId: 'acct',
  userId: 'me',
  phone: '971500000001',
  name: 'Ali',
  email: null,
  company: null,
};

describe('shared contact card', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('tells a failed lookup from a number nobody has', async () => {
    expect(
      await findCardContact(fakeClient([down]).client, 'acct', '9715')
    ).toEqual({ ok: false });
    expect(
      await findCardContact(fakeClient([none]).client, 'acct', '9715')
    ).toEqual({ ok: true, id: null });
  });

  it('never inserts when the lookup failed', async () => {
    const { client, inserted } = fakeClient([down]);
    expect(await saveCardContact(client, card)).toEqual({
      kind: 'lookupFailed',
    });
    expect(inserted).toEqual([]);
  });

  it('opens the contact the viewer already has', async () => {
    const { client, inserted } = fakeClient([
      { data: { id: 'c1' }, error: null },
    ]);
    expect(await saveCardContact(client, card)).toEqual({
      kind: 'existing',
      id: 'c1',
    });
    expect(inserted).toEqual([]);
  });

  it('creates a new one', async () => {
    const { client, inserted } = fakeClient([none], {
      data: { id: 'c2' },
      error: null,
    });
    expect(await saveCardContact(client, card)).toEqual({
      kind: 'created',
      id: 'c2',
    });
    expect(inserted).toEqual([
      {
        user_id: 'me',
        account_id: 'acct',
        name: 'Ali',
        phone: '971500000001',
        email: null,
        company: null,
      },
    ]);
  });

  it('says a colleague has the number, not the database’s sentence', async () => {
    const { client } = fakeClient([none, none], taken);
    expect(await saveCardContact(client, card)).toEqual({ kind: 'colleague' });
  });

  it('opens a contact that a second tab saved first', async () => {
    const { client } = fakeClient(
      [none, { data: { id: 'c3' }, error: null }],
      taken
    );
    expect(await saveCardContact(client, card)).toEqual({
      kind: 'existing',
      id: 'c3',
    });
  });

  it('reports any other refusal as failed', async () => {
    const { client } = fakeClient([none], {
      data: null,
      error: { code: '42501', message: 'row-level security' },
    });
    expect(await saveCardContact(client, card)).toEqual({ kind: 'failed' });
  });
});
