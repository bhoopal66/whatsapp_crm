/**
 * Case automation rules (migration 187): "when TRIGGER on a case of my
 * workspace, if CONDITIONS, do ACTIONS", defined by an owner/admin and
 * fired by the database. Typed wrappers over the service-role RPCs and
 * the automations cron's sweep.
 *
 * TENANCY: case_rule_list / _save / _delete resolve the account from the
 * actor's ACTIVE live profile; case_rule_runs_list re-checks the case.
 * A route still checks the case's account against the caller's active one
 * (lib/cases/http.ts) before asking for a case's runs.
 *
 * Refusals (an `error.hint` in CASE_RULE_REFUSALS) throw
 * CaseRulesRefusedError; any other database error throws CaseStoreError
 * carrying only the function name and SQLSTATE, never the database text.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { CaseStoreError, rows } from './store';

export const CASE_RULE_TRIGGERS = [
  'case_opened',
  'stage_changed',
  'sla_overdue',
  'no_activity',
  'submission_attached',
] as const;
export type CaseRuleTrigger = (typeof CASE_RULE_TRIGGERS)[number];

export const CASE_RULE_REFUSALS = [
  'NOT_ALLOWED',
  'RULE_INVALID',
  'RULE_NOT_FOUND',
  'CASE_NOT_FOUND',
  'NOW_REQUIRED',
] as const;
export type CaseRuleRefusal = (typeof CASE_RULE_REFUSALS)[number];

export class CaseRulesRefusedError extends Error {
  override readonly name = 'CaseRulesRefusedError';
  constructor(readonly reason: CaseRuleRefusal) {
    super(`case rules refused: ${reason}`);
  }
}

const REFUSALS = new Set<string>(CASE_RULE_REFUSALS);

type DbError = { code?: string; hint?: string | null };

function fail(fn: string, error: DbError): never {
  if (typeof error.hint === 'string' && REFUSALS.has(error.hint))
    throw new CaseRulesRefusedError(error.hint as CaseRuleRefusal);
  throw new CaseStoreError(fn, error.code ?? null);
}

export interface CaseRule {
  ruleId: string;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>[];
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One action's outcome in a run: 187's `{kind, ok, refusal}`. */
export interface CaseRuleApplied {
  kind: string;
  ok: boolean;
  refusal: string | null;
}

export interface CaseRuleRun {
  ruleId: string;
  caseId: string;
  trigger: string;
  fireKey: string | null;
  matched: boolean;
  applied: CaseRuleApplied[];
  at: string;
}

export interface CaseRuleInput {
  ruleId: string | null;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: Record<string, unknown>;
  actions: unknown[];
  position: number | null;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string => new Date(String(v)).toISOString();
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function toCaseRule(r: Row): CaseRule {
  return {
    ruleId: String(r.rule_id),
    name: String(r.name),
    enabled: r.enabled === true,
    trigger: String(r.trigger),
    conditions: obj(r.conditions),
    actions: arr(r.actions).map(obj),
    position: Number(r.position),
    createdBy: String(r.created_by),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toCaseRuleRun(r: Row): CaseRuleRun {
  return {
    ruleId: String(r.rule_id),
    caseId: String(r.case_id),
    trigger: String(r.trigger),
    fireKey:
      r.fire_key === null || r.fire_key === undefined
        ? null
        : String(r.fire_key),
    matched: r.matched === true,
    applied: arr(r.applied).map((x) => {
      const a = obj(x);
      return {
        kind: String(a.kind ?? ''),
        ok: a.ok === true,
        refusal:
          a.refusal === null || a.refusal === undefined
            ? null
            : String(a.refusal),
      };
    }),
    at: iso(r.at),
  };
}

export class CaseRulesStore {
  constructor(private readonly db: SupabaseClient) {}

  private async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) fail(fn, error);
    return data as unknown;
  }

  /** The actor's active workspace's rules, in position order. */
  async list(actor: string): Promise<CaseRule[]> {
    return rows(await this.rpc('case_rule_list', { p_actor: actor })).map(
      toCaseRule
    );
  }

  /** Creates (ruleId null) or replaces a rule; owner/admin only. */
  async save(actor: string, input: CaseRuleInput): Promise<CaseRule> {
    const row = rows(
      await this.rpc('case_rule_save', {
        p_actor: actor,
        p_rule_id: input.ruleId,
        p_name: input.name,
        p_enabled: input.enabled,
        p_trigger: input.trigger,
        p_conditions: input.conditions,
        p_actions: input.actions,
        p_position: input.position,
      })
    )[0];
    if (!row) throw new CaseStoreError('case_rule_save', null);
    return toCaseRule(row);
  }

  async delete(actor: string, ruleId: string): Promise<void> {
    await this.rpc('case_rule_delete', { p_actor: actor, p_rule_id: ruleId });
  }

  /** A case's run log, oldest first. */
  async runs(actor: string, caseId: string): Promise<CaseRuleRun[]> {
    return rows(
      await this.rpc('case_rule_runs_list', { p_actor: actor, p_case: caseId })
    ).map(toCaseRuleRun);
  }
}

export interface CaseRulesSweepResult {
  ok: boolean;
  /** Cases a sweep trigger fired on (one entry per case and trigger). */
  fired: number;
  /** case_rule_runs rows written. */
  runs: number;
  noActivity: number;
  slaOverdue: number;
}

/**
 * The no_activity / sla_overdue sweep (case_rules_sweep), for the
 * automations cron after the case SLA evaluation. Never throws: a failure
 * is one log line (SQLSTATE only) and `ok: false`; a sweep that fired
 * something logs one line of counts. Never a case id or rule text.
 */
export async function runCaseRulesSweep({
  admin,
  now = new Date(),
}: {
  admin: SupabaseClient;
  now?: Date;
}): Promise<CaseRulesSweepResult> {
  const out: CaseRulesSweepResult = {
    ok: false,
    fired: 0,
    runs: 0,
    noActivity: 0,
    slaOverdue: 0,
  };
  try {
    const { data, error } = await admin.rpc('case_rules_sweep', {
      p_now: now.toISOString(),
    });
    if (error) {
      console.error('[case-rules] sweep failed:', error.code ?? null);
      return out;
    }
    for (const x of arr(obj(data).fired)) {
      const f = obj(x);
      const runs = Number(f.runs);
      out.fired += 1;
      out.runs += Number.isFinite(runs) ? runs : 0;
      if (f.trigger === 'no_activity') out.noActivity += 1;
      else if (f.trigger === 'sla_overdue') out.slaOverdue += 1;
    }
    out.ok = true;
    if (out.fired > 0) {
      const { fired, runs, noActivity, slaOverdue } = out;
      console.log('[case-rules] sweep:', {
        fired,
        runs,
        noActivity,
        slaOverdue,
      });
    }
    return out;
  } catch (err) {
    console.error(
      '[case-rules] sweep failed:',
      err instanceof Error ? err.name : typeof err
    );
    return out;
  }
}
