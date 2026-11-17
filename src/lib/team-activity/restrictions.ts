import {
  LIMIT_BOUNDS,
  type BOOLEAN_LIMITS,
  type TeamActivityLimits,
} from './limits';

type BooleanKey = (typeof BOOLEAN_LIMITS)[number];
type NumericKey = keyof typeof LIMIT_BOUNDS;

/** The per-rule switches of the Restrictions section, in display order. */
export const RESTRICTION_RULES = [
  'enforceChase',
  'enforceQuietHours',
  'enforceDailyUser',
  'enforceReplyRate',
  'enforceDailyNumber',
  'enforceBurst',
  'enforceLinksFirst',
  'enforceSameOpener',
  'enforceJev',
  'enforceAutoSenders',
] as const satisfies readonly BooleanKey[];

/** Number inputs the Restrictions section adds to the dialog. */
export const RESTRICTION_NUMBERS = [
  'sameOpenerMax',
  'replyRateThrottlePct',
  'jevBlockMinP',
] as const satisfies readonly NumericKey[];

/** Per-rule switches are shown disabled (values kept) while the master is off. */
export function ruleSwitchesDisabled(
  limits: Pick<TeamActivityLimits, 'blockOverLimit'>
): boolean {
  return !limits.blockOverLimit;
}

/** Whether a number is inside its bounds; jevBlockMinP allows two decimals. */
export function limitValueValid(key: NumericKey, value: number): boolean {
  const [min, max] = LIMIT_BOUNDS[key];
  if (!Number.isFinite(value) || value < min || value > max) return false;
  if (key === 'jevBlockMinP') return Math.round(value * 100) / 100 === value;
  return Number.isInteger(value);
}
