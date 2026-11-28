/**
 * Send guard: one decision per outgoing WhatsApp message (ported from wacrm
 * module 017b `guard.ts` / `ramp.ts`, on migration 188's number state).
 * Pure: state arrives through injected loaders, read lazily in rule order.
 * First match wins:
 *   1 recipient opted out → OPTED_OUT (every kind, session replies included)
 *   2 number BANNED / DISCONNECTED → TOTAL_BLOCK
 *   3 SESSION reply inside the 24 h window → SESSION_ALLOWED (skips 4–8)
 *   4 ALL_PAUSED → NUMBER_ALL_PAUSED; MARKETING_PAUSED + marketing →
 *     NUMBER_MARKETING_PAUSED
 *   5 template paused → TEMPLATE_PAUSED
 *   6 marketing: recipient suppression → SUPPRESSED_*
 *   7 marketing: daily ramp exhausted → RAMP_CAP_REACHED, deferUntil next
 *     UTC midnight (THROTTLED counts as YELLOW once, never twice)
 *   8 marketing: reserve the cost on the daily spend scope → SPEND_CAP
 * Utility / authentication templates obey 1, 2, ALL_PAUSED and 5 only.
 * A loader error denies STATE_UNAVAILABLE, except a session reply whose
 * opt-out check passed (SESSION_ALLOWED_DEGRADED): a customer reply is never
 * blocked on our own store failing. Missing or unknown health never pauses.
 */
import { assessNumberState, type NumberStatus } from './state';
import type { AssessedState, QualityRating } from './values';

/** Stable reason strings (stored in the decision log). */
export const GUARD_REASONS = {
  ALLOWED: 'ALLOWED',
  SESSION_ALLOWED: 'SESSION_ALLOWED',
  SESSION_ALLOWED_DEGRADED: 'SESSION_ALLOWED_DEGRADED',
  OPTED_OUT: 'OPTED_OUT',
  TOTAL_BLOCK: 'TOTAL_BLOCK',
  NUMBER_ALL_PAUSED: 'NUMBER_ALL_PAUSED',
  NUMBER_MARKETING_PAUSED: 'NUMBER_MARKETING_PAUSED',
  TEMPLATE_PAUSED: 'TEMPLATE_PAUSED',
  SUPPRESSED_DELIVERY_FAILURES: 'SUPPRESSED_DELIVERY_FAILURES',
  SUPPRESSED_NO_REPLY: 'SUPPRESSED_NO_REPLY',
  RAMP_CAP_REACHED: 'RAMP_CAP_REACHED',
  SPEND_CAP: 'SPEND_CAP',
  LOG_UNAVAILABLE: 'LOG_UNAVAILABLE',
  STATE_UNAVAILABLE: 'STATE_UNAVAILABLE',
} as const;
export type GuardReason = (typeof GUARD_REASONS)[keyof typeof GUARD_REASONS];

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export type SendRequest =
  | { kind: 'SESSION'; contactId: string; template?: string | null }
  | {
      kind: 'TEMPLATE';
      contactId: string;
      template: string;
      category: TemplateCategory;
      /** Price of this message for the spend check (micros). */
      costMicros: number;
    };

export type GuardDecision = {
  allow: boolean;
  reason: GuardReason;
  deferUntil?: string;
  /** On an allowed marketing decision: refunds the spend reservation. */
  release?: () => Promise<void>;
};

/** 188's meta_number_state as the guard needs it; null fields are unknown. */
export type GuardNumberState = {
  qualityRating: QualityRating | null;
  messagingLimitTier: string | null;
  accountStatus: NumberStatus | null;
  numberAgeDays: number;
};

export type RecipientSignals = {
  optedOut: boolean;
  /** Marketing sends since the contact's last inbound message. */
  sentWithoutReply: number;
  /** Failed deliveries in the last 30 days. */
  failedDeliveries: number;
};

export type TodayCounts = { sentToday: number; newRecipientsToday: number };

export type SpendReservation = {
  allowed: boolean;
  release: () => Promise<void>;
};

export type GuardContext = {
  recipientSignals(contactId: string): Promise<RecipientSignals>;
  numberState(): Promise<GuardNumberState>;
  /** Template names whose health is paused (188's template health). */
  pausedTemplates(): Promise<readonly string[]>;
  todayCounts(): Promise<TodayCounts>;
  reserveMarketingSpend(micros: number): Promise<SpendReservation>;
  now: () => Date;
};

const R = GUARD_REASONS;

// ── Ramp and suppression (pure) ─────────────────────────────────────

export const RAMP_POLICY = {
  newNumberDays: 14,
  newNumberSharePct: 25,
  matureSharePct: 60,
  qualityFactorPct: { GREEN: 100, YELLOW: 50, RED: 0 },
  /** Meta's lowest tier, used when the tier cannot be read. */
  unknownTierLimit: 250,
} as const;

/** Meta tier → daily unique-recipient limit; null when unreadable. */
export function tierLimit(tier: string | null | undefined): number | null {
  if (typeof tier !== 'string') return null;
  const t = tier.trim().toUpperCase();
  if (t === 'UNLIMITED' || t === 'TIER_UNLIMITED') return Infinity;
  const m = /^TIER_(\d+)(K?)$/.exec(t);
  return m ? Number(m[1]) * (m[2] === 'K' ? 1000 : 1) : null;
}

