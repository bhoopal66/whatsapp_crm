// What WhatsApp restricts a number for is mass-adding and messaging
// strangers, so every way of doing it spends the same two hourly budgets
// (per person here, per number): adding members, creating a group, sending
// the invite link, and a manager's saved number. Counted in people, before
// the gateway call. Creating groups has a daily cap per number as well.

import {
  checkRateLimit,
  RATE_LIMITS,
  rateLimitRemaining,
  refundRateLimit,
} from '@/lib/rate-limit';

import { GroupHttpError } from './server';

function minutesUntil(resets: readonly number[]): number {
  const wait = Math.max(0, ...resets) - Date.now();
  return Math.max(1, Math.ceil(wait / 60_000));
}

export function addBudget(userId: string, channelId: string) {
  const budgets = [
    [`group-add:${userId}`, RATE_LIMITS.groupAddPerson],
    [`group-add-number:${channelId}`, RATE_LIMITS.groupAddNumber],
  ] as const;
  const remaining = () =>
    Math.min(...budgets.map(([key, rule]) => rateLimitRemaining(key, rule)));
  return {
    remaining,
    /** Spends up to `count` people; returns how many were allowed. */
    spend(count: number): number {
      const allowed = Math.min(count, remaining());
      for (let i = 0; i < allowed; i++) {
        for (const [key, rule] of budgets) checkRateLimit(key, rule);
      }
      return allowed;
    },
    /** Gives back what a call that certainly reached nobody had spent. */
    refund(count: number): void {
      for (const [key] of budgets) refundRateLimit(key, count);
    },
    /** The 429 for a budget with nothing left. */
    refusal(): GroupHttpError {
      const resets = budgets
        .filter(([key, rule]) => rateLimitRemaining(key, rule) === 0)
        .map(([key, rule]) => checkRateLimit(key, rule).reset);
      return new GroupHttpError(
        429,
        'too_many_adds',
        `Too many people were added in the last hour; try again in ${minutesUntil(resets)} min`
      );
    },
  };
}

const createKey = (channelId: string) => `group-create-number:${channelId}`;

/** Counts one group created on the number, or throws the 429. */
export function spendGroupCreate(channelId: string): void {
  const res = checkRateLimit(
    createKey(channelId),
    RATE_LIMITS.groupCreateNumber
  );
  if (res.success) return;
  const hours = Math.ceil(minutesUntil([res.reset]) / 60);
  throw new GroupHttpError(
    429,
    'too_many_creates',
    `Too many groups were created on this number today; try again in ${hours} h`
  );
}

export function refundGroupCreate(channelId: string): void {
  refundRateLimit(createKey(channelId), 1);
}
