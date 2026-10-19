/**
 * Case store (module 018c, migration 122) over a service-role supabase-js
 * client. Every write is one SECURITY DEFINER `case_*` RPC that resolves
 * the actor's role live (`case_role`) and re-checks it; reads are plain
 * service-role SELECTs, so they decide nothing about access.
 *
 * ACTIVE WORKSPACE: `case_role` / `case_can_*` (like 115's functions) do
 * not look at which workspace is the caller's active one: a person with a
 * live profile in the case's account holds their role there even while
 * working in another. So a route must first `get(caseId)` and refuse
 * unless `accountId` equals the caller's active account, and only then
 * call a method that takes an actor. The same holds for the account
 * methods (`upsertBank`, `setStages`).
 *
 * Refusals (an `error.hint` in CASE_REFUSALS) throw CaseRefusedError;
 * any other database error throws CaseStoreError carrying only the
 * function name and SQLSTATE, never the database text.
 *
 * Group end: the first move of a case to a final stage takes the
 * group-end claim (case_set_stage, p_claim = an ender is wired) and ends
 * the submission group through 115's SubmissionGroupService.endNow. A
 * successful (or already completed) end is finished with the claim token;
 * anything else releases it for a retry. setStage never throws once the
 * stage has moved: a failed end is reported as END_FAILED.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EndResult } from '@/lib/submission-groups/service';

import {
  CASE_REFUSALS,
  FINAL_STAGES,
  type Case,
  type CaseAuditRow,
  type CaseBank,
  type CaseHistory,
  type CasePriority,
  type CaseRefusal,
  type CaseRole,
  type GroupEndReason,
} from './types';

export class CaseRefusedError extends Error {
  override readonly name = 'CaseRefusedError';
  constructor(readonly reason: CaseRefusal) {
    super(`case refused: ${reason}`);
  }
}

/** A failed case RPC or read that is not a refusal; no database text. */
export class CaseStoreError extends Error {
  override readonly name = 'CaseStoreError';
  constructor(
    readonly fn: string,
    readonly code: string | null
  ) {
    super(`cases: ${fn} failed`);
  }
}

export interface GroupEnder {
  endNow(groupId: string, reason: string): Promise<EndResult>;
}

export interface CaseStoreDeps {
  /** 115's service for the case's account; without it no claim is taken. */
  ender?: GroupEnder;
}

/** `end` is the ender's answer when endNow ran and returned. */
export interface GroupEndOutcome {
  groupEnded: boolean;
  reason: GroupEndReason;
  end: EndResult | null;
}

export interface StageResult {
  moved: boolean;
  fromStage: string;
  toStage: string;
  outcome: string | null;
  /** NULL when the call did not concern a group end. */
  groupEnd: GroupEndOutcome | null;
}

export interface PendingGroupEnd {
  caseId: string;
  accountId: string;
  groupId: string;
}

/** A claim older than this belongs to a process that died mid-end. */
export const GROUP_END_STALE = '15 minutes';
/** viewCases sends at most this many distinct ids. */
export const VIEW_CASES_MAX = 200;

const REFUSALS = new Set<string>(CASE_REFUSALS);
const CLAIM_STATES = new Set<string>([
  'NOT_FINAL',
  'ALREADY_ENDED',
  'CLAIM_HELD',
]);

const CASE_COLUMNS =
  'id, account_id, group_id, bank_code, product, amount::text, agent_id, coordinator_id, stage, priority, due_at, sla_state, opened_at, closed_at, outcome, group_ended_at';

type Row = Record<string, unknown>;
type DbError = { message?: string; code?: string; hint?: string | null };

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(String(v));
const rows = (data: unknown): Row[] =>
  Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [];
/** A `setof uuid` comes back as strings or as one-key objects. */
const scalars = (data: unknown): string[] =>
  Array.isArray(data)
    ? data.map((x) =>
        String(x !== null && typeof x === 'object' ? Object.values(x)[0] : x)
      )
    : [];

function fail(fn: string, error: DbError): never {
  if (typeof error.hint === 'string' && REFUSALS.has(error.hint))
    throw new CaseRefusedError(error.hint as CaseRefusal);
  throw new CaseStoreError(fn, error.code ?? null);
}

