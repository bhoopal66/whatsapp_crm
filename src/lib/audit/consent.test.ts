import { describe, expect, it } from 'vitest';

import { dayRange, guestsOnPatch, normaliseBankCode } from './consent';

const ME = '11111111-1111-4111-8111-111111111111';

describe('normaliseBankCode', () => {
  it('trims and upper-cases, as the column CHECK wants', () => {
    expect(normaliseBankCode('  mashreq ')).toBe('MASHREQ');
    expect(normaliseBankCode('emirates_nbd')).toBe('EMIRATES_NBD');
  });

  it('refuses an empty, spaced, odd or over-long code', () => {
    for (const bad of ['', '   ', 'AB CD', 'ADCB!', '-X', 'A'.repeat(33)]) {
      expect(normaliseBankCode(bad), bad).toBeNull();
    }
  });
});

describe('guestsOnPatch', () => {
  const base = { note: '', userId: ME, today: '2026-10-12' };

  it('stamps the DSA date at noon UTC, who checked it, and the note', () => {
    expect(
      guestsOnPatch({ ...base, checkedOn: '2026-10-01', note: ' DSA v3 ' })
    ).toEqual({
      ok: true,
      patch: {
        guests_allowed: true,
        dsa_checked_at: '2026-10-01T12:00:00.000Z',
        dsa_checked_by: ME,
        note: 'DSA v3',
      },
    });
    const today = guestsOnPatch({ ...base, checkedOn: '2026-10-12' });
    expect(today.ok && today.patch.note).toBeNull();
  });

  it('requires a real date that is not in the future', () => {
    for (const bad of ['', '2026-02-30', '01/10/2026']) {
      expect(guestsOnPatch({ ...base, checkedOn: bad })).toEqual({
        ok: false,
        error: 'dateRequired',
      });
    }
    expect(guestsOnPatch({ ...base, checkedOn: '2026-10-13' })).toEqual({
      ok: false,
      error: 'dateInFuture',
    });
  });

  it('keeps the note within the column limit', () => {
    expect(
      guestsOnPatch({
        ...base,
        checkedOn: '2026-10-01',
        note: 'x'.repeat(2001),
      })
    ).toEqual({ ok: false, error: 'noteTooLong' });
  });
});

describe('dayRange', () => {
  it('runs from the start of the first day to the start of the day after the last', () => {
    const { from, to } = dayRange('2026-10-01', '2026-10-01');
    expect(Date.parse(to!) - Date.parse(from!)).toBe(24 * 3600 * 1000);
    expect(new Date(from!).getDate()).toBe(1);
  });

  it('leaves an empty or malformed bound open', () => {
    expect(dayRange('', 'nope')).toEqual({ from: null, to: null });
  });
});
