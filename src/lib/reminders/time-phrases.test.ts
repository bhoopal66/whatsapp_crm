import { describe, expect, it } from 'vitest';

import { REMINDER_HOUR } from '@/lib/tasks/reminder';

import { findTimePhrases, type TimeCandidate } from './time-phrases';

const DXB = 'Asia/Dubai';
/** Wednesday 2026-11-11 10:00 in Dubai. */
const MORNING = new Date('2026-11-11T06:00:00Z');
/** Wednesday 2026-11-11 21:30 in Dubai. */
const EVENING = new Date('2026-11-11T17:30:00Z');

function find(
  text: string,
  now: Date = MORNING,
  timeZone = DXB,
  max?: number
): TimeCandidate[] {
  return findTimePhrases(text, { now, timeZone, max });
}

/** A Dubai wall-clock time as the ISO instant the parser returns. */
const dxb = (local: string) => new Date(`${local}:00+04:00`).toISOString();

/** [text, Dubai local 'YYYY-MM-DDTHH:MM', dateOnly] — exactly one candidate. */
type Row = [string, string, boolean];

function expectOne(
  text: string,
  local: string,
  dateOnly: boolean,
  now = MORNING
) {
  const got = find(text, now);
  expect(got).toHaveLength(1);
  expect(got[0].at).toBe(dxb(local));
  expect(got[0].dateOnly).toBe(dateOnly);
}

describe('findTimePhrases: English days', () => {
  it.each<Row>([
    ['tomorrow', '2026-11-12T09:00', true],
    ['tmrw', '2026-11-12T09:00', true],
    ['tmr', '2026-11-12T09:00', true],
    ['tomorow', '2026-11-12T09:00', true],
    ['day after tomorrow', '2026-11-13T09:00', true],
    ['the day after tomorrow', '2026-11-13T09:00', true],
    ['tonight', '2026-11-11T20:00', false],
    ['today at 3pm', '2026-11-11T15:00', false],
    ['on Sunday', '2026-11-15T09:00', true],
    ['Monday', '2026-11-16T09:00', true],
    ['this Friday', '2026-11-13T09:00', true],
    ['next Friday', '2026-11-13T09:00', true],
    ['coming Saturday', '2026-11-14T09:00', true],
    ['Wednesday', '2026-11-18T09:00', true],
    ['Wednesday at 3pm', '2026-11-11T15:00', false],
    ['Wednesday at 9am', '2026-11-18T09:00', false],
    ['fri 3pm', '2026-11-13T15:00', false],
    ['next week', '2026-11-18T09:00', true],
    ['next month', '2026-12-11T09:00', true],
    ['end of the month', '2026-11-30T09:00', true],
    ['end of month', '2026-11-30T09:00', true],
  ])('%s', (text, local, dateOnly) => expectOne(text, local, dateOnly));

  it('"today" alone after 09:00 has passed is nothing', () => {
    expect(find('today')).toEqual([]);
  });

  it.each(['fri', 'sat down', 'sun is out', 'wed', 'mon'])(
    'a bare abbreviation is not a weekday: %s',
    (text) => expect(find(text)).toEqual([])
  );

  it('next month clamps to the last day of the month', () => {
    const now = new Date('2026-01-31T06:00:00Z');
    expect(find('next month', now)[0].at).toBe(dxb('2026-02-28T09:00'));
  });

  it('end of month on its last day: before 09:00 counts, after is skipped', () => {
    expect(find('end of month', new Date('2026-11-30T03:00:00Z'))[0].at).toBe(
      dxb('2026-11-30T09:00')
    );
    expect(find('end of month', new Date('2026-11-30T06:00:00Z'))).toEqual([]);
  });
});

