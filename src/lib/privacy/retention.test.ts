import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  RETENTION_RULES,
  retentionProblem,
  runRetentionSweeps,
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

  it('sweeps each listed account and survives a failure', async () => {
    const rpc = vi.fn(async (fn: string, args?: { p_account: string }) =>
      fn === 'privacy_retention_accounts'
        ? { data: ['a1', 'a2'], error: null }
        : args?.p_account === 'a1'
          ? { data: null, error: { code: '57014' } }
          : { data: { mode: 'dry_run', tables: {} }, error: null }
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runRetentionSweeps({ rpc } as never);
    expect(rpc).toHaveBeenCalledWith('privacy_retention_sweep', {
      p_account: 'a2',
    });
  });
});
