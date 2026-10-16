import { describe, expect, it } from 'vitest';

import { datesKey, gridScrollTime, shouldScrollToNow } from './grid-scroll';

const utc = (iso: string) => Date.parse(iso);

describe('gridScrollTime', () => {
  it('opens an hour before now in the zone', () => {
    // 15:10 UTC is 19:10 in Dubai.
    expect(gridScrollTime('Asia/Dubai', utc('2026-10-16T15:10:00Z'))).toBe(
      '18:00:00'
    );
    expect(gridScrollTime('UTC', utc('2026-10-16T15:10:00Z'))).toBe('14:00:00');
  });

  it('never goes before midnight', () => {
    expect(gridScrollTime('UTC', utc('2026-10-16T00:30:00Z'))).toBe('00:00:00');
  });
});

describe('shouldScrollToNow', () => {
  const week = datesKey(
    'timeGridWeek',
    '2026-10-12T00:00:00+04:00',
    '2026-10-19T00:00:00+04:00'
  );

  it('scrolls the first time a view shows', () => {
    expect(shouldScrollToNow(null, week)).toBe(true);
  });

  it('does not scroll when the same dates are delivered again', () => {
    // FullCalendar re-fires datesSet on every rebuilt date profile; a
    // re-scroll then moved a clicked event out from under its popover.
    expect(
      shouldScrollToNow(
        week,
        datesKey(
          'timeGridWeek',
          '2026-10-12T00:00:00+04:00',
          '2026-10-19T00:00:00+04:00'
        )
      )
    ).toBe(false);
  });

  it('does not scroll when only the zone arrived late', () => {
    const inUtc = datesKey(
      'timeGridWeek',
      '2026-10-12T00:00:00Z',
      '2026-10-19T00:00:00Z'
    );
    expect(shouldScrollToNow(inUtc, week)).toBe(false);
  });

  it('scrolls on a new week or a new view', () => {
    expect(
      shouldScrollToNow(
        week,
        datesKey(
          'timeGridWeek',
          '2026-10-19T00:00:00+04:00',
          '2026-10-26T00:00:00+04:00'
        )
      )
    ).toBe(true);
    expect(
      shouldScrollToNow(
        week,
        datesKey(
          'timeGridDay',
          '2026-10-12T00:00:00+04:00',
          '2026-10-13T00:00:00+04:00'
        )
      )
    ).toBe(true);
  });
});
