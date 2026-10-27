/**
 * The case page (/cases/[id], module 019): the shape `GET /api/cases/[id]`
 * answers, parsed defensively, and the pure rules the header, the action
 * dialogs and the tabs share. No React, no I/O: the components own those.
 */

import { FINAL_STAGES, OUTCOME_STAGES, PRIORITIES } from './types';
import { isPresubStage } from './ui';
import type { CasePriority, CaseRole } from './types';

export type SlaState = 'on_track' | 'due_soon' | 'overdue';

export interface CaseRecord {
  id: string;
  accountId: string;
  /** NULL while the case is a lead (130). */
  groupId: string | null;
  isLead: boolean;
  submissionRef: string | null;
  /** The tracker's status word for word; NULL for a lead or none sent yet. */
  submissionStatus: string | null;
  contactId: string | null;
  contactName: string | null;
  /** The linked CRM contact's own name. */
  contactOwnName: string | null;
  leadSource: string | null;
  bankCode: string | null;
  bankName: string | null;
  product: string | null;
  /** AED, decimal string ("1500.00"). */
  amount: string | null;
  agentId: string;
  coordinatorId: string | null;
  stage: string;
  priority: CasePriority;
  /** ISO timestamps from here on. */
  dueAt: string | null;
  slaState: string | null;
  openedAt: string;
  closedAt: string | null;
  outcome: string | null;
  groupEndedAt: string | null;
  /** 134: https link to the case in Compass. */
  externalUrl: string | null;
  /** 134: last sync from Compass (ISO). */
  externalChangedAt: string | null;
}

export interface CaseStageChange {
  fromStage: string | null;
  toStage: string;
  outcome: string | null;
  actorId: string | null;
  actorRole: string | null;
  changedAt: string;
}

export interface CaseReassignment {
  field: 'agent' | 'coordinator';
  fromUser: string | null;
  toUser: string | null;
  actorId: string | null;
  changedAt: string;
}

export interface CaseDetailChange {
  field: string;
  fromValue: string | null;
  toValue: string | null;
  actorId: string | null;
  changedAt: string;
}

export interface CaseTimer {
  timer: string;
  stage: string;
  startedAt: string;
  dueSoonAt: string | null;
  dueAt: string | null;
  stoppedAt: string | null;
  state: SlaState | null;
}

export interface CaseDetail {
  case: CaseRecord;
  role: CaseRole;
  permissions: {
    canWrite: boolean;
    canReassign: boolean;
    canSeeAudit: boolean;
  };
  stages: string[];
  history: {
    stages: CaseStageChange[];
    reassignments: CaseReassignment[];
    details: CaseDetailChange[];
  };
  timers: CaseTimer[];
  outcomeReason: {
    reasonCode: string;
    reasonText: string | null;
    createdAt: string;
  } | null;
  /** 134: the account's case_account_settings.managed_externally. */
  managedExternally: boolean;
  /** 134: Compass owns stage, details and documents (isManagedExternally). */
  locked: boolean;
}

/** What every tab component receives (the tab jobs build to this). */
export interface CaseTabProps {
  caseId: string;
  detail: CaseDetail;
  onChanged: () => void;
}

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const SLA_STATES: readonly string[] = ['on_track', 'due_soon', 'overdue'];
const ROLES: readonly string[] = [
  'super_admin',
  'admin',
  'team_lead',
  'coordinator',
  'agent',
];

/**
 * The case detail, or null when the body is not one (no case id, stage or
 * agent, or an unknown role). Missing lists become empty; an unknown
 * priority reads as `normal`; permissions default to false.
 */
