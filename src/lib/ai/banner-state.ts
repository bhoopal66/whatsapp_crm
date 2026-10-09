// ============================================================
// What the inbox's AI banner shows for one chat (AI agent v2,
// migration 077). Pure, so the priority order and the outcome wording
// are tested without a DOM; `components/inbox/ai-thread-banner.tsx`
// renders the result.
//
// Priority: a held draft, then a pause, then an assignment, then the
// active bot — with a warning when its last dispatch did not answer.
// ============================================================

import type { AiDispatchOutcome, AiPausedReason } from './outcomes';

export interface AiBannerInput {
  /** The account's bot is configured, on, and answering inbound. */
  autoReplyOn: boolean;
  /** `ai_configs.auto_resume_minutes`; null = an agent_reply pause never lifts. */
  autoResumeMinutes: number | null;
  conversation: {
    ai_autoreply_disabled?: boolean | null;
    ai_paused_reason?: AiPausedReason | null;
    ai_handoff_summary?: string | null;
    ai_pending_draft?: string | null;
    ai_last_outcome?: AiDispatchOutcome | string | null;
    ai_last_outcome_detail?: string | null;
    ai_last_outcome_at?: string | null;
    assigned_agent_id?: string | null;
  };
  /** `created_at` of the thread's latest bot-generated message, if any. */
  lastAiReplyAt: string | null;
  /** The thread's latest message is the customer's. */
  lastMessageFromCustomer: boolean;
}

/** Which i18n sentence explains an outcome (`Inbox.aiBanner.outcome.*`). */
export type AiOutcomeWarning =
  | 'skipped_number'
  | 'skipped_automation'
  | 'skipped_rate_limited'
  | 'skipped_campaign_only'
  | 'error';

export type AiBannerState =
  | { kind: 'hidden' }
  | { kind: 'draft'; draft: string; reason: string | null }
  | {
      kind: 'paused';
      reason: AiPausedReason;
      summary: string | null;
      /** Only for an agent_reply pause, when the account auto-resumes. */
      autoResume: AutoResumeAfter | null;
      /** Resume should also answer the customer's waiting message. */
      replyNow: boolean;
    }
  | { kind: 'assigned' }
  | {
      kind: 'active';
      warning: { outcome: AiOutcomeWarning; detail: string | null } | null;
    };

export interface AutoResumeAfter {
  unit: 'minutes' | 'hours';
  count: number;
}

const WARNED_OUTCOMES: ReadonlySet<string> = new Set<AiOutcomeWarning>([
  'skipped_number',
  'skipped_automation',
  'skipped_rate_limited',
  'skipped_campaign_only',
  'error',
]);

/**
 * The outcome worth telling a person about, or null. Only outcomes that
 * leave a customer unanswered for a reason someone can act on are
 * warned; a superseded dispatch, a cap race or "nothing to answer" is
 * routine, and the paused / assigned / held / handed-off outcomes have
 * a banner state of their own.
 */
export function outcomeWarning(
  outcome: string | null | undefined
): AiOutcomeWarning | null {
  return outcome && WARNED_OUTCOMES.has(outcome)
    ? (outcome as AiOutcomeWarning)
    : null;
}

/** 30 → 30 minutes, 240 → 4 hours. Null for no auto-resume. */
export function autoResumeAfter(
  minutes: number | null | undefined
): AutoResumeAfter | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  return minutes % 60 === 0
    ? { unit: 'hours', count: minutes / 60 }
    : { unit: 'minutes', count: minutes };
}

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * A pause with no recorded reason predates 077 or came from a path that
 * does not record one; classify it the way 077's backfill did.
 */
function pausedReason(c: AiBannerInput['conversation']): AiPausedReason {
  if (c.ai_paused_reason) return c.ai_paused_reason;
  return c.ai_handoff_summary ? 'handoff' : 'take_over';
}

