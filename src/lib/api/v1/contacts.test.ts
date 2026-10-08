import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CONTACT_SELECT,
  serializeContact,
  findOrCreateContact,
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
