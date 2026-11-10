/**
 * A Meta number's health and its assessed sending state (migration 188's
 * `meta_number_state`). Pure: previous state + one health event → next
 * state. WATCH-ONLY: the assessed state is a record, not a gate.
 *
 * Ported from wacrm module 017b (`numberhealth.ts`'s assessNumber and
 * `healthstore.ts`'s event planner). Missing data (UNKNOWN quality or
 * status) never raises the state. Pausing signals only ever raise the
 * status: a mapped event never lowers a restriction or a ban, and
 * UNFLAGGED clears only FLAGGED.
 *
 * VERIFY AGAINST META'S DOCS BEFORE PRODUCTION: the event, restriction and
 * ban values mapped below were not re-checked against Meta's reference.
 */
import type { HealthEvent } from './ingest';
import {
  ASSESSED_STATES,
  boundedText,
  normalizeQuality,
  type AssessedState,
  type QualityRating,
} from './values';

/** BANNED and DISCONNECTED are a total block: not even a session reply goes out. */
export const NUMBER_STATUSES = [
  'CONNECTED',
  'FLAGGED',
  'RESTRICTED',
  'PENDING',
  'DISCONNECTED',
  'BANNED',
  'UNKNOWN',
] as const;
export type NumberStatus = (typeof NUMBER_STATUSES)[number];

export type NumberHealthState = {
  qualityRating: QualityRating | null;
  /** Meta messaging-limit tier, e.g. "TIER_1K". */
  messagingLimitTier: string | null;
  /** A NumberStatus, or null when nothing is known. */
  accountStatus: NumberStatus | null;
  assessedState: AssessedState;
  /** Short codes, e.g. QUALITY_YELLOW, STATUS_RESTRICTED. */
  reasons: string[];
};

export type NumberStateRow = {
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  account_status: string | null;
  assessed_state: string | null;
  reasons: unknown;
};

const RANK: Record<AssessedState, number> = {
  NORMAL: 0,
  THROTTLED: 1,
  MARKETING_PAUSED: 2,
  ALL_PAUSED: 3,
};

const STATUS_SEVERITY: Record<NumberStatus, number> = {
  UNKNOWN: 0,
  PENDING: 0,
  CONNECTED: 0,
  FLAGGED: 1,
  RESTRICTED: 2,
  DISCONNECTED: 3,
  BANNED: 3,
};

/** phone_number_quality_update events carried by `current_limit`, not their name. */
const INFO_EVENTS: ReadonlySet<string> = new Set([
  'UPGRADE',
  'DOWNGRADE',
  'QUALITY_UPDATED',
]);
/** The restriction that stops business-initiated (template) sends. */
const BIZ_RESTRICTION = 'RESTRICTED_BIZ_INITIATED_MESSAGING';

const isStatus = (v: unknown): v is NumberStatus =>
  typeof v === 'string' && (NUMBER_STATUSES as readonly string[]).includes(v);