describe('findTimePhrases: English relative', () => {
  it.each<Row>([
    ['in 2 hours', '2026-11-11T12:00', false],
    ['in 30 minutes', '2026-11-11T10:30', false],
    ['in 5 mins', '2026-11-11T10:05', false],
    ['in an hour', '2026-11-11T11:00', false],
    ['in 1 hr', '2026-11-11T11:00', false],
    ['in half an hour', '2026-11-11T10:30', false],
    ['after a couple of hours', '2026-11-11T12:00', false],
    ['in a few minutes', '2026-11-11T10:03', false],
    ['in twelve hours', '2026-11-11T22:00', false],
    ['in three days', '2026-11-14T09:00', true],
    ['in 2 weeks', '2026-11-25T09:00', true],
    ['in a month', '2026-12-11T09:00', true],
    ['in 2 days at 4pm', '2026-11-13T16:00', false],
  ])('%s', (text, local, dateOnly) => expectOne(text, local, dateOnly));
});

describe('findTimePhrases: English dates', () => {
  it.each<Row>([
    ['on 15/11', '2026-11-15T09:00', true],
    ['15/11 at 4', '2026-11-15T16:00', false],
    ['15-11 at 4pm', '2026-11-15T16:00', false],
    ['15.11 at 4pm', '2026-11-15T16:00', false],
    ['15/11/2026', '2026-11-15T09:00', true],
    ['15/11/26', '2026-11-15T09:00', true],
    ['15 Nov', '2026-11-15T09:00', true],
    ['15th November', '2026-11-15T09:00', true],
    ['Nov 15', '2026-11-15T09:00', true],
    ['November 15th', '2026-11-15T09:00', true],
    ['15 Nov 2027', '2027-11-15T09:00', true],
    ['on the 15th', '2026-11-15T09:00', true],
    ['on the 5th', '2026-12-05T09:00', true],
    ['on the 11th', '2026-12-11T09:00', true],
    ['on 10/11', '2027-11-10T09:00', true],
    ['on 1/1', '2027-01-01T09:00', true],
  ])('%s', (text, local, dateOnly) => expectOne(text, local, dateOnly));

  it.each(['15/11', '15.11', 'on 31/02', 'on 15/11/2025', 'on 29/02'])(
    'not a candidate: %s',
    (text) => expect(find(text)).toEqual([])
  );
});

describe('findTimePhrases: English times', () => {
  it.each<Row>([
    ['3pm', '2026-11-11T15:00', false],
    ['3 pm', '2026-11-11T15:00', false],
    ['3:30pm', '2026-11-11T15:30', false],
    ['3.30 pm', '2026-11-11T15:30', false],
    ['3 p.m.', '2026-11-11T15:00', false],
    ['15:00', '2026-11-11T15:00', false],
    ['at 3', '2026-11-11T15:00', false],
    ["at 3 o'clock", '2026-11-11T15:00', false],
    ['at 3 o’clock', '2026-11-11T15:00', false],
    ['at 12', '2026-11-11T12:00', false],
    ['at 11', '2026-11-11T11:00', false],
    ['at 15.00', '2026-11-11T15:00', false],
    ['at 9', '2026-11-12T09:00', false],
    ['at 8', '2026-11-12T08:00', false],
    ['10am', '2026-11-12T10:00', false],
    ['9am', '2026-11-12T09:00', false],
    ['noon', '2026-11-11T12:00', false],
    ['midday', '2026-11-11T12:00', false],
    ['in the afternoon', '2026-11-11T15:00', false],
    ['in the morning', '2026-11-12T09:00', false],
    ['this evening', '2026-11-11T18:00', false],
    ['at night', '2026-11-11T20:00', false],
    ['end of day', '2026-11-11T17:00', false],
    ['by EOD', '2026-11-11T17:00', false],
  ])('%s', (text, local, dateOnly) => expectOne(text, local, dateOnly));

  it.each(['morning', 'good morning', 'Good night', '15.00'])(
    'not a candidate: %s',
    (text) => expect(find(text)).toEqual([])
  );
});

