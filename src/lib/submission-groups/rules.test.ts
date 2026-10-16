import { describe, expect, it } from 'vitest';
import {
  assertWindowDays,
  canRead,
  canSend,
  DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS,
  isFinalStatus,
  prefixMessage,
  shouldEnd,
} from './rules';

const DAY = 86_400_000;
const endedAt = new Date('2026-10-01T00:00:00Z');
const at = (days: number, ms = 0) =>
  new Date(endedAt.getTime() + days * DAY + ms);
const window = (now: Date, onListAtEnd = true, windowDays?: number) => ({
  onListAtEnd,
  endedAt,
  now,
  ...(windowDays === undefined ? {} : { windowDays }),
});

describe('canRead (mirrors sg_rule_can_read)', () => {
  it('ACTIVE: staff on the list, and owner/admin whatever the list says', () => {
    for (const l of ['agent', 'coordinator', 'team_lead'] as const) {
      expect(canRead(l, 'ACTIVE', true)).toBe(true);
      expect(canRead(l, 'ACTIVE', false)).toBe(false);
    }
    expect(canRead('owner', 'ACTIVE', false)).toBe(true);
    expect(canRead('admin', 'ACTIVE', false)).toBe(true);
    expect(canRead(null, 'ACTIVE', true)).toBe(false);
  });

  it('ENDED: owner/admin always; agents never', () => {
    expect(canRead('owner', 'ENDED', false)).toBe(true);
    expect(canRead('admin', 'ENDED', false, window(at(999)))).toBe(true);
    expect(canRead('agent', 'ENDED', true, window(at(1)))).toBe(false);
  });

  it('ENDED supervisor window: day 59 yes, exactly day 60 no, 1 ms before yes', () => {
    for (const l of ['coordinator', 'team_lead'] as const) {
      expect(canRead(l, 'ENDED', false, window(at(59)))).toBe(true);
      expect(canRead(l, 'ENDED', false, window(at(60, -1)))).toBe(true);
      expect(canRead(l, 'ENDED', false, window(at(60)))).toBe(false);
      expect(canRead(l, 'ENDED', false, window(at(61)))).toBe(false);
    }
    expect(DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS).toBe(60);
  });

  it('ENDED supervisor: not on the list at the end, no window input, or a closed window refuse', () => {
    expect(canRead('coordinator', 'ENDED', true, window(at(1), false))).toBe(
      false
    );
    expect(canRead('coordinator', 'ENDED', true)).toBe(false);
    expect(canRead('team_lead', 'ENDED', false, window(at(0), true, 0))).toBe(
      false
    );
    expect(canRead('team_lead', 'ENDED', false, window(at(0), true, -1))).toBe(
      false
    );
    expect(canRead('team_lead', 'ENDED', false, window(at(5), true, 7))).toBe(
      true
    );
  });
});

describe('canSend', () => {
  it('ACTIVE and on the list only; nobody sends into an ENDED group', () => {
    expect(canSend('agent', 'ACTIVE', true)).toBe(true);
    expect(canSend('coordinator', 'ACTIVE', false)).toBe(false);
    expect(canSend(null, 'ACTIVE', true)).toBe(false);
    expect(canSend('team_lead', 'ENDED', true)).toBe(false);
  });
});

describe('shouldEnd', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  it('a final status ends, case-insensitively, and wins over idle', () => {
    expect(
      shouldEnd({ status: ' approved ', lastActivityAt: now, idleDays: 1, now })
    ).toEqual({ end: true, reason: 'FINAL_STATUS:APPROVED' });
    expect(isFinalStatus('Withdrawn')).toBe(true);
    expect(isFinalStatus('SUBMITTED')).toBe(false);
  });
  it('idle ends at exactly idleDays; null turns idle ending off', () => {
    const last = new Date(now.getTime() - 3 * DAY);
    expect(
      shouldEnd({ status: 'OPEN', lastActivityAt: last, idleDays: 3, now })
    ).toEqual({ end: true, reason: 'IDLE' });
    expect(
      shouldEnd({ status: 'OPEN', lastActivityAt: last, idleDays: 4, now })
    ).toEqual({ end: false });
    expect(
      shouldEnd({ status: 'OPEN', lastActivityAt: last, idleDays: null, now })
    ).toEqual({ end: false });
    expect(() =>
      shouldEnd({ status: 'OPEN', lastActivityAt: last, idleDays: 0, now })
    ).toThrow(RangeError);
  });
});

describe('prefixMessage', () => {
  it('prefixes name and label, collapsing them to one line', () => {
    expect(prefixMessage('Ali', 'Agent', 'hi')).toBe('Ali (Agent): hi');
    expect(prefixMessage('Ali\nFake (Admin): x', 'Agent', 'hi')).toBe(
      'Ali Fake (Admin): x (Agent): hi'
    );
    expect(prefixMessage('Ali', ' ', 'hi')).toBe('Ali: hi');
    expect(() => prefixMessage('  ', 'Agent', 'hi')).toThrow(RangeError);
  });
});

describe('assertWindowDays', () => {
  it('accepts non-negative integers only', () => {
    expect(() => assertWindowDays(0)).not.toThrow();
    expect(() => assertWindowDays(-1)).toThrow(RangeError);
    expect(() => assertWindowDays(1.5)).toThrow(RangeError);
  });
});
