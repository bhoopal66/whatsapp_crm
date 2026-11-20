/**
 * "My worklist" (release 029c): one ranked list per person of what needs
 * action next, built from reads the app already makes (`load.ts`): open
 * HR chats, overdue HR tasks, the recruiter no-activity rule, pending HR
 * agent drafts and the case inbox. No API route, no migration: RLS and
 * the case inbox's own access rules decide what is ranked at all.
 *
 * Pure. HR chats are scored by hire fast's `scoreCandidate`
 * (`lib/hr/hirefast.ts`), so the two screens can never disagree; the
 * case and draft components are 029c's own. An item carries no names
 * and no message or draft text: the page shows a fixed label
 * (`worklistKindKey`) plus `ref`, the id's first 8 characters.
 */
import { hasMinRole, isBankGuest, type AccountRole } from '@/lib/auth/roles';
import type { InboxRow } from '@/lib/cases/ui';
import {
  HIREFAST_WEIGHTS,
  overdueConversationIds,
  reasonLabelKey,
  scoreCandidate,
  stalledAfterHours,
  type HireFastReason,
  type HireFastSource,
} from '@/lib/hr/hirefast';
import { HR_INBOX_PATHS } from '@/lib/hr/routes';
import type { HrInbox, HrRule } from '@/lib/hr/types';

/** Hire fast's weights plus the 029c case and agent-draft components. */
export const WORKLIST_WEIGHTS = {
  ...HIREFAST_WEIGHTS,
  slaOverdue: 80,
  slaDueSoon: 40,
  docsMissing: 25,
  draftWaiting: 60,
  draftOld: 10,
  draftOldHours: 24,
} as const;

export type WorklistKind = 'hr_conversation' | 'case' | 'agent_draft';
export const WORKLIST_OWN_REASONS = [
  'sla_overdue',
  'sla_due_soon',
  'docs_missing',
  'draft_waiting',
  'draft_old',
] as const;
export type WorklistOwnReason = (typeof WORKLIST_OWN_REASONS)[number];
export type WorklistReason = HireFastReason | WorklistOwnReason;

/** One open `hr_conversations` row; `ownerId` is the chat's assignee. */
export interface WorklistHrConversation extends HireFastSource {
  /** `conversations.assigned_agent_id` (an auth user id); null: unassigned. */
  ownerId: string | null;
}

/** An open HR task as read for the overdue check. */
export interface WorklistHrTask {
  status: string;
  due_at: string | null;
  source_ref: string | null;
}

/** One `hr_agent_drafts` row (no body), its chat's inbox and assignee. */
export interface WorklistDraft {
  id: string;
  conversation_id: string;
  status: string;
  created_at: string;
  /** The chat's HR inbox when known (drafts are recruiter-only today). */
  inbox: HrInbox | null;
  /** The chat's assignee (auth user id); null: unassigned. */
  ownerId: string | null;
}

/** The case inbox columns the ranking reads (GET /api/cases rows). */
export type WorklistCase = Pick<
  InboxRow,
  | 'caseId'
  | 'slaState'
  | 'documentsMissing'
  | 'openTaskOverdueCount'
  | 'agentId'
  | 'coordinatorId'
>;

export type WorklistRule = Pick<HrRule, 'key' | 'enabled' | 'after_hours'>;

export interface WorklistInputs {
  hrConversations: readonly WorklistHrConversation[];
  hrTasks: readonly WorklistHrTask[];
  cases: readonly WorklistCase[];
  drafts: readonly WorklistDraft[];
  hrRules: readonly WorklistRule[];
}

export interface WorklistItem {
  kind: WorklistKind;
  id: string;
  /** The short reference the title shows (first 8 characters of the id). */
  ref: string;
  /** The existing screen the row opens. */
  href: string;
  score: number;
  reasons: WorklistReason[];
  /** Auth user ids the item is assigned to; empty: unassigned. */
  assignees: string[];
}

/**
 * own: a person sees only items assigned to them. all: team leaders and
 * up, narrowed by an "assigned to" filter. none: a bank guest (or no
 * role yet) gets nothing.
 */
export type WorklistMode = 'own' | 'all' | 'none';

export interface WorklistScope {
  /** The viewer's auth user id. */
  userId: string;
  role: AccountRole | null;
  /** All mode only: show the items assigned to this auth user id. */
  assignedTo?: string | null;
}

export function worklistMode(role: AccountRole | null): WorklistMode {
  if (role === null || isBankGuest(role)) return 'none';
  return hasMinRole(role, 'team_leader') ? 'all' : 'own';
}

const HOUR = 3_600_000;
const refOf = (id: string) => id.slice(0, 8);

/** The HR screen that opens one chat of an inbox. */
export function hrChatHref(inbox: HrInbox, conversationId: string): string {
  return `${HR_INBOX_PATHS[inbox]}?c=${encodeURIComponent(conversationId)}`;
}

export function caseHref(caseId: string): string {
  return `/cases/${encodeURIComponent(caseId)}`;
}

