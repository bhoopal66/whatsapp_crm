import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { metaNumberAlertBody, ringMetaNumberAlert } from './alert';

type Row = Record<string, unknown>;

const PROFILES: Row[] = [
  {
    user_id: 'u-owner',
    account_id: 'acct',
    account_role: 'owner',
    deactivated_at: null,
  },
  {
    user_id: 'u-admin',
    account_id: 'acct',
    account_role: 'admin',
    deactivated_at: null,
  },
  {
    user_id: 'u-leader',
    account_id: 'acct',
    account_role: 'team_leader',
    deactivated_at: null,
  },
  {
    user_id: 'u-agent',
    account_id: 'acct',
    account_role: 'agent',
    deactivated_at: null,
  },
  {
    user_id: 'u-gone',
    account_id: 'acct',
    account_role: 'owner',
    deactivated_at: '2026-11-01T00:00:00Z',
  },
  {
    user_id: 'u-far',
    account_id: 'other',
    account_role: 'owner',
    deactivated_at: null,
  },
];

/** A profiles table that applies the filters the code asks for. */
function fakeClient(
  opts: { insertError?: string; profilesError?: string } = {}
) {
  const inserted: Row[] = [];
  const client = {
    from(table: string) {
      if (table === 'profiles') {
        let rows = PROFILES;
        const q = {
          select: () => q,
          eq: (col: string, v: unknown) => {
            rows = rows.filter((r) => r[col] === v);
            return q;
          },
          in: (col: string, vs: unknown[]) => {
            rows = rows.filter((r) => vs.includes(r[col]));
            return q;
          },
          is: (col: string, v: unknown) => {
            rows = rows.filter((r) => r[col] === v);
            return q;
          },
          then: (resolve: (v: unknown) => void) =>
            resolve(
              opts.profilesError
                ? { data: null, error: { message: opts.profilesError } }
                : {
                    data: rows.map((r) => ({ user_id: r.user_id })),
                    error: null,
                  }
            ),
        };
        return q;
      }
      if (table === 'notifications') {
        return {
          insert: async (rows: Row[]) => {
            if (opts.insertError)
              return { error: { message: opts.insertError } };
            inserted.push(...rows);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as unknown as SupabaseClient, inserted };
}

const ARGS = {
  accountId: 'acct',
  configId: 'cfg-1',
  previous: 'NORMAL' as const,
  next: 'MARKETING_PAUSED' as const,
  reasons: ['QUALITY_RED', 'STATUS_RESTRICTED'],
};

afterEach(() => vi.restoreAllMocks());

describe('ringMetaNumberAlert', () => {
  it('rings live owners and admins of the account only', async () => {
    const { client, inserted } = fakeClient();
    await ringMetaNumberAlert(client, ARGS);
    expect(inserted.map((r) => r.user_id).sort()).toEqual([
      'u-admin',
      'u-owner',
    ]);
    for (const row of inserted) {
      expect(row).toMatchObject({
        account_id: 'acct',
        type: 'meta_number_alert',
        conversation_id: null,
        contact_id: null,
        actor_user_id: null,
        body: 'Meta number health: marketing paused. Reasons: QUALITY_RED, STATUS_RESTRICTED.',
        meta: {
          config_id: 'cfg-1',
          previous: 'NORMAL',
          next: 'MARKETING_PAUSED',
        },
      });
    }
  });

  it('stays silent unless the state got worse', async () => {
    const { client, inserted } = fakeClient();
    await ringMetaNumberAlert(client, {
      ...ARGS,
      previous: 'ALL_PAUSED',
      next: 'THROTTLED',
    });
    await ringMetaNumberAlert(client, {
      ...ARGS,
      previous: 'THROTTLED',
      next: 'THROTTLED',
    });
    await ringMetaNumberAlert(client, {
      ...ARGS,
      previous: null,
      next: 'NORMAL',
    });
    expect(inserted).toHaveLength(0);
    await ringMetaNumberAlert(client, {
      ...ARGS,
      previous: null,
      next: 'THROTTLED',
    });
    expect(inserted).toHaveLength(2);
  });

  it('never throws when the insert or the profiles read fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      ringMetaNumberAlert(fakeClient({ insertError: 'boom' }).client, ARGS)
    ).resolves.toBeUndefined();
    await expect(
      ringMetaNumberAlert(fakeClient({ profilesError: 'down' }).client, ARGS)
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('metaNumberAlertBody', () => {
  it('keeps only short reason codes, never free text', () => {
    expect(
      metaNumberAlertBody('ALL_PAUSED', [
        'STATUS_BANNED',
        'Your account was disabled for policy reasons',
        'x'.repeat(10),
      ])
    ).toBe('Meta number health: all sending paused. Reasons: STATUS_BANNED.');
    expect(metaNumberAlertBody('THROTTLED', [])).toBe(
      'Meta number health: throttled.'
    );
  });
});