export function parseCaseDetail(json: unknown): CaseDetail | null {
  const root = obj(json);
  const c = obj(root?.case);
  if (!root || !c) return null;
  const id = str(c.id);
  const stage = str(c.stage);
  const agentId = str(c.agentId);
  const role = str(root.role);
  if (!id || !stage || !agentId || !role || !ROLES.includes(role)) return null;
  const priority = str(c.priority);
  const perms = obj(root.permissions) ?? {};
  const history = obj(root.history) ?? {};
  const reason = obj(root.outcomeReason);

  return {
    case: {
      id,
      accountId: str(c.accountId) ?? '',
      groupId: str(c.groupId),
      isLead: !str(c.groupId),
      submissionRef: str(c.submissionRef),
      submissionStatus: str(c.submissionStatus),
      contactId: str(c.contactId),
      contactName: str(c.contactName),
      contactOwnName: str(c.contactOwnName),
      leadSource: str(c.leadSource),
      bankCode: str(c.bankCode),
      bankName: str(c.bankName),
      product: str(c.product),
      amount: str(c.amount),
      agentId,
      coordinatorId: str(c.coordinatorId),
      stage,
      priority: (PRIORITIES as readonly string[]).includes(priority ?? '')
        ? (priority as CasePriority)
        : 'normal',
      dueAt: str(c.dueAt),
      slaState: str(c.slaState),
      openedAt: str(c.openedAt) ?? '',
      closedAt: str(c.closedAt),
      outcome: str(c.outcome),
      groupEndedAt: str(c.groupEndedAt),
      externalUrl: str(c.externalUrl),
      externalChangedAt: str(c.externalChangedAt),
    },
    role: role as CaseRole,
    permissions: {
      canWrite: perms.canWrite === true,
      canReassign: perms.canReassign === true,
      canSeeAudit: perms.canSeeAudit === true,
    },
    stages: list(root.stages).filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    ),
    history: {
      stages: list(history.stages).flatMap((v) => {
        const r = obj(v);
        const to = str(r?.toStage);
        if (!r || !to) return [];
        return [
          {
            fromStage: str(r.fromStage),
            toStage: to,
            outcome: str(r.outcome),
            actorId: str(r.actorId),
            actorRole: str(r.actorRole),
            changedAt: str(r.changedAt) ?? '',
          },
        ];
      }),
      reassignments: list(history.reassignments).flatMap((v) => {
        const r = obj(v);
        if (!r || (r.field !== 'agent' && r.field !== 'coordinator')) return [];
        return [
          {
            field: r.field,
            fromUser: str(r.fromUser),
            toUser: str(r.toUser),
            actorId: str(r.actorId),
            changedAt: str(r.changedAt) ?? '',
          },
        ];
      }),
      details: list(history.details).flatMap((v) => {
        const r = obj(v);
        const field = str(r?.field);
        if (!r || !field) return [];
        return [
          {
            field,
            fromValue: str(r.fromValue),
            toValue: str(r.toValue),
            actorId: str(r.actorId),
            changedAt: str(r.changedAt) ?? '',
          },
        ];
      }),
    },
    timers: list(root.timers).flatMap((v) => {
      const r = obj(v);
      const timer = str(r?.timer);
      if (!r || !timer) return [];
      const state = str(r.state);
      return [
        {
          timer,
          stage: str(r.stage) ?? '',
          startedAt: str(r.startedAt) ?? '',
          dueSoonAt: str(r.dueSoonAt),
          dueAt: str(r.dueAt),
          stoppedAt: str(r.stoppedAt),
          state:
            state && SLA_STATES.includes(state) ? (state as SlaState) : null,
        },
      ];
    }),
    outcomeReason:
      reason && str(reason.reasonCode)
        ? {
            reasonCode: str(reason.reasonCode) as string,
            reasonText: str(reason.reasonText),
            createdAt: str(reason.createdAt) ?? '',
          }
        : null,
    managedExternally: root.managedExternally === true,
    locked: root.locked === true,
  };
}

/**
 * What the Compass lock (134) takes away on a case page. SQL refuses
 * these with MANAGED_EXTERNALLY; notes, tasks, priority, due date,
 * reassign, bank contacts, document requests and replies stay open.
 */
export interface CaseLocks {
  /** The Move stage action (and with it the outcome-reason step). */
  stage: boolean;
  /** Bank, product and amount in Edit details; priority and due stay. */
  details: boolean;
  outcomeReason: boolean;
}

export function caseLocks(d: Pick<CaseDetail, 'locked'>): CaseLocks {
  return { stage: d.locked, details: d.locked, outcomeReason: d.locked };
}

/** A document status the lock refuses: received and rejected, not requested. */
export function docStatusLocked(status: string, locked: boolean): boolean {
  return locked && (status === 'received' || status === 'rejected');
}

/** A final stage closes the case (122's `cases_closed_when_final`). */
export function isFinalStage(stage: string): boolean {
  return FINAL_STAGES.includes(stage);
}

/** Moves that carry an outcome (122's `cases_outcome_valid`). */
export function isOutcomeStage(stage: string): boolean {
  return OUTCOME_STAGES.includes(stage);
}

/** After these moves the page asks why (127's outcome reason). */
export function needsOutcomeReason(stage: string): boolean {
  return stage === 'Declined' || stage === 'Withdrawn';
}

