import { describe, expect, it } from 'vitest';
import { SupabaseConsentPort } from './consent';
import { fakeDb } from './fake-db';
import { JourneyDbError } from './store';

const AT = '2026-03-01T06:00:00Z';
const stamps = (
  optIn: string | null,
  optedOut: string | null,
  dnc: string | null = null
) => ({
  data: {
    marketing_opt_in_at: optIn,
    opted_out_at: optedOut,
    do_not_contact_at: dnc,
  },
});

describe('SupabaseConsentPort: the register on contacts', () => {
  it('reads the three stamps of the contact by id', async () => {
    const { db, queries } = fakeDb(stamps(AT, null));
    await new SupabaseConsentPort(db).hasMarketingOptIn('c1');
    expect(queries).toEqual([
      [
        ['from', 'contacts'],
        ['select', 'opted_out_at, marketing_opt_in_at, do_not_contact_at'],
        ['eq', 'id', 'c1'],
        ['maybeSingle'],
      ],
    ]);
  });

  it('truth table: an opt-in counts only while not opted out', async () => {
    const cases: [string | null, string | null, boolean, boolean][] = [
      // opt-in, opted out → hasMarketingOptIn, isOptedOut
      [AT, null, true, false],
      [AT, AT, false, true],
      [null, null, false, false],
      [null, AT, false, true],
    ];
    for (const [optIn, out, wantOptIn, wantOut] of cases) {
      const port = new SupabaseConsentPort(
        fakeDb(stamps(optIn, out), stamps(optIn, out)).db
      );
      expect(await port.hasMarketingOptIn('c1')).toBe(wantOptIn);
      expect(await port.isOptedOut('c1')).toBe(wantOut);
    }
  });

  it('doNotContact: the do-not-contact stamp alone decides', async () => {
    const port = new SupabaseConsentPort(
      fakeDb(
        stamps(null, null, AT),
        stamps(AT, null, null),
        stamps(null, AT, null)
      ).db
    );
    expect(await port.doNotContact('c1')).toBe(true);
    expect(await port.doNotContact('c1')).toBe(false);
    expect(await port.doNotContact('c1')).toBe(false);
  });

  it('a missing contact reads as false everywhere', async () => {
    const port = new SupabaseConsentPort(fakeDb().db);
    expect(await port.hasMarketingOptIn('c9')).toBe(false);
    expect(await port.isOptedOut('c9')).toBe(false);
    expect(await port.doNotContact('c9')).toBe(false);
    expect(await port.hasReceivedOptinWelcome('c9')).toBe(false);
  });

  it('throws a contacts read error with its message and code', async () => {
    const err = {
      message: 'permission denied for table contacts',
      code: '42501',
    };
    const e = await new SupabaseConsentPort(fakeDb({ error: err }).db)
      .isOptedOut('c1')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(JourneyDbError);
    expect(e).toMatchObject({ source: 'contacts', code: '42501', cause: err });
    expect((e as Error).message).toContain(err.message);
  });
});

describe('SupabaseConsentPort: the opt-in welcome', () => {
  it('hasReceivedOptinWelcome asks journey_has_optin_welcome (a claim or a committed MARK)', async () => {
    const { db, queries } = fakeDb(
      { data: true },
      { data: [{ journey_has_optin_welcome: false }] }
    );
    const port = new SupabaseConsentPort(db);
    expect(await port.hasReceivedOptinWelcome('c1')).toBe(true);
    expect(await port.hasReceivedOptinWelcome('c1')).toBe(false);
    expect(queries[0]).toEqual([
      ['rpc', 'journey_has_optin_welcome', { p_contact_id: 'c1' }],
      ['await'],
    ]);
  });

  it('hasReceivedOptinWelcome throws the RPC error', async () => {
    const err = { message: 'permission denied', code: '42501' };
    const e = await new SupabaseConsentPort(fakeDb({ error: err }).db)
      .hasReceivedOptinWelcome('c1')
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ source: 'journey_has_optin_welcome', code: '42501' });
  });

  it('claimOptinWelcome calls journey_claim_optin_welcome with the contact and claim ids', async () => {
    const { db, queries } = fakeDb({ data: true });
    expect(
      await new SupabaseConsentPort(db).claimOptinWelcome('c1', 'item-1')
    ).toBe(true);
    expect(queries).toEqual([
      [
        [
          'rpc',
          'journey_claim_optin_welcome',
          { p_contact_id: 'c1', p_claim_id: 'item-1' },
        ],
        ['await'],
      ],
    ]);
  });

  it('claimOptinWelcome is true only for a true result, in any PostgREST shape', async () => {
    const cases: [unknown, boolean][] = [
      [[true], true],
      [{ journey_claim_optin_welcome: true }, true],
      [[{ journey_claim_optin_welcome: true }], true],
      [false, false],
      [null, false],
      ['true', false],
      [{ other: true }, false],
    ];
    for (const [data, want] of cases)
      expect(
        await new SupabaseConsentPort(fakeDb({ data }).db).claimOptinWelcome(
          'c1',
          'item-1'
        )
      ).toBe(want);
  });

  it('claimOptinWelcome throws the RPC error', async () => {
    const err = {
      message: 'journey_claim_optin_welcome: empty claim id',
      code: '22023',
    };
    await expect(
      new SupabaseConsentPort(fakeDb({ error: err }).db).claimOptinWelcome(
        'c1',
        ''
      )
    ).rejects.toMatchObject({
      source: 'journey_claim_optin_welcome',
      code: '22023',
      cause: err,
    });
  });
});
