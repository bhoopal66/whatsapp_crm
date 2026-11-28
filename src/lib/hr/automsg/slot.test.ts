import { describe, expect, it } from 'vitest';
import { formatInterviewSlot, slotFor } from './slot';
import { MAX_PARAM_LENGTH, SLOT_FALLBACK, render } from './templates';

// 11:00 UTC is 15:00 in Dubai (UTC+4, no daylight saving).
const AT = '2026-11-30T11:00:00Z';

describe('formatInterviewSlot', () => {
  it('writes the time in Dubai time, in English', () => {
    const s = formatInterviewSlot(AT, 'en');
    expect(s).toContain('Monday');
    expect(s).toContain('30 November');
    expect(s).toContain('15:00');
    expect(s).not.toContain('11:00');
  });

  it('writes the time in Dubai time, in Arabic', () => {
    const s = formatInterviewSlot(AT, 'ar');
    expect(s).toContain('الاثنين'); // الاثنين
    expect(s).toContain('نوفمبر'); // نوفمبر
    expect(s).toContain('03:00');
    expect(s).not.toBe(formatInterviewSlot(AT, 'en'));
  });

  it('crosses the date line into Dubai time', () => {
    // 21:30 UTC on the 30th is 01:30 on 1 December in Dubai.
    const s = formatInterviewSlot('2026-11-30T21:30:00Z', 'en');
    expect(s).toContain('1 December');
    expect(s).toContain('01:30');
  });

  it('falls back when the time is missing, blank or invalid', () => {
    for (const v of [undefined, null, '', '  ', 'not a date', '2026-13-45'])
      expect(formatInterviewSlot(v, 'en')).toBe(SLOT_FALLBACK);
  });

  it('always meets the render rules', () => {
    for (const lang of ['en', 'ar'] as const) {
      const s = formatInterviewSlot(AT, lang);
      expect(s.length).toBeLessThanOrEqual(MAX_PARAM_LENGTH);
      expect(render('on {slot}.', { slot: s })).toBe(`on ${s}.`);
    }
  });
});

describe('slotFor', () => {
  it('an interview reminder takes params.interview_at', () => {
    expect(
      slotFor(
        { trigger: 'interview_reminder', params: { interview_at: AT } },
        'en'
      )
    ).toBe(formatInterviewSlot(AT, 'en'));
  });

  it('an interview reminder without a usable time falls back', () => {
    expect(slotFor({ trigger: 'interview_reminder', params: {} }, 'en')).toBe(
      SLOT_FALLBACK
    );
    expect(
      slotFor(
        { trigger: 'interview_reminder', params: { interview_at: 'soon' } },
        'ar'
      )
    ).toBe(SLOT_FALLBACK);
  });

  it('any other trigger keeps the fallback, even with a time', () => {
    expect(
      slotFor(
        { trigger: 'stage_hr_interview', params: { interview_at: AT } },
        'en'
      )
    ).toBe(SLOT_FALLBACK);
  });
});
