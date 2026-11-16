/**
 * "Hire fast" (`/hr-inbox/hire-fast`, release 024b/024c-2): open
 * Recruitment candidates ranked by who needs action next. Read only and
 * pure: the page reads `hr_conversations`, overdue HR tasks and the
 * `no_activity_recruiter` rule through the user's RLS client, and this
 * scores what came back. No migration, no new SQL: RLS decides which
 * chats are ranked at all.
 */
import { HR_TASK_REF_PREFIX } from './tasks-view';
import type { HrConversation, HrReplyState, HrRule, HrStage } from './types';

/** The public reason codes, in the order a row lists them. */
export const HIREFAST_REASONS = [
  'reply_due',
  'urgent',
  'upset',
  'waiting_long',
  'late_stage',
  'task_overdue',
  'stalled',
] as const;
export type HireFastReason = (typeof HIREFAST_REASONS)[number];

/** Score components. */
export const HIREFAST_WEIGHTS = {
  replyDue: 100,
  waitingOnThem: 10,
  urgent: 50,
  upset: 30,
  waitedCapHours: 72,
  taskOverdue: 20,
  stalled: 20,
  waitingLongHours: 24,
} as const;

/** Later stages weigh more so near-final candidates are not left waiting. */
export const HIREFAST_STAGE_WEIGHT: Record<HrStage, number> = {
  cv_review: 0,
  ai_interview: 5,
  hr_interview: 10,
  manager_interview: 15,
};
const LATE_STAGE_MIN = 10;

/** The `hr_conversations` columns the ranking reads. */
export type HireFastSource = Pick<
  HrConversation,
  | 'conversation_id'
  | 'inbox'
  | 'stage_key'
  | 'urgent'
  | 'upset'
  | 'reply_state'
  | 'last_inbound_at'
  | 'last_outbound_at'
  | 'closed_at'
  | 'created_at'
>;

export interface HireFastItem {
  conversationId: string;
  stageKey: HrStage | null;
  replyState: HrReplyState;
  urgent: boolean;
  upset: boolean;
  lastInboundAt: string | null;
  /** Hours the candidate has waited on us; 0 when we wait on them. */
  waitingHours: number;
  score: number;
  reasons: HireFastReason[];
}

const HOUR = 3_600_000;

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function hoursSince(t: number | null, now: number): number {
  return t === null ? 0 : Math.max(0, Math.floor((now - t) / HOUR));
}

/**
 * The stalled threshold: the `no_activity_recruiter` rule's after_hours
 * while that rule is enabled; null (nothing is stalled) otherwise.
 */
export function stalledAfterHours(
  rules: Pick<HrRule, 'key' | 'enabled' | 'after_hours'>[]
): number | null {
  const rule = rules.find((r) => r.key === 'no_activity_recruiter');
  return rule && rule.enabled && rule.after_hours !== null
    ? rule.after_hours
    : null;
}

/**
 * The chats with an open HR task past its due time. An HR task's
 * `source_ref` is `hr:<conversation id>:<rule>:<event>`.
 */
export function overdueConversationIds(
  tasks: {
    status: string;
    due_at: string | null;
    source_ref: string | null;
  }[],
  now: number
): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) {
    if (t.status !== 'open' || !t.source_ref?.startsWith(HR_TASK_REF_PREFIX))
      continue;
    const due = ms(t.due_at);
    if (due === null || due >= now) continue;
    const id = t.source_ref.slice(HR_TASK_REF_PREFIX.length).split(':')[0];
    if (id) out.add(id);
  }
  return out;
}