describe('findTimePhrases: combinations', () => {
  it.each<[string, string, string]>([
    ['tomorrow at 3pm', 'tomorrow at 3pm', '2026-11-12T15:00'],
    ['3pm tomorrow', '3pm tomorrow', '2026-11-12T15:00'],
    ['Monday 10am', 'Monday 10am', '2026-11-16T10:00'],
    ['on 15/11 at 4', 'on 15/11 at 4', '2026-11-15T16:00'],
    ['tomorrow morning', 'tomorrow morning', '2026-11-12T09:00'],
    ['tomorrow, around 3', 'tomorrow, around 3', '2026-11-12T15:00'],
    ['tonight at 9', 'tonight at 9', '2026-11-11T21:00'],
    [
      'tomorrow at 10 in the morning',
      'tomorrow at 10 in the morning',
      '2026-11-12T10:00',
    ],
    ['at 4 on Friday', 'at 4 on Friday', '2026-11-13T16:00'],
    ['Nov 15 at 3pm', 'Nov 15 at 3pm', '2026-11-15T15:00'],
  ])('%s', (text, phrase, local) => {
    const got = find(text);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      phrase,
      index: 0,
      at: dxb(local),
      dateOnly: false,
    });
  });

  it('a day and a time far apart stay two candidates', () => {
    const got = find('tomorrow I will be free after work, at 3pm');
    expect(got.map((c) => [c.phrase, c.at, c.dateOnly])).toEqual([
      ['tomorrow', dxb('2026-11-12T09:00'), true],
      ['at 3pm', dxb('2026-11-11T15:00'), false],
    ]);
  });

  it('phrase and index point into the original text', () => {
    const text = 'Please call me Tomorrow at 3PM, thanks';
    const [c] = find(text);
    expect(c.phrase).toBe('Tomorrow at 3PM');
    expect(c.index).toBe(15);
    expect(text.slice(c.index, c.index + c.phrase.length)).toBe(c.phrase);
  });
});

describe('findTimePhrases: in the evening (21:30)', () => {
  it.each<Row>([
    ['at 3', '2026-11-12T15:00', false],
    ['3pm', '2026-11-12T15:00', false],
    ['tonight at 11', '2026-11-11T23:00', false],
    ['in 2 hours', '2026-11-11T23:30', false],
    ['in the evening', '2026-11-12T18:00', false],
    ['tomorrow', '2026-11-12T09:00', true],
  ])('%s', (text, local, dateOnly) =>
    expectOne(text, local, dateOnly, EVENING)
  );

  it.each(['tonight', 'today', 'this morning', 'الليلة'])(
    'already over: %s',
    (text) => expect(find(text, EVENING)).toEqual([])
  );
});

describe('findTimePhrases: never a candidate', () => {
  it.each([
    'AED 3,000',
    '3,000 dirhams',
    'the rate is 3.5%',
    'it costs $15.00',
    'call 0501234567',
    'my number is +971 50 123 4567',
    'we are open 24/7',
    'update to v2.3',
    'since 2026',
    'my 1st time',
    'yesterday',
    'yesterday at 3pm',
    '3pm yesterday',
    'last week',
    'last Monday',
    '2 days ago',
    'earlier today',
    'at 3,000',
    'امس',
    'أمس الساعة 3',
    'البارحة',
    'الأسبوع الماضي',
    'قبل يومين',
    'الخميس الماضي',
    'مساء الخير',
    'صباح الخير',
  ])('%s', (text) => expect(find(text)).toEqual([]));

  it('an amount next to a day leaves the day', () => {
    const got = find('I will pay AED 3,000 tomorrow');
    expect(got.map((c) => c.phrase)).toEqual(['tomorrow']);
  });
});

