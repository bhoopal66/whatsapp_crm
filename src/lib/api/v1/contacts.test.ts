import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CONTACT_SELECT,
  serializeContact,
  findOrCreateContact,
  getContactById,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('projects the public fields, with empty tags and opted_out_at', () => {
    const row = {
      id: 'c1',
      account_id: 'internal-acct',
      user_id: 'internal-user',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      opted_out_at: '2026-09-01T00:00:00Z',
      lead_source: 'web_form',
      lead_source_detail: { page_url: 'https://x.example' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [],
      opted_out_at: '2026-09-01T00:00:00Z',
      lead_source: 'web_form',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('nulls opted_out_at and other missing fields', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      created_at: 'a',
      updated_at: 'b',
    };
    const out = serializeContact(row);
    expect(out.opted_out_at).toBeNull();
    expect(out.lead_source).toBeNull();
    expect(out.name).toBeNull();
    expect(out.tags).toEqual([]);
  });
});

describe('CONTACT_SELECT', () => {
  it('no longer embeds contact tags', () => {
    expect(CONTACT_SELECT).toBe('*');
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});

describe('getContactById', () => {
  const db = (answer: unknown) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => answer,
    };
    return { from: () => chain } as unknown as SupabaseClient;
  };

  it('is null for no row, and for an id that is not a uuid', async () => {
    expect(
      await getContactById(db({ data: null, error: null }), 'acc', 'c')
    ).toBeNull();
    expect(
      await getContactById(
        db({ data: null, error: { code: '22P02' } }),
        'acc',
        'c'
      )
    ).toBeNull();
  });

  it('is a 503 when the read failed', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    await expect(
      getContactById(db({ data: null, error: { code: '57014' } }), 'acc', 'c')
    ).rejects.toMatchObject({ status: 503, code: 'unavailable' });
  });
});

describe('findOrCreateContact, created', () => {
  it('hands back the row the insert returned', async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'or', 'like', 'insert'])
      chain[m] = () => chain;
    for (const m of ['in', 'ilike', 'is', 'filter']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => void) =>
      resolve({ data: [], error: null });
    chain.single = async () => ({
      data: { id: 'c-1', phone: '971501234567', name: 'Ann' },
      error: null,
    });
    const db = { from: () => chain, rpc: () => chain };
    expect(
      await findOrCreateContact(
        db as unknown as SupabaseClient,
        'acc',
        'user',
        { phone: '971501234567' }
      )
    ).toMatchObject({
      id: 'c-1',
      created: true,
      contact: { id: 'c-1', name: 'Ann' },
    });
  });
});
