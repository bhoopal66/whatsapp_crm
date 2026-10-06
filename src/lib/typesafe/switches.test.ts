import { describe, expect, it } from 'vitest';
import {
  SWITCHES_OFF,
  SWITCHES_UNKNOWN,
  SWITCHES_UNMANAGED,
  checkState,
  type AccountSwitches,
} from './config';
import { SwitchesStore } from './policy';
import type { TsStore } from './store';
import { TEST_ACCOUNT, testConfig } from './test-helpers';

const LIVE: AccountSwitches = {
  enabled: true,
  mode: 'live',
  checks: {
    triage: true,
    guardrail: true,
    passages: false,
    eligibility: false,
  },
  watchHumanThreads: true,
  languages: 'english',
};

function storeWith(read: () => Promise<AccountSwitches | null>): TsStore {
  return {
    activePolicy: async () => null,
    insertDecision: async () => null,
    accountSwitches: read,
  };
}

describe('checkState (migration 064)', () => {
  const config = testConfig({ shadowLanguages: ['ar', 'mixed', 'other'] });

  it('runs a check only when the server, the account and the check all allow it', () => {
    expect(checkState(config, LIVE, 'triage', TEST_ACCOUNT).on).toBe(true);
    expect(checkState(config, LIVE, 'passages', TEST_ACCOUNT).on).toBe(false);
    expect(
      checkState(config, { ...LIVE, enabled: false }, 'triage', TEST_ACCOUNT).on
    ).toBe(false);
    expect(checkState(config, SWITCHES_OFF, 'guardrail', TEST_ACCOUNT).on).toBe(
      false
    );
    const noTriage = testConfig({
      enabled: { ...config.enabled, triage: false },
    });
    expect(checkState(noTriage, LIVE, 'triage', TEST_ACCOUNT).on).toBe(false);
    const otherAccount = testConfig({
      accounts: ['11111111-1111-4111-8111-111111111111'],
    });
    expect(checkState(otherAccount, LIVE, 'triage', TEST_ACCOUNT).on).toBe(
      false
    );
  });

  it('monitors when the account chose it or the server forces it', () => {
    expect(checkState(config, LIVE, 'triage', TEST_ACCOUNT).monitor).toBe(
      false
    );
    expect(
      checkState(config, { ...LIVE, mode: 'monitor' }, 'triage', TEST_ACCOUNT)
        .monitor
    ).toBe(true);
    expect(
      checkState(testConfig({ shadow: true }), LIVE, 'triage', TEST_ACCOUNT)
        .monitor
    ).toBe(true);
    expect(
      checkState(
        testConfig({ shadowOverride: { guardrail: true } }),
        LIVE,
        'guardrail',
        TEST_ACCOUNT
      ).monitor
    ).toBe(true);
  });

  it('"All languages" clears the logged-only languages', () => {
    expect(
      checkState(config, LIVE, 'triage', TEST_ACCOUNT).shadowLanguages
    ).toEqual(['ar', 'mixed', 'other']);
    expect(
      checkState(config, { ...LIVE, languages: 'all' }, 'triage', TEST_ACCOUNT)
        .shadowLanguages
    ).toEqual([]);
  });
});

describe('SwitchesStore', () => {
  it('leaves the install to decide when the store has no switches', async () => {
    const s = new SwitchesStore({
      store: {
        activePolicy: async () => null,
        insertDecision: async () => null,
      },
    });
    expect(await s.get(TEST_ACCOUNT)).toBe(SWITCHES_UNMANAGED);
    expect(await new SwitchesStore({}).get(TEST_ACCOUNT)).toBe(
      SWITCHES_UNMANAGED
    );
  });

  it('treats an account that never saved settings as off', async () => {
    const s = new SwitchesStore({ store: storeWith(async () => null) });
    expect(await s.get(TEST_ACCOUNT)).toEqual(SWITCHES_OFF);
  });

  it('caches for the TTL and re-reads after invalidate', async () => {
    let now = 0;
    let reads = 0;
    let current: AccountSwitches = LIVE;
    const s = new SwitchesStore({
      store: storeWith(async () => {
        reads++;
        return current;
      }),
      now: () => now,
      ttlMs: 30_000,
    });
    expect(await s.get(TEST_ACCOUNT)).toEqual(LIVE);
    current = { ...LIVE, enabled: false };
    now = 29_000;
    expect((await s.get(TEST_ACCOUNT)).enabled).toBe(true);
    expect(reads).toBe(1);
    s.invalidate(TEST_ACCOUNT);
    expect((await s.get(TEST_ACCOUNT)).enabled).toBe(false);
    expect(reads).toBe(2);
    current = LIVE;
    now = 60_000;
    expect((await s.get(TEST_ACCOUNT)).enabled).toBe(true);
  });

  it('retries a read once, then keeps the last good switches', async () => {
    let fail = 0;
    const errors: unknown[] = [];
    const now = 0;
    const s = new SwitchesStore({
      store: storeWith(async () => {
        if (fail > 0) {
          fail--;
          throw new Error('db down');
        }
        return LIVE;
      }),
      now: () => now,
      onError: (e) => errors.push(e),
    });
    fail = 1; // the retry succeeds
    expect(await s.get(TEST_ACCOUNT)).toEqual(LIVE);
    expect(errors).toHaveLength(0);
    s.invalidate();
    fail = 2; // both attempts fail
    expect(await s.get(TEST_ACCOUNT)).toEqual(LIVE);
    expect(errors).toHaveLength(1);
  });

  it('is off, and marked unknown, after a failed read with nothing read before', async () => {
    const s = new SwitchesStore({
      store: storeWith(async () => {
        throw new Error('db down');
      }),
    });
    const sw = await s.get(TEST_ACCOUNT);
    expect(sw).toEqual(SWITCHES_UNKNOWN);
    expect(
      checkState(testConfig(), sw, 'guardrail', TEST_ACCOUNT)
    ).toMatchObject({ on: false, unknown: true });
  });

  it('a read in flight when settings are saved cannot restore the old ones', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const s = new SwitchesStore({
      store: storeWith(async () => {
        if (first) {
          first = false;
          await gate; // resolves after the save below
        }
        return LIVE; // the row as read before the save committed
      }),
    });
    const inFlight = s.get(TEST_ACCOUNT);
    const off: AccountSwitches = { ...LIVE, enabled: false };
    s.set(TEST_ACCOUNT, off);
    release();
    // The stale read returns the saved state, and does not cache LIVE.
    expect((await inFlight).enabled).toBe(false);
    expect((await s.get(TEST_ACCOUNT)).enabled).toBe(false);
  });

  it('set() is kept as the last good copy through a later read error', async () => {
    let fail = false;
    let now = 0;
    const s = new SwitchesStore({
      store: storeWith(async () => {
        if (fail) throw new Error('db down');
        return LIVE;
      }),
      now: () => now,
    });
    expect((await s.get(TEST_ACCOUNT)).mode).toBe('live');
    s.set(TEST_ACCOUNT, { ...LIVE, mode: 'monitor' });
    fail = true;
    now = 60_000; // past the TTL: a fresh read, which fails
    expect((await s.get(TEST_ACCOUNT)).mode).toBe('monitor');
  });
});