export class CaseStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly deps: CaseStoreDeps = {}
  ) {}

  private async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) fail(fn, error);
    return data as unknown;
  }

  private async one(fn: string, args: Record<string, unknown>): Promise<Row> {
    const row = rows(await this.rpc(fn, args))[0];
    if (!row) throw new CaseStoreError(fn, null);
    return row;
  }

  private async select(
    table: string,
    columns: string,
    filters: Record<string, string>
  ): Promise<Row | null> {
    let q = this.db.from(table).select(columns);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q.maybeSingle();
    if (error) throw new CaseStoreError(table, error.code ?? null);
    return (data as Row | null) ?? null;
  }

  private async list(table: string, columns: string, caseId: string) {
    const { data, error } = await this.db
      .from(table)
      .select(columns)
      .eq('case_id', caseId)
      .order('id', { ascending: true });
    if (error) throw new CaseStoreError(table, error.code ?? null);
    return rows(data);
  }

  /** The case with its group's ref and contact, or null. No access decision. */
  async get(caseId: string): Promise<Case | null> {
    const c = await this.select('cases', CASE_COLUMNS, { id: caseId });
    if (!c) return null;
    const accountId = String(c.account_id);
    const bankCode = str(c.bank_code);
    const [group, bank] = await Promise.all([
      this.select('submission_groups', 'submission_ref, contact_id', {
        id: String(c.group_id),
      }),
      bankCode
        ? this.select('case_banks', 'name', {
            account_id: accountId,
            code: bankCode,
          })
        : Promise.resolve(null),
    ]);
    const contactId = str(group?.contact_id);
    const contact = contactId
      ? await this.select('contacts', 'name', { id: contactId })
      : null;
    return {
      id: String(c.id),
      accountId,
      groupId: String(c.group_id),
      submissionRef: str(group?.submission_ref),
      contactId,
      contactName: str(contact?.name),
      bankCode,
      bankName: str(bank?.name),
      product: str(c.product),
      amount: str(c.amount),
      agentId: String(c.agent_id),
      coordinatorId: str(c.coordinator_id),
      stage: String(c.stage),
      priority: String(c.priority) as CasePriority,
      dueAt: date(c.due_at),
      slaState: str(c.sla_state),
      openedAt: date(c.opened_at)!,
      closedAt: date(c.closed_at),
      outcome: str(c.outcome),
      groupEndedAt: date(c.group_ended_at),
    };
  }

  /** The user's live role on the case (any workspace: see the header). */
  async role(caseId: string, userId: string): Promise<CaseRole | null> {
    const data = await this.rpc('case_role', {
      p_case: caseId,
      p_user: userId,
    });
    return (str(data) as CaseRole | null) ?? null;
  }

  /** Idempotent per group; actor NULL is the v1 API, else an owner/admin. */
  async open(
    groupId: string,
    details: {
      bankCode?: string | null;
      bankName?: string | null;
      product?: string | null;
      amount?: string | null;
    },
    actor: string | null
  ): Promise<{ caseId: string; created: boolean }> {
    const row = await this.one('case_open', {
      p_group: groupId,
      p_bank_code: details.bankCode ?? null,
      p_bank_name: details.bankName ?? null,
      p_product: details.product ?? null,
      p_amount: details.amount ?? null,
      p_actor: actor,
    });
    return { caseId: String(row.case_id), created: row.created === true };
  }

  /** Sets the given details (absent = unchanged); returns the changed fields. */
  async setDetails(
    caseId: string,
    actor: string,
    details: {
      bankCode?: string | null;
      product?: string | null;
      amount?: string | null;
    }
  ): Promise<string[]> {
    const data = await this.rpc('case_set_details', {
      p_case: caseId,
      p_actor: actor,
      p_bank_code: details.bankCode ?? null,
      p_product: details.product ?? null,
      p_amount: details.amount ?? null,
    });
    return Array.isArray(data) ? data.map(String) : [];
  }

  async setPriority(
    caseId: string,
    actor: string,
    priority: CasePriority
  ): Promise<boolean> {
    const data = await this.rpc('case_set_priority', {
      p_case: caseId,
      p_actor: actor,
      p_priority: priority,
    });
    return data === true;
  }

  /** NULL clears the due date. */
  async setDue(
    caseId: string,
    actor: string,
    dueAt: Date | null
  ): Promise<boolean> {
    const data = await this.rpc('case_set_due', {
      p_case: caseId,
      p_actor: actor,
      p_due_at: dueAt ? dueAt.toISOString() : null,
    });
    return data === true;
  }

  async setStage(
    caseId: string,
    actor: string,
    toStage: string,
    outcome?: string | null
  ): Promise<StageResult> {
    const wired = Boolean(this.deps.ender);
    const row = await this.one('case_set_stage', {
      p_case: caseId,
      p_actor: actor,
      p_to_stage: toStage,
      p_outcome: outcome ?? null,
      p_claim: wired,
    });
    const moved = row.moved === true;
    const to = String(row.to_stage);
    let groupEnd: GroupEndOutcome | null = null;
    if (row.end_group === true)
      groupEnd = await this.endGroup(caseId, to, str(row.claim_token));
    else if (!wired && moved && FINAL_STAGES.includes(to))
      groupEnd = { groupEnded: false, reason: 'NO_DEPS', end: null };
    return {
      moved,
      fromStage: String(row.from_stage),
      toStage: to,
      outcome: str(row.outcome),
      groupEnd,
    };
  }

  /** A person's retry of a final-stage case's group end. */
  async retryGroupEnd(caseId: string, actor: string) {
    if (!this.deps.ender) return this.noDeps();
    return this.claimAndEnd(caseId, 'case_claim_group_end', {
      p_case: caseId,
      p_actor: actor,
      p_stale_after: GROUP_END_STALE,
    });
  }

  /** The cron's retry (no actor). */
  async retryGroupEndSystem(caseId: string) {
    if (!this.deps.ender) return this.noDeps();
    return this.claimAndEnd(caseId, 'case_claim_group_end_system', {
      p_case: caseId,
      p_stale_after: GROUP_END_STALE,
    });
  }

  private noDeps(): GroupEndOutcome {
    return { groupEnded: false, reason: 'NO_DEPS', end: null };
  }

  private async claimAndEnd(
    caseId: string,
    fn: string,
    args: Record<string, unknown>
  ): Promise<GroupEndOutcome> {
    const row = await this.one(fn, args);
    if (row.claimed !== true) {
      const state = String(row.state);
      return {
        groupEnded: false,
        reason: CLAIM_STATES.has(state)
          ? (state as GroupEndReason)
          : 'CLAIM_HELD',
        end: null,
      };
    }
    return this.endGroup(caseId, String(row.stage), str(row.claim_token));
  }

  /**
   * Run only by the claim holder, with its token exactly as Postgres sent
   * it (a Date would drop the microseconds and never match again). Finish
   * on an end (or a group found already ENDED), release otherwise; release
   * and finish act only while the claim is still this token's.
   */
  private async endGroup(
    caseId: string,
    finalStage: string,
    token: string | null
  ): Promise<GroupEndOutcome> {
    const ender = this.deps.ender;
    let reason: GroupEndReason;
    let end: EndResult | null = null;
    try {
      const c = await this.select('cases', 'group_id', { id: caseId });
      if (!ender) {
        reason = 'NO_DEPS';
      } else if (!c) {
        reason = 'NO_GROUP';
      } else {
        const groupId = String(c.group_id);
        end = await ender.endNow(groupId, `CASE_${finalStage.toUpperCase()}`);
        if (end.ended) {
          reason = 'ENDED';
        } else {
          const g = await this.select('submission_groups', 'status', {
            id: groupId,
          });
          reason = g?.status === 'ENDED' ? 'ALREADY_ENDED' : 'NOT_DUE';
        }
        if (reason !== 'NOT_DUE') {
          await this.rpc('case_finish_group_end', {
            p_case: caseId,
            p_token: token,
          });
          return { groupEnded: reason === 'ENDED', reason, end };
        }
      }
    } catch {
      reason = 'END_FAILED';
    }
    // A failed release leaves a claim the sweeper takes once it is stale.
    await this.rpc('case_release_group_end', {
      p_case: caseId,
      p_token: token,
    }).catch(() => undefined);
    return { groupEnded: false, reason, end };
  }

  /** Final-stage cases whose end is unfinished and claim free or stale, all accounts. */
  async pendingGroupEnd(limit = 100): Promise<PendingGroupEnd[]> {
    const data = await this.rpc('case_pending_group_end', {
      p_stale_after: GROUP_END_STALE,
      p_limit: limit,
    });
    return rows(data).map((r) => ({
      caseId: String(r.case_id),
      accountId: String(r.account_id),
      groupId: String(r.group_id),
    }));
  }

  async reassign(
    caseId: string,
    actor: string,
    field: 'agent' | 'coordinator',
    toUser: string
  ): Promise<{ changed: boolean; fromUser: string | null; toUser: string }> {
    const row = await this.one('case_reassign', {
      p_case: caseId,
      p_actor: actor,
      p_field: field,
      p_to_user: toUser,
    });
    return {
      changed: row.changed === true,
      fromUser: str(row.from_user),
      toUser: String(row.to_user),
    };
  }

  /**
   * Records views (view_case audits each readable case once, unless the
   * viewer is its agent) and returns the readable ids in request order.
   * Duplicates collapse; at most VIEW_CASES_MAX distinct ids are sent.
   */
  async viewCases(actor: string, caseIds: readonly string[]) {
    const ids = [...new Set(caseIds)].slice(0, VIEW_CASES_MAX);
    if (ids.length === 0) return [];
    const readable = new Set(
      scalars(await this.rpc('view_case', { p_actor: actor, p_case_ids: ids }))
    );
    return ids.filter((id) => readable.has(id));
  }

  /** case_view_audit through its only reader (admin / super_admin). */
  async auditList(
    actor: string,
    caseId: string,
    limit?: number
  ): Promise<CaseAuditRow[]> {
    const data = await this.rpc('case_audit_list', {
      p_actor: actor,
      p_case: caseId,
      p_limit: limit ?? null,
    });
    return rows(data).map((r) => ({
      id: String(r.id),
      caseId: String(r.case_id),
      viewerId: String(r.viewer_id),
      viewerRole: String(r.viewer_role),
      viewedAt: date(r.viewed_at)!,
    }));
  }

  /** The submission app's final status (the group is already ended by 115). */
  async applySubmissionStatus(
    groupId: string,
    status: string
  ): Promise<boolean> {
    const data = await this.rpc('case_apply_submission_status', {
      p_group: groupId,
      p_status: status,
    });
    return data === true;
  }

  async history(caseId: string): Promise<CaseHistory> {
    const [stages, reassignments, details] = await Promise.all([
      this.list(
        'case_stage_history',
        'id, from_stage, to_stage, outcome, actor_id, actor_role, changed_at',
        caseId
      ),
      this.list(
        'case_reassign_history',
        'id, field, from_user, to_user, actor_id, actor_role, changed_at',
        caseId
      ),
      this.list(
        'case_detail_log',
        'id, field, from_value, to_value, actor_id, actor_role, changed_at',
        caseId
      ),
    ]);
    return {
      stages: stages.map((h) => ({
        id: String(h.id),
        fromStage: str(h.from_stage),
        toStage: String(h.to_stage),
        outcome: str(h.outcome),
        actorId: str(h.actor_id),
        actorRole: String(h.actor_role),
        changedAt: date(h.changed_at)!,
      })),
      reassignments: reassignments.map((h) => ({
        id: String(h.id),
        field: h.field as 'agent' | 'coordinator',
        fromUser: str(h.from_user),
        toUser: String(h.to_user),
        actorId: String(h.actor_id),
        actorRole: String(h.actor_role),
        changedAt: date(h.changed_at)!,
      })),
      details: details.map((h) => ({
        id: String(h.id),
        field: h.field as CaseHistory['details'][number]['field'],
        fromValue: str(h.from_value),
        toValue: str(h.to_value),
        actorId: str(h.actor_id),
        actorRole: String(h.actor_role),
        changedAt: date(h.changed_at)!,
      })),
    };
  }

  /** The (account, bank) stage list; the defaults for NULL or an unlisted bank. */
  async stagesFor(accountId: string, bankCode: string | null) {
    const data = await this.rpc('case_stages_for_bank', {
      p_account: accountId,
      p_bank_code: bankCode,
    });
    return Array.isArray(data) ? data.map(String) : [];
  }

  async upsertBank(
    actor: string,
    accountId: string,
    code: string,
    name: string
  ): Promise<CaseBank> {
    const row = await this.one('case_bank_upsert', {
      p_actor: actor,
      p_account: accountId,
      p_code: code,
      p_name: name,
    });
    return {
      accountId: String(row.account_id),
      code: String(row.code),
      name: String(row.name),
    };
  }

  /** Replaces the list (empty = back to the defaults); returns the count stored. */
  async setStages(
    actor: string,
    accountId: string,
    bankCode: string,
    stages: readonly string[]
  ): Promise<number> {
    const data = await this.rpc('case_bank_stages_set', {
      p_actor: actor,
      p_account: accountId,
      p_bank_code: bankCode,
      p_stages: [...stages],
    });
    return Number(data ?? 0);
  }
}