describe('findTimePhrases: Arabic days', () => {
  it.each<Row>([
    ['بكرة', '2026-11-12T09:00', true],
    ['بكره', '2026-11-12T09:00', true],
    ['بكرا', '2026-11-12T09:00', true],
    ['غدا', '2026-11-12T09:00', true],
    ['غداً', '2026-11-12T09:00', true],
    ['غدًا', '2026-11-12T09:00', true],
    ['باچر', '2026-11-12T09:00', true],
    ['باكر', '2026-11-12T09:00', true],
    ['وبكرة', '2026-11-12T09:00', true],
    ['بعد بكرة', '2026-11-13T09:00', true],
    ['بعد بكره', '2026-11-13T09:00', true],
    ['بعد غد', '2026-11-13T09:00', true],
    ['الليلة', '2026-11-11T20:00', false],
    ['الليله', '2026-11-11T20:00', false],
    ['اليوم الساعة 3', '2026-11-11T15:00', false],
    ['يوم الأحد', '2026-11-15T09:00', true],
    ['الاحد', '2026-11-15T09:00', true],
    ['الاثنين', '2026-11-16T09:00', true],
    ['الإثنين', '2026-11-16T09:00', true],
    ['الاتنين', '2026-11-16T09:00', true],
    ['الثلاثاء', '2026-11-17T09:00', true],
    ['الثلاثا', '2026-11-17T09:00', true],
    ['الأربعاء', '2026-11-18T09:00', true],
    ['الاربعا', '2026-11-18T09:00', true],
    ['الخميس', '2026-11-12T09:00', true],
    ['الجمعة', '2026-11-13T09:00', true],
    ['الجمعه', '2026-11-13T09:00', true],
    ['السبت', '2026-11-14T09:00', true],
    ['الخميس الجاي', '2026-11-12T09:00', true],
    ['الجمعة الجاية', '2026-11-13T09:00', true],
    ['الأحد القادم', '2026-11-15T09:00', true],
    ['الأسبوع الجاي', '2026-11-18T09:00', true],
    ['الاسبوع القادم', '2026-11-18T09:00', true],
    ['الشهر الجاي', '2026-12-11T09:00', true],
    ['الشهر القادم', '2026-12-11T09:00', true],
    ['آخر الشهر', '2026-11-30T09:00', true],
    ['اخر الشهر', '2026-11-30T09:00', true],
    ['نهاية الشهر', '2026-11-30T09:00', true],
  ])('%s', (text, local, dateOnly) => expectOne(text, local, dateOnly));
});

describe('findTimePhrases: Arabic relative', () => {
  it.each<Row>([
    ['بعد ساعة', '2026-11-11T11:00', false],
    ['بعد ساعه', '2026-11-11T11:00', false],
    ['بعد ساعتين', '2026-11-11T12:00', false],
    ['بعد 3 ساعات', '2026-11-11T13:00', false],
    ['بعد نص ساعة', '2026-11-11T10:30', false],
    ['بعد نصف ساعة', '2026-11-11T10:30', false],
    ['بعد 10 دقايق', '2026-11-11T10:10', false],
    ['بعد ٥ دقائق', '2026-11-11T10:05', false],
    ['بعد يوم', '2026-11-12T09:00', true],
    ['بعد يومين', '2026-11-13T09:00', true],
    ['بعد 3 أيام', '2026-11-14T09:00', true],
    ['بعد أسبوع', '2026-11-18T09:00', true],
    ['بعد اسبوعين', '2026-11-25T09:00', true],
    ['بعد شهر', '2026-12-11T09:00', true],
    ['بعد شهرين', '2027-01-11T09:00', true],
  ])('%s', (text, local, dateOnly) => expectOne(text, local, dateOnly));
});

