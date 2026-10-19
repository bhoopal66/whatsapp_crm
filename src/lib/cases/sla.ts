/**
 * Case SLA timers (module 018c, migration 124) over a service-role
 * supabase-js client. Every write passes the store clock as `p_now`.
 *
 *   timer          — start | stop | reset one timer (case_sla_timer);
 *                    start / reset need a config row for the case's bank and
 *                    stage (SLA_NOT_CONFIGURED).
 *   event          — customer_message | bank_response, as the actor
 *                    (case_sla_event). stage_change and document_received
 *                    fire in 124's triggers, never from here.
 *   customerMessageSystem — the inbound pipeline's customer_message
 *                    (case_sla_event_system, no actor).
 *   evaluate       — the SLA job (case_sla_evaluate): SERVICE-ONLY, never
 *                    behind a user request.
 *   dueCases       — the cases the job has work on at a clock
 *                    (case_sla_due_cases), evaluated one by one: SERVICE-ONLY.
 *   config*        — per (account, bank, stage, timer), owner/admin.
 * Writes return the case's sla_state after them (NULL: no timer running).
 */
import { CaseRpc, type Row } from './rpc';
import { date, rows, str } from './store';

export type SlaTimer = 'customer_reply' | 'bank_response' | 'document_chase';
export type SlaState = 'on_track' | 'due_soon' | 'overdue';
export type SlaTimerAction = 'start' | 'stop' | 'reset';
export type SlaActorEvent = 'customer_message' | 'bank_response';
export type SlaUnit = 'minutes' | 'days';

export interface SlaConfig {
  accountId: string;
  bankCode: string;
  stage: string;
  timer: SlaTimer;
  amount: number;
  unit: SlaUnit;
  dueSoonPct: number;
  dueSoonMinutes: number | null;
}

export interface SlaTimerRow {
  timer: SlaTimer;
  stage: string;
  startedAt: Date;
  dueSoonAt: Date;
  dueAt: Date;
  stoppedAt: Date | null;
  /** NULL for a stopped timer never evaluated. */
  state: SlaState | null;
}

export interface SlaChange {
  caseId: string;
  timer: SlaTimer;
  fromState: SlaState | null;
  toState: string;
}

const toConfig = (r: Row): SlaConfig => ({
  accountId: String(r.account_id),
  bankCode: String(r.bank_code),
  stage: String(r.stage),
  timer: String(r.timer) as SlaTimer,
  amount: Number(r.amount),
  unit: String(r.unit) as SlaUnit,
  dueSoonPct: Number(r.due_soon_pct),
  dueSoonMinutes:
    r.due_soon_minutes === null || r.due_soon_minutes === undefined
      ? null
      : Number(r.due_soon_minutes),
});

const state = (v: unknown) => str(v) as SlaState | null;

export class CaseSlaStore extends CaseRpc {
  async timer(
    caseId: string,
    actor: string,
    timer: SlaTimer,
    action: SlaTimerAction
  ): Promise<SlaState | null> {
    return state(
      await this.rpc('case_sla_timer', {
        p_case: caseId,
        p_actor: actor,
        p_timer: timer,
        p_action: action,
        p_now: this.now(),
      })
    );
  }

  async event(
    caseId: string,
    actor: string,
    event: SlaActorEvent
  ): Promise<SlaState | null> {
    return state(
      await this.rpc('case_sla_event', {
        p_case: caseId,
        p_actor: actor,
        p_event: event,
        p_now: this.now(),
      })
    );
  }

  /** A customer message seen by the inbound pipeline (no actor). */
  async customerMessageSystem(
    caseId: string,
    now?: Date
  ): Promise<SlaState | null> {
    return state(
      await this.rpc('case_sla_event_system', {
        p_case: caseId,
        p_event: 'customer_message',
        p_now: (now ?? this.clock()).toISOString(),
      })
    );
  }

  /** SERVICE-ONLY: the state changes logged at `now` (one case or all). */
  async evaluate(now?: Date, caseId?: string): Promise<SlaChange[]> {
    const data = await this.rpc('case_sla_evaluate', {
      p_now: (now ?? this.clock()).toISOString(),
      p_case: caseId ?? null,
    });
    return rows(data).map((x) => ({
      caseId: String(x.case_id),
      timer: String(x.timer) as SlaTimer,
      fromState: state(x.from_state),
      toState: String(x.to_state),
    }));
  }

  /**
   * SERVICE-ONLY: the cases with a running timer whose state at `now`
   * differs from the stored one, ordered by id, at most `limit` (the SQL
   * clamps it to 1 .. 5000). Takes no lock.
   */
  async dueCases(now: Date, limit?: number): Promise<string[]> {
    const data = await this.rpc('case_sla_due_cases', {
      p_now: now.toISOString(),
      p_limit: limit ?? null,
    });
    return rows(data).map((x) => String(x.case_id));
  }

  /** The case's timers (no access decision). */
  async timers(caseId: string): Promise<SlaTimerRow[]> {
    const data = await this.select(
      'case_sla_timers',
      'timer, stage, started_at, due_soon_at, due_at, stopped_at, state',
      { case_id: caseId },
      ['timer']
    );
    return data.map((t) => ({
      timer: String(t.timer) as SlaTimer,
      stage: String(t.stage),
      startedAt: date(t.started_at)!,
      dueSoonAt: date(t.due_soon_at)!,
      dueAt: date(t.due_at)!,
      stoppedAt: date(t.stopped_at),
      state: state(t.state),
    }));
  }

  async upsertConfig(
    actor: string,
    c: Omit<SlaConfig, 'dueSoonPct' | 'dueSoonMinutes'> & {
      dueSoonPct?: number;
      dueSoonMinutes?: number | null;
    }
  ): Promise<SlaConfig> {
    return toConfig(
      await this.one('case_sla_config_upsert', {
        p_actor: actor,
        p_account: c.accountId,
        p_bank_code: c.bankCode,
        p_stage: c.stage,
        p_timer: c.timer,
        p_amount: c.amount,
        p_unit: c.unit,
        p_due_soon_pct: c.dueSoonPct ?? 20,
        p_due_soon_minutes: c.dueSoonMinutes ?? null,
      })
    );
  }

  async deleteConfig(
    actor: string,
    accountId: string,
    bankCode: string,
    stage: string,
    timer: SlaTimer
  ): Promise<boolean> {
    const data = await this.rpc('case_sla_config_delete', {
      p_actor: actor,
      p_account: accountId,
      p_bank_code: bankCode,
      p_stage: stage,
      p_timer: timer,
    });
    return data === true;
  }

  /** The account's SLA config, optionally one bank's (no access decision). */
  async listConfig(accountId: string, bankCode?: string): Promise<SlaConfig[]> {
    const eq: Record<string, string> = { account_id: accountId };
    if (bankCode !== undefined) eq.bank_code = bankCode;
    const data = await this.select(
      'case_sla_config',
      'account_id, bank_code, stage, timer, amount, unit, due_soon_pct, due_soon_minutes',
      eq,
      ['bank_code', 'stage', 'timer']
    );
    return data.map(toConfig);
  }
}
