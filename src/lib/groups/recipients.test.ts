import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { screenRecipients } from './recipients';
import { fakeSupabase, type FakeDb } from './test-db';

// The consent register: opted-out and do-not-contact people are skipped,
// unless an owner/admin asked to add them anyway (`overrideConsent`).

const C1 = '44444444-4444-4444-8444-444444444441';
const C2 = '44444444-4444-4444-8444-444444444442';

function setup(adminDb?: FakeDb) {
  const rls: FakeDb = {
    tables: {
      contacts: [
        {
          id: C1,
          account_id: 'acct-1',
          phone: '+971501111111',
          opted_out_at: null,
          do_not_contact_at: null,
        },
        {
          id: C2,
          account_id: 'acct-1',
          phone: '+971502222222',
          opted_out_at: '2026-10-01T00:00:00Z',
          do_not_contact_at: null,
        },
      ],
    },
  };
  const admin: FakeDb = adminDb ?? {
    tables: {
      contacts: [
        {
          id: 'c-raw',
          account_id: 'acct-1',
          phone_normalized: '971503333333',
          opted_out_at: null,
          do_not_contact_at: '2026-10-01T00:00:00Z',
        },
      ],
    },
  };
  return {
    caller: {
      supabase: fakeSupabase(rls) as unknown as SupabaseClient,
      accountId: 'acct-1',
    },
    admin: fakeSupabase(admin) as unknown as SupabaseClient,
  };
}

const input = {
  contactIds: [C1, C2],
  phones: ['971503333333', '971504444444'],
};

describe('screenRecipients', () => {
  it('skips a refused contact and a refused raw phone by default', async () => {
    const { caller, admin } = setup();
    const out = await screenRecipients(caller, admin, input);
    expect(out.recipients.map((r) => r.waId)).toEqual([
      '971501111111',
      '971504444444',
    ]);
    expect(out.skipped).toEqual([
      { waId: '971502222222', contactId: C2, reason: 'opted_out' },
      { waId: '971503333333', contactId: null, reason: 'do_not_contact' },
    ]);
    expect(out.overridden).toBe(0);
  });

  it('overrideConsent lets both through as recipients', async () => {
    const { caller, admin } = setup();
    const out = await screenRecipients(caller, admin, input, {
      overrideConsent: true,
    });
    expect(out.recipients).toEqual([
      { waId: '971501111111', contactId: C1 },
      { waId: '971502222222', contactId: C2 },
      { waId: '971503333333', contactId: null },
      { waId: '971504444444', contactId: null },
    ]);
    expect(out.skipped).toEqual([]);
    expect(out.overridden).toBe(2);
  });

  it('still fails closed when the register cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { caller, admin } = setup({
      tables: { contacts: [] },
      errors: { 'contacts:select': { message: 'down' } },
    });
    await expect(
      screenRecipients(caller, admin, input, { overrideConsent: true })
    ).rejects.toMatchObject({ status: 503 });
  });
});