/**
 * The stages the move dialog offers, mirroring 130's case_set_stage:
 * nothing from Closed; only Closed from Approved / Declined / Withdrawn;
 * never back to a pre-submission stage once past them (PRESUB_REENTRY);
 * and a lead (no group) leaves the pre-submission stages only to
 * Withdrawn (SUBMISSION_REQUIRED). `stages` is the case's configured list.
 */
export function allowedNextStages(
  c: Pick<CaseRecord, 'stage' | 'groupId'>,
  stages: readonly string[]
): string[] {
  if (c.stage === 'Closed') return [];
  const others = stages.filter((s) => s !== c.stage);
  if (OUTCOME_STAGES.includes(c.stage))
    return others.filter((s) => s === 'Closed');
  const pre = isPresubStage(c.stage);
  return others.filter((s) =>
    isPresubStage(s) ? pre : c.groupId !== null || s === 'Withdrawn'
  );
}

/** The stage POST body: the outcome is the stage name, and only there. */
export function stageMoveBody(stage: string): {
  stage: string;
  outcome?: string;
} {
  return isOutcomeStage(stage) ? { stage, outcome: stage } : { stage };
}

/** 130's reason codes (NO_RESPONSE: Withdrawn only); `dashboard.ts`'s OUTCOME_REASON_CODES (tested equal). */
export const OUTCOME_REASON_CODES = [
  'INCOMPLETE_DOCS',
  'CREDIT_POLICY',
  'INCOME_INSUFFICIENT',
  'KYC_AML',
  'CUSTOMER_WITHDREW',
  'OTHER',
  'NO_RESPONSE',
] as const;
export type OutcomeReasonCode = (typeof OUTCOME_REASON_CODES)[number];

/** The reasons offered after a move to `stage`: NO_RESPONSE is Withdrawn's only. */
export function outcomeReasonCodes(stage: string): OutcomeReasonCode[] {
  return OUTCOME_REASON_CODES.filter(
    (r) => r !== 'NO_RESPONSE' || stage === 'Withdrawn'
  );
}
export const OUTCOME_REASON_TEXT_MAX = 500;

export type ChipTone = 'ok' | 'warn' | 'bad' | 'muted';

/** The SLA chip's colour; an unknown or unevaluated state is muted. */
export function slaChipTone(state: string | null | undefined): ChipTone {
  if (state === 'on_track') return 'ok';
  if (state === 'due_soon') return 'warn';
  if (state === 'overdue') return 'bad';
  return 'muted';
}

/** Timers that are still running (the header shows these). */
export function runningTimers(timers: CaseTimer[]): CaseTimer[] {
  return timers.filter((t) => t.stoppedAt === null);
}

/** What a final move did to the WhatsApp group, for the move dialog. */
export type GroupEndView = 'ended' | 'pending' | 'failed';

export function groupEndView(groupEnd: unknown): GroupEndView | null {
  const g = obj(groupEnd);
  if (!g || g.reason === 'NO_GROUP') return null;
  const end = obj(g.end);
  if (end && typeof end.closeError === 'string' && end.closeError)
    return 'failed';
  if (g.groupEnded === true)
    return end && (end.closeDeferred === true || end.closed === false)
      ? 'pending'
      : 'ended';
  if (g.reason === 'ALREADY_ENDED') return 'ended';
  if (g.reason === 'END_FAILED') return 'failed';
  return 'pending';
}

// Result code -> message key (CasePage.errors.* / CasePage.docs.*).

