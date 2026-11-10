/**
 * Meta number health (migration 188), read-only view helpers for the
 * Settings card and its GET route. Watch-only: nothing here decides a
 * send. Pure, so the node test environment can pin them.
 */

export type AssessedState =
  'NORMAL' | 'THROTTLED' | 'MARKETING_PAUSED' | 'ALL_PAUSED';

export type HealthTone = 'success' | 'warning' | 'destructive' | 'muted';

const ASSESSED: readonly AssessedState[] = [
  'NORMAL',
  'THROTTLED',
  'MARKETING_PAUSED',
  'ALL_PAUSED',
];

export function parseAssessedState(raw: unknown): AssessedState {
  return ASSESSED.includes(raw as AssessedState)
    ? (raw as AssessedState)
    : 'NORMAL';
}

export function assessedTone(state: AssessedState): HealthTone {
  switch (state) {
    case 'NORMAL':
      return 'success';
    case 'THROTTLED':
    case 'MARKETING_PAUSED':
      return 'warning';
    case 'ALL_PAUSED':
      return 'destructive';
    default: {
      const never: never = state;
      return never;
    }
  }
}

/** Meta's quality colours (GREEN / YELLOW / RED); anything else is muted. */
export function qualityTone(quality: string | null | undefined): HealthTone {
  if (quality === 'GREEN') return 'success';
  if (quality === 'YELLOW') return 'warning';
  if (quality === 'RED') return 'destructive';
  return 'muted';
}

/**
 * `meta_number_state.reasons` is a jsonb array whose element shape the
 * migration does not fix: keep strings, and an object's `message`,
 * `reason` or `code` string; drop anything else.
 */
export function parseReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const text = [o.message, o.reason, o.code].find(
        (v): v is string => typeof v === 'string' && v.trim() !== ''
      );
      if (text) out.push(text.trim());
    }
  }
  return out;
}

/**
 * The day `meta_marketing_sent_today` counts over. The SQL bounds
 * `p_day` in UTC, and the cap is "per Meta number per UTC day"
 * (188's column comment), so the route passes the UTC date: a local
 * date would count a window shifted from the one the cap means.
 */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface CostPerWonCase {
  wonCases: number;
  wonSpendUsd: number;
  costPerWonCaseUsd: number | null;
  otherSpendUsd: number;
  unknownCostMessages: number;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Parse `meta_cost_per_won_case`'s jsonb; null when it is not an object. */
export function parseCostPerWonCase(raw: unknown): CostPerWonCase | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    wonCases: num(o.won_cases) ?? 0,
    wonSpendUsd: num(o.won_spend_usd) ?? 0,
    costPerWonCaseUsd: num(o.cost_per_won_case_usd),
    otherSpendUsd: num(o.other_spend_usd) ?? 0,
    unknownCostMessages: num(o.unknown_cost_messages) ?? 0,
  };
}

export interface MarketingUsage {
  sent: number;
  cap: number | null;
  /** True once `sent` has reached a set cap. Advisory only. */
  atCap: boolean;
}

export function marketingUsage(
  sent: number | null,
  cap: number | null
): MarketingUsage {
  const s = sent ?? 0;
  return { sent: s, cap, atCap: cap !== null && s >= cap };
}

/** Tailwind classes for a tone: complete literals, status tokens only. */
export const TONE_CLASS: Record<HealthTone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  destructive: 'bg-destructive-soft text-destructive',
  muted: 'bg-muted text-muted-foreground',
};
