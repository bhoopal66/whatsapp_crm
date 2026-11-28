import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertWindowDays,
  canRead,
  canSend,
  CLOSE_HOLD_DAYS,
  DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS,
  DEFAULT_FINAL_STATUSES,
  inviteCodeOf,
  isFinalStatus,
  phoneWasRefused,
  prefixMessage,
  shouldEnd,
  welcomeMessage,
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
  it('333: an owner/admin sends to an ACTIVE group unlisted, never to an ENDED one', () => {
    expect(canSend('owner', 'ACTIVE', false)).toBe(true);
    expect(canSend('admin', 'ACTIVE', false)).toBe(true);
    expect(canSend('owner', 'ENDED', false)).toBe(false);
    expect(canSend('admin', 'ENDED', true)).toBe(false);
    expect(canSend('agent', 'ACTIVE', false)).toBe(false);
    expect(canSend(null, 'ACTIVE', false)).toBe(false);
    expect(canSend('agent', 'ACTIVE', true)).toBe(true);
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

describe('isFinalStatus (migration 166)', () => {
  it("counts Compass's withdrawn labels, read as case_status_key reads them", () => {
    expect(isFinalStatus('Customer Withdrawn')).toBe(true);
    expect(isFinalStatus('customer_withdrawn')).toBe(true);
    expect(isFinalStatus(' AGENCY  WITHDRAWN ')).toBe(true);
    expect(isFinalStatus('Approved')).toBe(true);
  });
  it('leaves open statuses open', () => {
    expect(isFinalStatus('Bank Review')).toBe(false);
    expect(isFinalStatus('Awaiting Fulfillment')).toBe(false);
    expect(isFinalStatus('Withdrawn by bank')).toBe(false);
  });
  it('reads only ASCII blanks, as SQL does', () => {
    expect(isFinalStatus('Customer\tWithdrawn\n')).toBe(true);
    expect(isFinalStatus('Customer\u00a0Withdrawn')).toBe(false);
    expect(isFinalStatus('\ufeffApproved')).toBe(false);
  });
  it('equals the WHEN keys of case_final_stage_for_status', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'supabase/migrations/166_compass_finished_statuses.sql'
      ),
      'utf8'
    );
    const body = sql.match(
      /FUNCTION public\.case_final_stage_for_status\(p text\)[\s\S]*?\$\$([\s\S]*?)\$\$/
    );
    expect(body).not.toBeNull();
    const keys = [...body![1].matchAll(/WHEN '([^']+)'/g)].map((m) => m[1]);
    expect([...keys].sort()).toEqual([...DEFAULT_FINAL_STATUSES].sort());
  });
});

describe('CLOSE_HOLD_DAYS', () => {
  it("equals 170's sg_close_hold()", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'supabase/migrations/170_submission_group_system_messages.sql'
      ),
      'utf8'
    );
    const m = sql.match(
      /FUNCTION public\.sg_close_hold\(\)[\s\S]*?SELECT interval '(\d+) days'/
    );
    expect(m?.[1]).toBe(String(CLOSE_HOLD_DAYS));
  });
});

describe('welcomeMessage (170)', () => {
  const full = {
    customerName: 'Aisha',
    product: 'Personal loan',
    bankName: 'ADCB',
  };
  const tail =
    " Our *coordinators* are here with you: they'll post updates and ask for any documents the bank needs.\n\nAsk us anything here at any time.\n_Taamul Credit team_";

  it('names the customer, product and bank', () => {
    expect(welcomeMessage(full)).toBe(
      'Hello Aisha 👋\n\nThis group is for your *Personal loan* application with *ADCB*.' +
        tail
    );
  });

  it('greets without a name', () => {
    expect(welcomeMessage({ ...full, customerName: null })).toMatch(
      /^Hello 👋\n\n/
    );
    expect(welcomeMessage({ ...full, customerName: '  ' })).toMatch(
      /^Hello 👋\n\n/
    );
  });

  it('falls back to the generic sentence without a product or without a bank', () => {
    const generic =
      'This group is for your application with Taamul Credit.' + tail;
    expect(welcomeMessage({ ...full, product: null })).toContain(generic);
    expect(welcomeMessage({ ...full, bankName: ' ' })).toContain(generic);
  });

  it('collapses whitespace and strips formatting characters', () => {
    expect(
      welcomeMessage({
        customerName: '  *Ai_sha*\n  ~Khan ',
        product: 'Home\t  loan',
        bankName: '_*FAB*~',
      })
    ).toMatch(
      /^Hello Aisha Khan 👋\n\nThis group is for your \*Home loan\* application with \*FAB\*\./
    );
  });
});

describe('phoneWasRefused / inviteCodeOf', () => {
  it('matches wa ids and JIDs by digits', () => {
    expect(
      phoneWasRefused(['971501234567@s.whatsapp.net'], '971501234567')
    ).toBe(true);
    expect(phoneWasRefused(['971501234567'], '+971 50 123 4567')).toBe(true);
    expect(phoneWasRefused(['971509999999'], '971501234567')).toBe(false);
    expect(phoneWasRefused([], '971501234567')).toBe(false);
  });

  it('matches every form of the phone, as the group add sends it', () => {
    expect(phoneWasRefused(['971501234567'], '00971501234567')).toBe(true);
    expect(
      phoneWasRefused(['971501234567@s.whatsapp.net'], '+00971 50 123 4567')
    ).toBe(true);
    expect(phoneWasRefused(['971501234567'], '9710501234567')).toBe(true);
    expect(phoneWasRefused(['9710501234567'], '971501234567')).toBe(true);
    expect(phoneWasRefused(['971509999999'], '00971501234567')).toBe(false);
    expect(phoneWasRefused(['971501234567'], '')).toBe(false);
  });

  it('reads the code of a chat.whatsapp.com link only', () => {
    expect(inviteCodeOf('https://chat.whatsapp.com/AbC123')).toBe('AbC123');
    expect(inviteCodeOf('https://evil.example/AbC123')).toBeNull();
    expect(inviteCodeOf(null)).toBeNull();
  });
});