const STAGE_ERRORS: Record<string, string> = {
  STAGE_NOT_CONFIGURED: 'stageNotConfigured',
  OUTCOME_INVALID: 'outcomeInvalid',
  OUTCOME_STAGE_MISMATCH: 'outcomeInvalid',
  CASE_CLOSED: 'caseClosed',
  FINAL_STAGE: 'finalStage',
  NOT_ALLOWED: 'notAllowed',
  PRESUB_REENTRY: 'presubReentry',
  SUBMISSION_REQUIRED: 'submissionRequired',
  MANAGED_EXTERNALLY: 'managedExternally',
};
const DETAIL_ERRORS: Record<string, string> = {
  BANK_UNKNOWN: 'bankUnknown',
  LEAD_INVALID: 'leadBankTaken',
  STAGE_NOT_IN_LIST: 'stageNotInList',
  PRIORITY_INVALID: 'priorityInvalid',
  DUE_INVALID: 'dueInvalid',
  CASE_CLOSED: 'caseClosed',
  NOT_ALLOWED: 'notAllowed',
  MANAGED_EXTERNALLY: 'managedExternally',
};
const REASON_ERRORS: Record<string, string> = {
  REASON_INVALID: 'reasonInvalid',
  REASON_TEXT_TOO_LONG: 'reasonTooLong',
  OUTCOME_NOT_DECLINED: 'reasonNotDeclined',
  OUTCOME_REASON: 'reasonNoResponseWithdrawn',
  REASON_ALREADY_SET: 'reasonAlreadySet',
  MANAGED_EXTERNALLY: 'managedExternally',
};
const REASSIGN_ERRORS: Record<string, string> = {
  ASSIGNEE_INVALID: 'assigneeInvalid',
  CASE_CLOSED: 'caseClosed',
  NOT_ALLOWED: 'notAllowed',
};
const DOC_RESULTS: Record<string, string> = {
  NOTHING_MISSING: 'nothingMissing',
  BLOCKED: 'blocked',
  REFUSED: 'refused',
  SEND_FAILED: 'sendFailed',
  SEND_RATE_LIMITED: 'rateLimited',
};

const pick =
  (map: Record<string, string>) =>
  (status: number, code: unknown): string => {
    if (typeof code === 'string' && map[code]) return map[code];
    if (status === 403) return 'notAllowed';
    if (status === 404) return 'notFound';
    return 'unknown';
  };

export const stageErrorKey = pick(STAGE_ERRORS);
export const detailsErrorKey = pick(DETAIL_ERRORS);
export const reasonErrorKey = pick(REASON_ERRORS);
export const reassignErrorKey = pick(REASSIGN_ERRORS);

/** CasePage.docs.* for a document request that was not sent. */
export function docRequestKey(
  status: number,
  code: unknown,
  refusal?: unknown
): string {
  // 136: a submission opened without a WhatsApp group has nowhere to send.
  if (code === 'REFUSED' && refusal === 'NO_WHATSAPP_GROUP')
    return 'noWhatsappGroup';
  if (typeof code === 'string' && DOC_RESULTS[code]) return DOC_RESULTS[code];
  if (status === 429) return 'rateLimited';
  return 'sendFailed';
}

/**
 * Take over stays disabled until the hand-over template is approved
 * (the route answers 409 TEMPLATE_NOT_APPROVED). Flip this once it is;
 * the click handler already treats that 409 as "still awaiting approval".
 */
export const TAKEOVER_TEMPLATE_APPROVED = false;

export function takeoverNotApproved(status: number, code: unknown): boolean {
  return status === 409 && code === 'TEMPLATE_NOT_APPROVED';
}

/** Roles that may take the conversation over (the server decides). */
export function canTakeOver(role: CaseRole): boolean {
  return role === 'coordinator' || role === 'team_lead';
}

// Tabs: `?tab=` holds the URL name; Overview is the bare URL.

export const CASE_TABS = [
  'overview',
  'timeline',
  'conversation',
  'tasks',
  'documents',
  'notes',
  'bank-contacts',
  'memory',
  'audit',
] as const;
export type CaseTab = (typeof CASE_TABS)[number];

export function visibleCaseTabs(canSeeAudit: boolean): CaseTab[] {
  return CASE_TABS.filter((t) => t !== 'audit' || canSeeAudit);
}

/** Tabs a lead (130, no group yet) shows but cannot open. */
export function caseTabDisabled(tab: CaseTab, isLead: boolean): boolean {
  return isLead && tab === 'conversation';
}

/**
 * A `?tab=` value, falling back to Overview when unknown, not shown, or
 * disabled for a lead.
 */
export function resolveCaseTab(
  raw: string | null | undefined,
  canSeeAudit: boolean,
  isLead = false
): CaseTab {
  const tabs = visibleCaseTabs(canSeeAudit).filter(
    (t) => !caseTabDisabled(t, isLead)
  );
  return (tabs as readonly string[]).includes(raw ?? '')
    ? (raw as CaseTab)
    : 'overview';
}

/**
 * A `<input type="datetime-local">` value for an ISO time, in the
 * viewer's zone ('' for none), and back (null for '' or invalid).
 */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A decimal amount the PATCH accepts: digits with up to two decimals. */
export function normaliseAmount(raw: string): string | null {
  const v = raw.replace(/[,\s]/g, '');
  return /^\d+(\.\d{1,2})?$/.test(v) ? v : null;
}
