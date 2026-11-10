import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CaseRulesRefusedError,
  CaseRulesStore,
  runCaseRulesSweep,
} from './rules';
import { CaseStoreError } from './store';

const db = (result: unknown) =>
  ({ rpc: vi.fn(async () => result) }) as unknown as SupabaseClient & {
    rpc: ReturnType<typeof vi.fn>;
  };

afterEach(() => vi.restoreAllMocks());

describe('runCaseRulesSweep', () => {
  it('passes the clock and counts what fired, logging counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const admin = db({
      data: {
        fired: [
          { caseId: 'c1', trigger: 'no_activity', runs: 2 },
          { caseId: 'c2', trigger: 'sla_overdue', runs: 1 },
        ],
      },
      error: null,
    });
    const r = await runCaseRulesSweep({
      admin,
      now: new Date('2026-11-10T08:00:00Z'),
    });
    expect(admin.rpc).toHaveBeenCalledWith('case_rules_sweep', {
      p_now: '2026-11-10T08:00:00.000Z',
    });
    expect(r).toEqual({
      ok: true,
      fired: 2,
      runs: 3,
      noActivity: 1,
      slaOverdue: 1,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls[0])).not.toContain('c1');
  });

  it('never throws: an RPC error or a thrown client is ok: false', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r1 = await runCaseRulesSweep({
      admin: db({ data: null, error: { code: '57014', message: 'x' } }),
    });
    expect(r1.ok).toBe(false);
    const thrower = {
      rpc: vi.fn(async () => {
        throw new Error('network');
      }),
    } as unknown as SupabaseClient;
    const r2 = await runCaseRulesSweep({ admin: thrower });
    expect(r2.ok).toBe(false);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe('CaseRulesStore', () => {
  it('maps a refusal hint to CaseRulesRefusedError and anything else to CaseStoreError', async () => {
    const refused = new CaseRulesStore(
      db({ data: null, error: { code: '22023', hint: 'RULE_INVALID' } })
    );
    await expect(refused.list('u')).rejects.toEqual(
      new CaseRulesRefusedError('RULE_INVALID')
    );
    const broken = new CaseRulesStore(
      db({ data: null, error: { code: '42501', hint: null } })
    );
    await expect(broken.delete('u', 'r')).rejects.toBeInstanceOf(
      CaseStoreError
    );
  });

  it('maps rule and run rows', async () => {
    const store = new CaseRulesStore(
      db({
        data: [
          {
            rule_id: 'r1',
            case_id: 'c1',
            trigger: 'stage_changed',
            fire_key: null,
            matched: true,
            applied: [
              { kind: 'set_priority', ok: false, refusal: 'CASE_CLOSED' },
            ],
            at: '2026-11-10T08:00:00+00:00',
          },
        ],
        error: null,
      })
    );
    expect(await store.runs('u', 'c1')).toEqual([
      {
        ruleId: 'r1',
        caseId: 'c1',
        trigger: 'stage_changed',
        fireKey: null,
        matched: true,
        applied: [{ kind: 'set_priority', ok: false, refusal: 'CASE_CLOSED' }],
        at: '2026-11-10T08:00:00.000Z',
      },
    ]);
  });
});