describe('findTimePhrases: Arabic times', () => {
  it.each<Row>([
    ['الساعة 4', '2026-11-11T16:00', false],
    ['الساعه ٤', '2026-11-11T16:00', false],
    ['الساعة 11', '2026-11-11T11:00', false],
    ['الساعة 4 ونص', '2026-11-11T16:30', false],
    ['4 وربع', '2026-11-11T16:15', false],
    ['4 الا ربع', '2026-11-11T15:45', false],
    ['4 إلا ربع', '2026-11-11T15:45', false],
    ['الصبح', '2026-11-12T09:00', false],
    ['الصباح', '2026-11-12T09:00', false],
    ['الظهر', '2026-11-11T12:00', false],
    ['العصر', '2026-11-11T16:00', false],
    ['المغرب', '2026-11-11T18:00', false],
    ['المسا', '2026-11-11T18:00', false],
    ['المساء', '2026-11-11T18:00', false],
    ['بالليل', '2026-11-11T20:00', false],
    ['11 الصبح', '2026-11-11T11:00', false],
    ['4 العصر', '2026-11-11T16:00', false],
    ['2 الظهر', '2026-11-11T14:00', false],
    ['8 بالليل', '2026-11-11T20:00', false],
    ['الساعة 7 مساءً', '2026-11-11T19:00', false],
    ['الساعة 10 صباحا', '2026-11-12T10:00', false],
  ])('%s', (text, local, dateOnly) => expectOne(text, local, dateOnly));

  it.each<[string, string, string]>([
    ['بكرة الساعة 4', 'بكرة الساعة 4', '2026-11-12T16:00'],
    ['الساعة 4 بكرة', 'الساعة 4 بكرة', '2026-11-12T16:00'],
    ['بكره العصر', 'بكره العصر', '2026-11-12T16:00'],
    ['الخميس الساعة 10', 'الخميس الساعة 10', '2026-11-12T10:00'],
    ['بكرة على الساعة 3', 'بكرة على الساعة 3', '2026-11-12T15:00'],
  ])('combines %s', (text, phrase, local) => {
    const got = find(text);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      phrase,
      index: 0,
      at: dxb(local),
      dateOnly: false,
    });
  });

  it('keeps Arabic-Indic digits and indices of the original text', () => {
    const text = 'كلمني بكرة الساعة ٤';
    const [c] = find(text);
    expect(c).toEqual({
      phrase: 'بكرة الساعة ٤',
      index: 6,
      at: dxb('2026-11-12T16:00'),
      dateOnly: false,
    });
  });

  it('reads a mixed Arabic and English message', () => {
    const got = find('ok بكرة at 3pm, or الخميس');
    expect(got.map((c) => [c.phrase, c.at])).toEqual([
      ['بكرة at 3pm', dxb('2026-11-12T15:00')],
      ['الخميس', dxb('2026-11-12T09:00')],
    ]);
  });
});

describe('findTimePhrases: output', () => {
  it('dedupes by instant, keeping the first', () => {
    const got = find('tomorrow at 9am or tmrw 9am');
    expect(got).toHaveLength(1);
    expect(got[0].phrase).toBe('tomorrow at 9am');
  });

  it('keeps at most `max`, default 4, in order of appearance', () => {
    const text = 'Sunday, Monday, Tuesday, Thursday, Friday, Saturday';
    expect(find(text).map((c) => c.phrase)).toEqual([
      'Sunday',
      'Monday',
      'Tuesday',
      'Thursday',
    ]);
    expect(find(text, MORNING, DXB, 2)).toHaveLength(2);
  });

  it('trims the phrase to 80 characters', () => {
    const got = find(`on 15/11 at 4${' '.repeat(3)}`);
    expect(got[0].phrase.length).toBeLessThanOrEqual(80);
    expect(got[0].phrase).toBe('on 15/11 at 4');
  });

  it('only returns instants strictly after now', () => {
    for (const c of find('10am, 3pm, tonight, tomorrow')) {
      expect(new Date(c.at).getTime()).toBeGreaterThan(MORNING.getTime());
    }
  });

  it('empty text is nothing', () => {
    expect(find('')).toEqual([]);
  });
});