/** Scores one open recruiter conversation. */
export function scoreCandidate(
  c: HireFastSource,
  now: number,
  overdue: ReadonlySet<string>,
  stalledAfter: number | null
): HireFastItem {
  const W = HIREFAST_WEIGHTS;
  const reasons: HireFastReason[] = [];
  const onUs = c.reply_state === 'reply_due' || c.reply_state === 'new';
  const inbound = ms(c.last_inbound_at);
  const created = ms(c.created_at);
  // The candidate waits on us from their last message (none yet: from
  // the row's creation).
  const waitingHours = onUs ? hoursSince(inbound ?? created, now) : 0;
  let score = 0;
  if (onUs) {
    score += W.replyDue;
    reasons.push('reply_due');
  } else score += W.waitingOnThem;
  if (c.urgent) {
    score += W.urgent;
    reasons.push('urgent');
  }
  if (c.upset) {
    score += W.upset;
    reasons.push('upset');
  }
  score += Math.min(waitingHours, W.waitedCapHours);
  if (waitingHours >= W.waitingLongHours) reasons.push('waiting_long');
  const sw =
    c.stage_key && Object.hasOwn(HIREFAST_STAGE_WEIGHT, c.stage_key)
      ? HIREFAST_STAGE_WEIGHT[c.stage_key]
      : 0;
  score += sw;
  if (sw >= LATE_STAGE_MIN) reasons.push('late_stage');
  if (overdue.has(c.conversation_id)) {
    score += W.taskOverdue;
    reasons.push('task_overdue');
  }
  if (!onUs && stalledAfter !== null) {
    const times = [inbound, ms(c.last_outbound_at), created].filter(
      (t): t is number => t !== null
    );
    const last = times.length > 0 ? Math.max(...times) : null;
    if (last !== null && hoursSince(last, now) > stalledAfter) {
      score += W.stalled;
      reasons.push('stalled');
    }
  }
  return {
    conversationId: c.conversation_id,
    stageKey: c.stage_key,
    replyState: c.reply_state,
    urgent: c.urgent,
    upset: c.upset,
    lastInboundAt: c.last_inbound_at,
    waitingHours,
    score,
    reasons,
  };
}

/**
 * Drops closed and non-recruiter rows, scores, sorts (score desc, last
 * inbound oldest first with none last, then conversation id), limits.
 */
export function rankCandidates(
  rows: HireFastSource[],
  now: number,
  overdue: ReadonlySet<string>,
  stalledAfter: number | null,
  limit = 50
): HireFastItem[] {
  const t = (iso: string | null) => ms(iso) ?? Number.POSITIVE_INFINITY;
  return rows
    .filter((c) => c.inbox === 'recruiter' && c.closed_at === null)
    .map((c) => scoreCandidate(c, now, overdue, stalledAfter))
    .sort(
      (a, b) =>
        b.score - a.score ||
        t(a.lastInboundAt) - t(b.lastInboundAt) ||
        (a.conversationId < b.conversationId
          ? -1
          : a.conversationId > b.conversationId
            ? 1
            : 0)
    )
    .slice(0, limit);
}

// ---------------------------------------------------------------- view

/** One `hr_conversations` row as the page selects it, chat embedded. */
export interface HireFastRow extends HireFastSource {
  chat: {
    assigned_agent_id: string | null;
    contact: { name: string | null; phone: string | null } | null;
  } | null;
}

export interface HireFastFilter {
  stage: HrStage | null;
  /** Assigned to `viewerId` (an auth user id, as `assigned_agent_id`). */
  mine: boolean;
  viewerId: string | null;
}

export function filterCandidates<T extends HireFastRow>(
  rows: T[],
  f: HireFastFilter
): T[] {
  return rows.filter(
    (r) =>
      (f.stage === null || r.stage_key === f.stage) &&
      (!f.mine ||
        (f.viewerId !== null && r.chat?.assigned_agent_id === f.viewerId))
  );
}

/** "Waiting 18 h"; whole days past 48 h ("Waiting 3 d"); none at 0 h. */
export function waitingLabel(
  hours: number
): { key: 'waitingHours' | 'waitingDays'; n: number } | null {
  if (hours <= 0) return null;
  return hours > 48
    ? { key: 'waitingDays', n: Math.floor(hours / 24) }
    : { key: 'waitingHours', n: hours };
}

/** The label key of a reason code under `Hr.hireFast`. */
export function reasonLabelKey(
  code: HireFastReason
): `reason.${HireFastReason}` {
  return `reason.${code}`;
}

export interface HireFastView extends HireFastItem {
  /** The contact's name, else the phone, else null ("Contact"). */
  name: string | null;
  href: string;
}

/** Ranks the rows and shapes each one for the table. */
export function hireFastViews(
  rows: HireFastRow[],
  now: number,
  overdue: ReadonlySet<string>,
  stalledAfter: number | null,
  limit = 50
): HireFastView[] {
  const byId = new Map(rows.map((r) => [r.conversation_id, r]));
  return rankCandidates(rows, now, overdue, stalledAfter, limit).map((item) => {
    const contact = byId.get(item.conversationId)?.chat?.contact ?? null;
    const name = contact?.name?.trim() || contact?.phone?.trim() || null;
    return {
      ...item,
      name,
      href: `/hr/recruiter?c=${encodeURIComponent(item.conversationId)}`,
    };
  });
}