export function aiBannerState(input: AiBannerInput): AiBannerState {
  const { conversation: c } = input;
  if (!input.autoReplyOn) return { kind: 'hidden' };

  if (c.ai_pending_draft) {
    return {
      kind: 'draft',
      draft: c.ai_pending_draft,
      reason: c.ai_handoff_summary || null,
    };
  }

  if (c.ai_autoreply_disabled) {
    const reason = pausedReason(c);
    return {
      kind: 'paused',
      reason,
      summary: reason === 'handoff' ? c.ai_handoff_summary || null : null,
      autoResume:
        reason === 'agent_reply'
          ? autoResumeAfter(input.autoResumeMinutes)
          : null,
      replyNow: input.lastMessageFromCustomer,
    };
  }

  if (c.assigned_agent_id) return { kind: 'assigned' };

  const outcome = outcomeWarning(c.ai_last_outcome);
  const outcomeAt = time(c.ai_last_outcome_at);
  const repliedAt = time(input.lastAiReplyAt);
  const warn =
    outcome !== null &&
    outcomeAt !== null &&
    (repliedAt === null || outcomeAt > repliedAt);
  return {
    kind: 'active',
    warning: warn
      ? { outcome, detail: c.ai_last_outcome_detail || null }
      : null,
  };
}

// ------------------------------------------------------------
// Inputs the thread derives from its loaded messages.
// ------------------------------------------------------------

interface DatedMessage {
  created_at: string;
}

/** The newest of `messages` by `created_at`; a tie goes to the later one. */
function newest<M extends DatedMessage>(messages: readonly M[]): M | null {
  let best: M | null = null;
  let bestAt = -Infinity;
  for (const m of messages) {
    const at = time(m.created_at);
    if (at === null) continue;
    if (at >= bestAt) {
      best = m;
      bestAt = at;
    }
  }
  return best;
}

/** `created_at` of the newest bot-generated message, or null. */
export function lastAiReplyAt(
  messages: readonly (DatedMessage & { ai_generated?: boolean | null })[]
): string | null {
  return newest(messages.filter((m) => m.ai_generated))?.created_at ?? null;
}

/** The newest message is the customer's (so Resume should answer it). */
export function lastMessageFromCustomer(
  messages: readonly (DatedMessage & { sender_type: string })[]
): boolean {
  return newest(messages)?.sender_type === 'customer';
}

// ------------------------------------------------------------
// The banner's optimistic state. A click patches the banner at once;
// the server's row (the parent's patch, then the realtime UPDATE)
// supersedes it. The override remembers which chat and which server
// snapshot it was made against, and is ignored as soon as either
// differs — derived on render, never reset from an effect.
// ------------------------------------------------------------

const SNAPSHOT_FIELDS = [
  'ai_autoreply_disabled',
  'ai_paused_reason',
  'ai_handoff_summary',
  'ai_pending_draft',
  'ai_pending_draft_at',
  'ai_last_outcome',
  'ai_last_outcome_detail',
  'ai_last_outcome_at',
  'assigned_agent_id',
] as const;

type SnapshotSource = Partial<
  Record<(typeof SNAPSHOT_FIELDS)[number], unknown>
>;

/** A key that changes whenever any field the banner reads changes. */
export function bannerSnapshot(c: SnapshotSource): string {
  return JSON.stringify(SNAPSHOT_FIELDS.map((f) => c[f] ?? null));
}

export interface BannerOverride<P> {
  forConversation: string;
  forSnapshot: string;
  value: P;
}

/** `server` with the override applied, if it still belongs to it. */
export function withOverride<C extends SnapshotSource>(
  conversationId: string,
  server: C,
  override: BannerOverride<Partial<C>> | null
): C {
  if (
    !override ||
    override.forConversation !== conversationId ||
    override.forSnapshot !== bannerSnapshot(server)
  ) {
    return server;
  }
  return { ...server, ...override.value };
}