/** Today's marketing cap; unknown quality counts as GREEN (never pauses). */
export function marketingCapToday(input: {
  tier: string | null;
  numberAgeDays: number;
  qualityRating: QualityRating | null;
}): number {
  const p = RAMP_POLICY;
  const limit = tierLimit(input.tier) ?? p.unknownTierLimit;
  const share =
    input.numberAgeDays < p.newNumberDays
      ? p.newNumberSharePct
      : p.matureSharePct;
  const q = input.qualityRating;
  const factor =
    q === 'YELLOW' || q === 'RED'
      ? p.qualityFactorPct[q]
      : p.qualityFactorPct.GREEN;
  if (factor <= 0) return 0;
  if (limit === Infinity) return Infinity;
  return Math.floor((limit * share * factor) / 10000);
}

export type Suppression = 'DELIVERY_FAILURES' | 'NO_REPLY' | null;

/** ≥2 failed deliveries in 30 days, else ≥3 marketing sends with no reply. */
export function recipientSuppression(r: RecipientSignals): Suppression {
  if (r.failedDeliveries >= 2) return 'DELIVERY_FAILURES';
  if (r.sentWithoutReply >= 3) return 'NO_REPLY';
  return null;
}

/** Next UTC midnight after `now`, ISO. */
export function nextUtcMidnight(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ).toISOString();
}

// ── canSend ─────────────────────────────────────────────────────────

class StateUnavailable extends Error {
  constructor(readonly loader: string) {
    super(`guard state loader ${loader} failed`);
  }
}

async function load<T>(loader: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch {
    throw new StateUnavailable(loader);
  }
}

const deny = (reason: GuardReason, deferUntil?: string): GuardDecision =>
  deferUntil ? { allow: false, reason, deferUntil } : { allow: false, reason };

async function decide(
  ctx: GuardContext,
  req: SendRequest
): Promise<GuardDecision> {
  // 1. Opt-out: universal.
  const recipient = await load('recipientSignals', () =>
    ctx.recipientSignals(req.contactId)
  );
  if (recipient.optedOut) return deny(R.OPTED_OUT);

  // 2. Total block.
  const state = await load('numberState', () => ctx.numberState());
  if (
    state.accountStatus === 'BANNED' ||
    state.accountStatus === 'DISCONNECTED'
  ) {
    return deny(R.TOTAL_BLOCK);
  }

  // 3. Session reply.
  if (req.kind === 'SESSION') return { allow: true, reason: R.SESSION_ALLOWED };

  const marketing = req.category === 'MARKETING';
  const mode: AssessedState = assessNumberState(
    state.qualityRating,
    state.accountStatus
  ).assessedState;
  // 4. Number mode.
  if (mode === 'ALL_PAUSED') return deny(R.NUMBER_ALL_PAUSED);
  if (marketing && mode === 'MARKETING_PAUSED') {
    return deny(R.NUMBER_MARKETING_PAUSED);
  }
  // 5. Template health.
  const paused = await load('pausedTemplates', () => ctx.pausedTemplates());
  if (paused.includes(req.template)) return deny(R.TEMPLATE_PAUSED);
  if (!marketing) return { allow: true, reason: R.ALLOWED };

  // 6. Recipient suppression.
  const s = recipientSuppression(recipient);
  if (s === 'DELIVERY_FAILURES') return deny(R.SUPPRESSED_DELIVERY_FAILURES);
  if (s === 'NO_REPLY') return deny(R.SUPPRESSED_NO_REPLY);

  // 7. Daily ramp. THROTTLED passes as YELLOW so its factor applies once.
  const counts = await load('todayCounts', () => ctx.todayCounts());
  const cap = marketingCapToday({
    tier: state.messagingLimitTier,
    numberAgeDays: state.numberAgeDays,
    qualityRating: mode === 'THROTTLED' ? 'YELLOW' : state.qualityRating,
  });
  if (Math.max(counts.sentToday, counts.newRecipientsToday) >= cap) {
    return deny(R.RAMP_CAP_REACHED, nextUtcMidnight(ctx.now()));
  }

  // 8. Spend: reserve last, so nothing after it can leak the hold.
  const spend = await load('spend', () =>
    ctx.reserveMarketingSpend(req.costMicros)
  );
  if (!spend.allowed) return deny(R.SPEND_CAP);
  return { allow: true, reason: R.ALLOWED, release: spend.release };
}

export async function canSend(
  ctx: GuardContext,
  req: SendRequest
): Promise<GuardDecision> {
  try {
    return await decide(ctx, req);
  } catch (err) {
    if (!(err instanceof StateUnavailable)) throw err;
    // recipientSignals loads first, so any later failure on a session
    // reply means the opt-out check already passed.
    if (req.kind === 'SESSION' && err.loader !== 'recipientSignals') {
      return { allow: true, reason: R.SESSION_ALLOWED_DEGRADED };
    }
    return deny(R.STATE_UNAVAILABLE);
  }
}