describe('findTimePhrases: time zones', () => {
  it('a date-only day lands on REMINDER_HOUR', () => {
    const [c] = find('tomorrow');
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: DXB,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(c.at))
    );
    expect(hour).toBe(REMINDER_HOUR);
  });

  it('UTC', () => {
    const now = new Date('2026-11-11T10:00:00Z');
    expect(find('tomorrow at 3pm', now, 'UTC')[0].at).toBe(
      '2026-11-12T15:00:00.000Z'
    );
    expect(find('tomorrow', now, 'UTC')[0].at).toBe('2026-11-12T09:00:00.000Z');
  });

  // Clocks go back at 02:00 BST on Sunday 2026-10-25.
  const LONDON_AUTUMN = new Date('2026-10-24T09:00:00Z'); // Sat 10:00 BST
  it.each([
    ['at 3', '2026-10-24T14:00:00.000Z'],
    ['tomorrow at 3pm', '2026-10-25T15:00:00.000Z'],
    ['tomorrow', '2026-10-25T09:00:00.000Z'],
    ['Monday 10am', '2026-10-26T10:00:00.000Z'],
    ['in 2 days', '2026-10-26T09:00:00.000Z'],
  ])('Europe/London across the autumn change: %s', (text, at) => {
    expect(find(text, LONDON_AUTUMN, 'Europe/London')[0].at).toBe(at);
  });

  // Clocks go forward at 01:00 GMT on Sunday 2026-03-29.
  it('Europe/London across the spring change', () => {
    const now = new Date('2026-03-28T12:00:00Z'); // Sat 12:00 GMT
    expect(find('tomorrow at 9am', now, 'Europe/London')[0].at).toBe(
      '2026-03-29T08:00:00.000Z'
    );
    expect(find('in 24 hours', now, 'Europe/London')[0].at).toBe(
      '2026-03-29T12:00:00.000Z'
    );
  });
});

describe('findTimePhrases: ranges, weekday hours, negation, rates', () => {
  /** Tuesday 2026-11-24 14:30 in Dubai. */
  const TUE = new Date('2026-11-24T10:30:00Z');
  const one = (text: string, local: string, dateOnly = false) =>
    expectOne(text, local, dateOnly, TUE);

  it.each<Row>([
    ['tomorrow between 2 and 4', '2026-11-25T14:00', false],
    ['tomorrow between 2 and 4 pm', '2026-11-25T14:00', false],
    ['tomorrow between 9 and 11 pm', '2026-11-25T21:00', false],
    ['tomorrow between 10 and 12', '2026-11-25T10:00', false],
    ['بكرة بين 2 و 4', '2026-11-25T14:00', false],
    ['بكرة بين ٣ و ٥ العصر', '2026-11-25T15:00', false],
  ])('range: %s', (text, local, dateOnly) => one(text, local, dateOnly));

  it('the end of a range is not a second suggestion', () => {
    expect(find('between 2 and 4 pm', TUE)).toHaveLength(1);
    expect(find('بين 2 و 4', TUE)).toHaveLength(1);
  });

  it.each<Row>([
    ['call sunday 11', '2026-11-29T11:00', false],
    ['call sunday 11, please', '2026-11-29T11:00', false],
    ['next Sunday 4', '2026-11-29T16:00', false],
  ])('a bare hour after a weekday: %s', (text, local, dateOnly) =>
    one(text, local, dateOnly)
  );

  it.each(['sunday 11 nov', 'sunday 11/12', 'sunday 11 people', 'sunday 25'])(
    'a bare number after a weekday that is no hour: %s',
    (text) => {
      const got = find(text, TUE);
      expect(got.every((c) => c.at !== dxb('2026-11-29T11:00'))).toBe(true);
    }
  );

  it.each([
    "don't call tomorrow",
    'do not call tomorrow',
    'dont call me tomorrow',
    'never call tomorrow',
    'please not tomorrow',
    'لا تتصل بكرة',
    'مو بكرة',
    'مش بكرة',
  ])('a negated time is nothing: %s', (text) =>
    expect(find(text, TUE)).toEqual([])
  );

  it('a question or a new clause still suggests', () => {
    one("why don't you call tomorrow", '2026-11-25T09:00', true);
    one("can't today, call me tomorrow at 5", '2026-11-25T17:00');
    one('not now. call tomorrow at 5', '2026-11-25T17:00');
  });

  it.each([
    'the rate is 3.5 at 12 months',
    'at 12 months',
    'at 5 years',
    'at 3 yrs',
    'at 6 شهر',
    'الساعه 12 سنه',
    'profit 3.5 per year',
    'interest 3.5',
    'تمويل 3.5 لمده 12 شهر',
  ])('a rate or a term is no time: %s', (text) =>
    expect(find(text, TUE)).toEqual([])
  );

  it('a real time next to a rate still counts', () => {
    one('the rate is 3.5, call tomorrow at 5', '2026-11-25T17:00');
  });
});
