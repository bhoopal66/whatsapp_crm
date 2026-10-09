// ============================================================
// AI agent v2 vocabulary (migration 077).
//
// The SQL CHECKs on `ai_reply_events.tier` / `.route_source` and
// `conversations.ai_paused_reason` mirror the first three unions —
// change one, change both. `ai_last_outcome` / `ai_reply_events.outcome`
// carry no CHECK on purpose: AI_DISPATCH_OUTCOMES is the source of truth.
// ============================================================

/** Which model tier answered: `standard` is the config's own `model`. */
export type AiReplyTier = 'small' | 'standard' | 'large';

/** What picked the tier: TypeSafe (Jev), the local heuristic, or no routing. */
export type AiRouteSource = 'jev' | 'heuristic' | 'fixed';

/** Why `conversations.ai_autoreply_disabled` is set. */
export type AiPausedReason = 'take_over' | 'agent_reply' | 'handoff';

export const AI_DISPATCH_OUTCOMES = [
  /** The bot sent a reply. */
  'replied',
  /** The bot handed the chat to a person (a gate or the model). */
  'handed_off',
  /** TypeSafe held the draft; it waits on the chat for a person. */
  'held_for_review',
  /** The message arrived on a number the bot does not answer. */
  'skipped_number',
  /** A Flow or automation consumed the message. */
  'skipped_automation',
  /** The chat is assigned to a person. */
  'skipped_assigned',
  /** The bot is paused on this chat (take over, agent reply, hand-off). */
  'skipped_paused',
  /** Campaign-only mode, and the chat did not come from a campaign. */
  'skipped_campaign_only',
  /** The provider or the per-chat pace refused the call. */
  'skipped_rate_limited',
  /** A newer customer message took over this dispatch. */
  'skipped_superseded',
  /** Another dispatch claimed the last reply slot first. */
  'skipped_cap_race',
  /** Nothing to answer (no text, AI off, nothing new). */
  'skipped_nothing',
  /** The dispatch failed. */
  'error',
] as const;

/** The result of one auto-reply dispatch. */
export type AiDispatchOutcome = (typeof AI_DISPATCH_OUTCOMES)[number];

/**
 * Choices for the settings select, in minutes: never, 30 min, 1 h,
 * 4 h, 12 h, 24 h. Inside the 5..10080 the database allows.
 */
export const AUTO_RESUME_CHOICES: readonly (number | null)[] = [
  null,
  30,
  60,
  240,
  720,
  1440,
];
