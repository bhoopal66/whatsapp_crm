/**
 * HR workflows (migration 200, `docs/hr-workflows` once written). The
 * lists here mirror 200's CHECK constraints and its rule seed:
 * `types.test.ts` reads the migration and pins every one. Change one,
 * change both. Labels live in the `Hr` i18n namespace, never here.
 *
 * Row types are the raw PostgREST shapes (snake_case), exactly as the
 * `hr_*` RPCs return them.
 */

/** The two halves of the HR inbox: candidates and employees. */
export const HR_INBOXES = ['recruiter', 'dept'] as const;
export type HrInbox = (typeof HR_INBOXES)[number];

/** Recruitment stages, in order: position is what "backward" means. */
export const HR_STAGES = [
  'cv_review',
  'ai_interview',
  'hr_interview',
  'manager_interview',
] as const;
export type HrStage = (typeof HR_STAGES)[number];

/** Department topics: one per employee conversation. */
export const HR_TOPICS = [
  'onboarding',
  'visa_documents',
  'leave_attendance',
  'payroll',
  'complaint',
  'other',
] as const;
export type HrTopic = (typeof HR_TOPICS)[number];

/** Close outcomes, recruiter only; a department chat closes with none. */
export const HR_OUTCOMES = ['hired', 'not_selected', 'withdrawn'] as const;
export type HrOutcome = (typeof HR_OUTCOMES)[number];

export const HR_FLAGS = ['urgent', 'upset'] as const;
export type HrFlag = (typeof HR_FLAGS)[number];

/**
 * Generated in SQL from the message timestamps: `new` (nothing sent
 * yet), `reply_due` (they wrote after us), `waiting` (else).
 */
export const HR_REPLY_STATES = ['new', 'reply_due', 'waiting'] as const;
export type HrReplyState = (typeof HR_REPLY_STATES)[number];

/** Team role within one inbox. Admin is not a team role: it is derived. */
export const HR_TEAM_ROLES = ['lead', 'member'] as const;
export type HrTeamRole = (typeof HR_TEAM_ROLES)[number];

/** The caller's role for one inbox, as SQL's `hr_role()` answers it. */
export type HrRole = 'admin' | HrTeamRole;

/** The 11 rules `hr_seed_rules()` seeds per account. */
export const HR_RULE_KEYS = [
  'stage_cv_review',
  'stage_ai_interview',
  'stage_hr_interview',
  'stage_manager_interview',
  'topic_payroll',
  'topic_visa_documents',
  'topic_complaint_flag',
  'topic_complaint_task',
  'reply_overdue_recruiter',
  'reply_overdue_dept',
  'no_activity_recruiter',
] as const;
export type HrRuleKey = (typeof HR_RULE_KEYS)[number];

export type HrTriggerKind = 'stage' | 'topic' | 'reply_overdue' | 'no_activity';
export type HrRuleAction = 'task' | 'set_flag';

/** The refusal hints the RPCs raise, plus UNKNOWN for anything else. */
export const HR_ERROR_CODES = [
  'NOT_ALLOWED',
  'NOT_FOUND',
  'CLOSED',
  'STAGE_UNKNOWN',
  'NEEDS_REASON',
  'INVALID',
  'UNKNOWN',
] as const;
export type HrErrorCode = (typeof HR_ERROR_CODES)[number];

/** How a chat is opened in HR: `hr_open(p_kind)`. */
export type HrOpenKind = 'candidate' | 'employee';

/** A `hr_conversations` row: one per chat. */
export interface HrConversation {
  conversation_id: string;
  account_id: string;
  inbox: HrInbox;
  /** Set (and only set) in the recruiter inbox. */
  stage_key: HrStage | null;
  /** Only in the dept inbox, and NULL until someone picks one. */
  topic: HrTopic | null;
  urgent: boolean;
  upset: boolean;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  reply_state: HrReplyState;
  outcome: HrOutcome | null;
  /** HR closure; separate from `conversations.status`. */
  closed_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

/** A `hr_workflow_rules` row. Rules create tasks or set flags, never send. */
export interface HrRule {
  account_id: string;
  key: HrRuleKey;
  inbox: HrInbox;
  trigger_kind: HrTriggerKind;
  trigger_value: string | null;
  action: HrRuleAction;
  flag: HrFlag | null;
  after_hours: number | null;
  due_hours: number | null;
  title: string | null;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** `hr_my_roles()`: admin is the live owner/admin; the rest per inbox. */
export interface HrRoles {
  admin: boolean;
  recruiter: HrTeamRole | null;
  dept: HrTeamRole | null;
}

export interface HrInboxCounts {
  all: number;
  /** Open rows in `reply_due`. */
  unread: number;
  mine: number;
  urgent: number;
}

/** `hr_counts()`, over what RLS shows the caller. */
export interface HrCounts {
  recruiter: HrInboxCounts;
  dept: HrInboxCounts;
  /** HR-department chats with no HR row yet. */
  unsorted: number;
}