/** A stored row (or none) as a state; unreadable values read as unknown. */
export function numberStateFromRow(
  row: NumberStateRow | null
): NumberHealthState {
  if (!row) {
    return {
      qualityRating: null,
      messagingLimitTier: null,
      accountStatus: null,
      assessedState: 'NORMAL',
      reasons: [],
    };
  }
  const assessed = (ASSESSED_STATES as readonly string[]).includes(
    row.assessed_state ?? ''
  )
    ? (row.assessed_state as AssessedState)
    : 'NORMAL';
  return {
    qualityRating: normalizeQuality(row.quality_rating),
    messagingLimitTier: boundedText(row.messaging_limit_tier, 64),
    accountStatus: isStatus(row.account_status) ? row.account_status : null,
    assessedState: assessed,
    reasons: Array.isArray(row.reasons)
      ? row.reasons.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

/** "TIER_1K", "TIER_250", "UNLIMITED" … readable as a limit (ramp.ts's tierLimit). */
export function isReadableTier(tier: string): boolean {
  const t = tier.trim().toUpperCase();
  return t === 'UNLIMITED' || t === 'TIER_UNLIMITED' || /^TIER_\d+K?$/.test(t);
}

/** The assessed state and reasons from quality and status (assessNumber). */
export function assessNumberState(
  qualityRating: QualityRating | null,
  accountStatus: NumberStatus | null
): { assessedState: AssessedState; reasons: string[] } {
  let mode: AssessedState = 'NORMAL';
  const reasons: string[] = [];
  const raise = (to: AssessedState, why: string) => {
    reasons.push(why);
    if (RANK[to] > RANK[mode]) mode = to;
  };
  switch (qualityRating) {
    case 'GREEN':
      break;
    case 'YELLOW':
      raise('THROTTLED', 'QUALITY_YELLOW');
      break;
    case 'RED':
      raise('MARKETING_PAUSED', 'QUALITY_RED');
      break;
    // UNKNOWN or nothing read is missing data: report it, never pause on it.
    default:
      reasons.push('NO_SIGNAL');
  }
  if (accountStatus === 'FLAGGED') raise('MARKETING_PAUSED', 'STATUS_FLAGGED');
  else if (accountStatus === 'RESTRICTED') {
    raise('ALL_PAUSED', 'STATUS_RESTRICTED');
  } else if (accountStatus === 'BANNED' || accountStatus === 'DISCONNECTED') {
    raise('ALL_PAUSED', 'TOTAL_BLOCK');
  }
  return { assessedState: mode, reasons };
}

export type NumberStateStep = {
  next: NumberHealthState;
  /** Whether quality, tier, status, state or reasons moved (else skip the write). */
  changed: boolean;
  /** Values seen but not mapped (state kept), e.g. `TIER_UNRECOGNISED: X`. For logs. */
  unrecognised: string[];
};

/**
 * Applies one event. phone_number_quality_update: `current_limit` → tier,
 * FLAGGED → status FLAGGED, UNFLAGGED → CONNECTED (only from FLAGGED).
 * account_update / account_review_update: a RESTRICTED_BIZ_INITIATED_MESSAGING
 * restriction → RESTRICTED, ban state DISABLE → BANNED. Template events leave
 * the number alone. The webhook carries no number quality rating, so
 * `qualityRating` only keeps what `prev` had.
 */
export function nextNumberState(
  prev: NumberHealthState,
  ev: HealthEvent
): NumberStateStep {
  let tier = prev.messagingLimitTier;
  let status: NumberStatus = prev.accountStatus ?? 'UNKNOWN';
  const unrecognised: string[] = [];
  const raiseStatus = (to: NumberStatus) => {
    if (STATUS_SEVERITY[to] > STATUS_SEVERITY[status]) status = to;
  };

  if (ev.kind === 'phone_number_quality_update') {
    if (ev.currentLimit !== undefined) {
      const t = boundedText(ev.currentLimit, 64);
      if (t && isReadableTier(t)) tier = t;
      else unrecognised.push(`TIER_UNRECOGNISED: ${ev.currentLimit}`);
    }
    if (ev.event === 'FLAGGED') raiseStatus('FLAGGED');
    else if (ev.event === 'UNFLAGGED') {
      if (status === 'FLAGGED') status = 'CONNECTED';
    } else if (ev.event !== undefined && !INFO_EVENTS.has(ev.event)) {
      unrecognised.push(`NUMBER_EVENT_UNRECOGNISED: ${ev.event}`);
    }
  } else if (
    ev.kind === 'account_update' ||
    ev.kind === 'account_review_update'
  ) {
    let mapped = false;
    for (const r of ev.restrictions ?? []) {
      if (r.type === BIZ_RESTRICTION) {
        raiseStatus('RESTRICTED');
        mapped = true;
      } else unrecognised.push(`RESTRICTION_UNRECOGNISED: ${r.type}`);
    }
    if (ev.banState === 'DISABLE') {
      raiseStatus('BANNED');
      mapped = true;
    } else if (ev.banState !== undefined) {
      unrecognised.push(`BAN_STATE_UNRECOGNISED: ${ev.banState}`);
    }
    if (!mapped && !ev.restrictions?.length && ev.banState === undefined) {
      unrecognised.push(`ACCOUNT_EVENT_UNMAPPED: ${ev.event ?? '?'}`);
    }
  } else {
    return { next: prev, changed: false, unrecognised };
  }

  const accountStatus = status === 'UNKNOWN' ? null : status;
  const assessed = assessNumberState(prev.qualityRating, accountStatus);
  const next: NumberHealthState = {
    qualityRating: prev.qualityRating,
    messagingLimitTier: tier,
    accountStatus,
    ...assessed,
  };
  const changed =
    next.messagingLimitTier !== prev.messagingLimitTier ||
    next.accountStatus !== prev.accountStatus ||
    next.assessedState !== prev.assessedState ||
    next.reasons.join('\n') !== prev.reasons.join('\n');
  return { next, changed, unrecognised };
}

/**
 * True when `next` is worse than `prev` (NORMAL < THROTTLED <
 * MARKETING_PAUSED < ALL_PAUSED); no previous state counts as NORMAL.
 * A later job rings owners and admins on it.
 */
export function isAlarmTransition(
  prev: AssessedState | null,
  next: AssessedState
): boolean {
  return RANK[next] > RANK[prev ?? 'NORMAL'];
}
