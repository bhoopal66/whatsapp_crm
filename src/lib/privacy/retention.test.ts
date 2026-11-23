import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  RETENTION_RULES,
  RETENTION_RETRY_MS,
  RETENTION_SLICE,
  retentionProblem,
  retentionRunner,
} from './retention';
import { PERSONAL } from './data-map';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/223_privacy_retention.sql'),
  'utf8'
);

describe('retention allow-list', () => {
  it('equals privacy_retention_rules() in migration 223', () => {
    const body = SQL.slice(
      SQL.indexOf('FUNCTION public.privacy_retention_rules()')
    );
    const rows = [
      ...body.matchAll(/\('([a-z_]+)', '([a-z_]+)', ARRAY\[([^\]]*)\]\)/g),
    ].map((m) => [
      m[1],
      {
        table: m[2],
        actions: [...m[3]!.matchAll(/'([a-z]+)'/g)].map((a) => a[1]),
      },
    ]);
    expect(Object.fromEntries(rows)).toEqual(RETENTION_RULES);
  });

  it('never names a kept (KYC, consent, audit) table', () => {
    for (const { table } of Object.values(RETENTION_RULES))
      expect(PERSONAL[table]?.erase, table).not.toBe('retain');
  });

  it('validates like the SQL', () => {
    expect(
      retentionProblem({
        tables: { hr_agent_drafts: { days: 90, action: 'delete' } },
      })
    ).toBeNull();
    expect(
      retentionProblem({ tables: { cases: { days: 90, action: 'delete' } } })
    ).toMatch(/not a retention key/);
    expect(
      retentionProblem({
        tables: { hr_agent_drafts: { days: 29, action: 'delete' } },
      })
    ).toMatch(/days/);
    expect(
      retentionProblem({
        tables: { hr_outbox_bodies: { days: 90, action: 'delete' } },
      })
    ).toMatch(/action/);
    expect(retentionProblem({ tables: {}, extra: 1 })).toMatch(/tables/);
  });
});

describe('the daily run (282)', () => {
  const MIN = 60_000;
  type Sweep = (account: string, limit: number) => unknown;
  function setup(sweep: Sweep, accounts = ['a1', 'a2']) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const clock = { t: 1_000_000 };
    const swept: string[] = [];
    const failures: unknown[] = [];
    const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'privacy_retention_accounts')
        return { data: accounts, error: null };
      if (fn === 'privacy_retention_failed') failures.push(args);
      if (fn !== 'privacy_retention_sweep') return { data: [], error: null };
      const account = String(args?.p_account);
      swept.push(account);
      const out = sweep(account, Number(args?.p_limit));
      return typeof out === 'string'
        ? { data: null, error: { code: out } }
        : { data: out, error: null };
    });
    const runner = retentionRunner(() => clock.t);
    return {
      clock,
      swept,
      failures,
      runner,
      run: () => runner.run({ rpc } as never),
    };
  }

  it('loops an account while more is left, then waits a day', async () => {
    let left = 3;
    const s = setup(() => ({ more: --left > 0 }), ['a1']);
    await s.run();
    expect(s.swept).toEqual(['a1', 'a1', 'a1']);
    s.clock.t += 23 * 60 * MIN;
    expect(s.runner.due()).toBe(false);
    s.clock.t += 60 * MIN;
    expect(s.runner.due()).toBe(true);
  });

  it('stops at the time budget and goes on at the next tick', async () => {
    const s = setup((a) => {
      s.clock.t += 30_000;
      return { more: a === 'a1' && s.swept.length < 3 };
    });
    await s.run();
    expect(s.swept).toEqual(['a1', 'a1']);
    expect(s.runner.due()).toBe(true);
    await s.run();
    expect(s.swept).toEqual(['a1', 'a1', 'a1', 'a2']);
    expect(s.runner.due()).toBe(false);
  });

  it('records a failure, sweeps the others, and does not spend the day', async () => {
    let bad = true;
    const s = setup((a) => (a === 'a1' && bad ? '23514' : { more: false }));
    await s.run();
    expect(s.swept).toEqual(['a1', 'a2']);
    expect(s.failures).toEqual([{ p_account: 'a1', p_code: '23514' }]);
    expect(s.runner.due()).toBe(false);
    bad = false;
    s.clock.t += RETENTION_RETRY_MS;
    expect(s.runner.due()).toBe(true);
    await s.run();
    // a2 had its day's run.
    expect(s.swept).toEqual(['a1', 'a2', 'a1']);
    expect(s.runner.due()).toBe(false);
  });

  it('tries a smaller slice after a timeout', async () => {
    const limits: number[] = [];
    const s = setup(
      (_, limit) => {
        limits.push(limit);
        return limit > 100 ? '57014' : { more: false };
      },
      ['a1']
    );
    await s.run();
    expect(limits).toEqual([RETENTION_SLICE, 100]);
    expect(s.failures).toEqual([]);
  });

  it('never runs twice at once', async () => {
    const s = setup(() => ({ more: false }), ['a1']);
    await Promise.all([s.run(), s.run()]);
    expect(s.swept).toEqual(['a1']);
  });
});
