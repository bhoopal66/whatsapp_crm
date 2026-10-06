import { describe, it, expect, vi } from 'vitest';

// The hook module pulls in the browser Supabase client and the auth
// context; neither is needed for the pure helper under test.
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acct' }) }));

import { resolveSendTime } from './use-broadcast-sending';

const DUBAI = { start: '21:00', end: '08:00', tz: 'Asia/Dubai' };

describe('resolveSendTime', () => {
  const now = new Date('2026-09-16T08:00:00Z'); // 12:00 Dubai

  it('sends now when nothing is scheduled and no quiet hours apply', () => {
    expect(resolveSendTime(now, null, null)).toBeNull();
  });

  it('keeps a future schedule as-is outside quiet hours', () => {
    const at = new Date('2026-09-17T09:00:00Z');
    expect(resolveSendTime(now, at, DUBAI)).toBe(at);
  });

  it('treats a schedule in the past as "send now"', () => {
    const past = new Date('2026-09-16T07:00:00Z');
    expect(resolveSendTime(now, past, null)).toBeNull();
  });

  it('turns a send-now inside quiet hours into a schedule for the window end', () => {
    const late = new Date('2026-09-16T19:30:00Z'); // 23:30 Dubai
    expect(resolveSendTime(late, null, DUBAI)?.toISOString()).toBe(
      '2026-09-17T04:00:00.000Z'
    );
  });

  it('pushes a schedule that lands inside quiet hours to the window end', () => {
    const at = new Date('2026-09-18T20:00:00Z'); // 00:00 Dubai on the 19th
    expect(resolveSendTime(now, at, DUBAI)?.toISOString()).toBe(
      '2026-09-19T04:00:00.000Z'
    );
  });
});