function scoreConversation(
  c: WorklistHrConversation,
  now: number,
  overdue: ReadonlySet<string>,
  stalledAfter: number | null
): WorklistItem {
  // The no-activity rule is the recruiter inbox's; a dept chat never stalls.
  const item = scoreCandidate(
    c,
    now,
    overdue,
    c.inbox === 'recruiter' ? stalledAfter : null
  );
  return {
    kind: 'hr_conversation',
    id: c.conversation_id,
    ref: refOf(c.conversation_id),
    href: hrChatHref(c.inbox, c.conversation_id),
    score: item.score,
    reasons: item.reasons,
    assignees: c.ownerId ? [c.ownerId] : [],
  };
}

/** A case is listed only when something on it needs action. */
function scoreCase(r: WorklistCase): WorklistItem | null {
  const W = WORKLIST_WEIGHTS;
  const reasons: WorklistReason[] = [];
  let score = 0;
  if (r.slaState === 'overdue') {
    score += W.slaOverdue;
    reasons.push('sla_overdue');
  } else if (r.slaState === 'due_soon') {
    score += W.slaDueSoon;
    reasons.push('sla_due_soon');
  }
  if (r.documentsMissing > 0) {
    score += W.docsMissing;
    reasons.push('docs_missing');
  }
  if (r.openTaskOverdueCount > 0) {
    score += W.taskOverdue;
    reasons.push('task_overdue');
  }
  if (reasons.length === 0) return null;
  const assignees = [r.agentId, r.coordinatorId].filter(
    (id, i, all): id is string => id !== null && all.indexOf(id) === i
  );
  return {
    kind: 'case',
    id: r.caseId,
    ref: refOf(r.caseId),
    href: caseHref(r.caseId),
    score,
    reasons,
    assignees,
  };
}

function scoreDraft(
  d: WorklistDraft,
  now: number,
  conv: WorklistHrConversation | undefined
): WorklistItem {
  const W = WORKLIST_WEIGHTS;
  const reasons: WorklistReason[] = ['draft_waiting'];
  let score = W.draftWaiting;
  const created = Date.parse(d.created_at);
  if (Number.isFinite(created) && now - created > W.draftOldHours * HOUR) {
    score += W.draftOld;
    reasons.push('draft_old');
  }
  const owner = conv ? conv.ownerId : d.ownerId;
  return {
    kind: 'agent_draft',
    id: d.id,
    ref: refOf(d.id),
    href: hrChatHref(conv?.inbox ?? d.inbox ?? 'recruiter', d.conversation_id),
    score,
    reasons,
    assignees: owner ? [owner] : [],
  };
}

/**
 * The ranked worklist: scores every input, keeps what the scope may see
 * (own: assigned to me; all: everyone, narrowed by `assignedTo` when
 * set; none: nothing), sorts by score desc, then id, then kind.
 */
export function rankWorklist(
  inputs: WorklistInputs,
  now: number,
  scope: WorklistScope
): WorklistItem[] {
  const mode = worklistMode(scope.role);
  if (mode === 'none') return [];
  const overdue = overdueConversationIds([...inputs.hrTasks], now);
  const stalled = stalledAfterHours([...inputs.hrRules]);
  const convs = new Map(
    inputs.hrConversations.map((c) => [c.conversation_id, c])
  );
  const items: WorklistItem[] = [
    ...inputs.hrConversations
      .filter((c) => c.closed_at === null)
      .map((c) => scoreConversation(c, now, overdue, stalled)),
    ...inputs.cases.map(scoreCase).filter((x): x is WorklistItem => x !== null),
    ...inputs.drafts
      .filter((d) => d.status === 'pending')
      .map((d) => scoreDraft(d, now, convs.get(d.conversation_id))),
  ];
  const who = mode === 'own' ? scope.userId : scope.assignedTo || null;
  const seen = who ? items.filter((i) => i.assignees.includes(who)) : items;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return seen.sort(
    (a, b) => b.score - a.score || cmp(a.id, b.id) || cmp(a.kind, b.kind)
  );
}

/**
 * The i18n key (full path) of a reason's label. Hire fast codes reuse
 * hire fast's labels (`Hr.hireFast.reason.*`); the rest are 029c's.
 */
export function worklistReasonLabel(
  code: WorklistReason
):
  | `Hr.hireFast.${ReturnType<typeof reasonLabelKey>}`
  | `Worklist.reason.${WorklistOwnReason}` {
  return (WORKLIST_OWN_REASONS as readonly string[]).includes(code)
    ? `Worklist.reason.${code as WorklistOwnReason}`
    : `Hr.hireFast.${reasonLabelKey(code as HireFastReason)}`;
}

/** The i18n key of a kind's title; the page passes `{ ref }`. */
export function worklistKindKey(
  kind: WorklistKind
): `Worklist.kind.${WorklistKind}` {
  return `Worklist.kind.${kind}`;
}
