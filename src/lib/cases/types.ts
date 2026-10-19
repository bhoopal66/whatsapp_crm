/**
 * Case management types (module 018c, migration 122). Names mirror the
 * SQL: stages, outcomes and priorities are 122's CHECK lists; refusals
 * are the HINTs its functions raise.
 */

/** A role on one case, resolved live by `case_role` (never stored). */
export type CaseRole =
  'super_admin' | 'admin' | 'team_lead' | 'coordinator' | 'agent';

export const CASE_ROLES: readonly CaseRole[] = [
  'super_admin',
  'admin',
  'team_lead',
  'coordinator',
  'agent',
];

/** 122's `cases_closed_when_final`: a case at one of these is closed. */
export const FINAL_STAGES: readonly string[] = [
  'Approved',
  'Declined',
  'Withdrawn',
  'Closed',
];
/** 122's `cases_outcome_valid`: the stages that set an outcome. */
export const OUTCOME_STAGES: readonly string[] = [
  'Approved',
  'Declined',
  'Withdrawn',
];

export type CasePriority = 'low' | 'normal' | 'high' | 'urgent';
export const PRIORITIES: readonly CasePriority[] = [
  'low',
  'normal',
  'high',
  'urgent',
];

export interface Case {
  id: string;
  accountId: string;
  groupId: string;
  /** From the submission group (read by join, never copied). */
  submissionRef: string | null;
  /** NULL once the contact is deleted (115 detaches the group). */
  contactId: string | null;
  contactName: string | null;
  bankCode: string | null;
  bankName: string | null;
  product: string | null;
  /** AED, decimal string ("1500.00"); NULL until the submission sends it. */
  amount: string | null;
  agentId: string;
  coordinatorId: string | null;
  stage: string;
  priority: CasePriority;
  dueAt: Date | null;
  slaState: string | null;
  openedAt: Date;
  closedAt: Date | null;
  outcome: string | null;
  groupEndedAt: Date | null;
}

export interface StageChange {
  id: string;
  fromStage: string | null;
  toStage: string;
  outcome: string | null;
  /** NULL: the v1 API (`actorRole` 'api'). */
  actorId: string | null;
  actorRole: string;
  changedAt: Date;
}

export interface Reassignment {
  id: string;
  field: 'agent' | 'coordinator';
  fromUser: string | null;
  toUser: string;
  actorId: string;
  actorRole: string;
  changedAt: Date;
}

export interface DetailChange {
  id: string;
  field: 'bank_code' | 'product' | 'amount' | 'priority' | 'due_at';
  fromValue: string | null;
  toValue: string | null;
  actorId: string | null;
  actorRole: string;
  changedAt: Date;
}

export interface CaseHistory {
  stages: StageChange[];
  reassignments: Reassignment[];
  details: DetailChange[];
}

export interface CaseAuditRow {
  id: string;
  caseId: string;
  viewerId: string;
  viewerRole: string;
  viewedAt: Date;
}

export interface CaseBank {
  accountId: string;
  code: string;
  name: string;
}

/** The HINTs 122's functions raise; anything else is a CaseStoreError. */
export const CASE_REFUSALS = [
  'CASE_NOT_FOUND',
  'NOT_ALLOWED',
  'STAGE_NOT_CONFIGURED',
  'OUTCOME_INVALID',
  'OUTCOME_STAGE_MISMATCH',
  'CASE_CLOSED',
  'FINAL_STAGE',
  'ASSIGNEE_INVALID',
  'LIMIT_INVALID',
  'BANK_STAGES_FIRST_FINAL',
  'BANK_STAGES_MISSING_FINAL',
  'BANK_STAGES_FINAL_SPELLING',
  'GROUP_NOT_FOUND',
  'NO_AGENT',
  'BANK_UNKNOWN',
  'STAGE_NOT_IN_LIST',
  'STAGE_IN_USE',
  'PRIORITY_INVALID',
  'DUE_INVALID',
] as const;
export type CaseRefusal = (typeof CASE_REFUSALS)[number];

/**
 * Why a group end did or did not happen. ENDED: endNow ended the group.
 * ALREADY_ENDED: the group was found already ended (recorded on the case).
 * NO_DEPS: no ender wired (no claim taken). NO_GROUP: the case has no
 * group row. NOT_DUE: endNow ended nothing and the group is not ENDED.
 * END_FAILED: a step threw. CLAIM_HELD: another call holds a fresh claim.
 * NOT_FINAL: the case is not at a final stage. All but ENDED /
 * ALREADY_ENDED / CLAIM_HELD leave the claim free for a retry.
 */
export type GroupEndReason =
  | 'ENDED'
  | 'ALREADY_ENDED'
  | 'NO_DEPS'
  | 'NO_GROUP'
  | 'NOT_DUE'
  | 'END_FAILED'
  | 'CLAIM_HELD'
  | 'NOT_FINAL';
