import { describe, expect, it } from 'vitest';
import {
  exportBounds,
  exportRangeError,
  mergeExportChannels,
} from './export-range';

describe('exportBounds', () => {
  it('is open on both sides with no usable days', () => {
    expect(exportBounds({ timeZone: 'UTC' })).toEqual({});
    expect(exportBounds({ fromDay: '', toDay: 'x', timeZone: 'UTC' })).toEqual(
      {}
    );
    expect(exportBounds({ fromDay: '2026-02-30', timeZone: 'UTC' })).toEqual(
      {}
    );
  });

  it('uses Asia/Dubai (UTC+4): midnight to the ms before next midnight', () => {
    expect(
      exportBounds({
        fromDay: '2026-03-05',
        toDay: '2026-03-05',
        timeZone: 'Asia/Dubai',
      })
    ).toEqual({
      from: '2026-03-04T20:00:00.000Z',
      to: '2026-03-05T19:59:59.999Z',
    });
  });

  it('follows Europe/London across DST', () => {
    // Clocks go forward on 2026-03-29: that day is 23 h long.
    expect(
      exportBounds({
        fromDay: '2026-03-28',
        toDay: '2026-03-29',
        timeZone: 'Europe/London',
      })
    ).toEqual({
      from: '2026-03-28T00:00:00.000Z',
      to: '2026-03-29T22:59:59.999Z',
    });
    // Clocks go back on 2026-10-25: that day is 25 h long.
    expect(
      exportBounds({
        fromDay: '2026-10-25',
        toDay: '2026-10-25',
        timeZone: 'Europe/London',
      })
    ).toEqual({
      from: '2026-10-24T23:00:00.000Z',
      to: '2026-10-25T23:59:59.999Z',
    });
  });

  it('rolls the next-day bound over a year end', () => {
    expect(exportBounds({ toDay: '2026-12-31', timeZone: 'UTC' }).to).toBe(
      '2026-12-31T23:59:59.999Z'
    );
  });
});

describe('exportRangeError', () => {
  it('flags From after To only', () => {
    expect(exportRangeError('2026-03-06', '2026-03-05')).toBe('order');
    expect(exportRangeError('2026-03-05', '2026-03-05')).toBeNull();
    expect(exportRangeError('2026-03-05', undefined)).toBeNull();
    expect(exportRangeError('', '2026-03-05')).toBeNull();
  });
});

describe('mergeExportChannels', () => {
  const c = (id: string, name: string | null, memberNames: string[] = []) => ({
    id,
    kind: 'team' as const,
    name,
    memberNames,
  });
  it('dedupes by id (first wins) and sorts by label', () => {
    const out = mergeExportChannels(
      [c('b', 'Sales'), c('a', 'Ops')],
      [c('b', 'Dup'), c('d', null, ['Zed', 'Amy'])]
    );
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'd']);
    expect(out[1].name).toBe('Sales');
  });
});
