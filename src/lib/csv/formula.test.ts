import { describe, expect, it } from 'vitest';

import { exportToCsv } from '@/lib/chat/export';
import { csvCell as callCell } from '@/lib/pbx/call-stats-ui';
import { attendanceCsv } from '@/lib/meetings/attendance';
import { csvCell, neutraliseFormula } from './build';

describe('neutraliseFormula', () => {
  it.each(['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠'])(
    'a leading %j',
    (c) => expect(neutraliseFormula(`${c}x`)).toBe(`'${c}x`)
  );

  it.each([
    ['Ali;=1+1', "Ali;'=1+1"],
    ['Ali\t@x', "Ali\t'@x"],
    ['Ali\n=1+1', "Ali\n'=1+1"],
    ['Ali\r\n-1', "Ali\r\n'-1"],
    ['Ali;＝1', "Ali;'＝1"],
    ['=a;+b', "'=a;'+b"],
  ])('%j becomes %j', (from, to) => expect(neutraliseFormula(from)).toBe(to));

  it.each(['Ali', '971501234567', 'a-b', 'a; b', 'x=1', '2026-11-23', 'a+b@c'])(
    'leaves %j',
    (text) => expect(neutraliseFormula(text)).toBe(text)
  );
});

describe('every hand-built CSV uses it', () => {
  it('the report builder: a number stays a number, a phone is text', () => {
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell('+971501234567')).toBe('"\'+971501234567"');
    expect(csvCell('a;=1')).toBe('"a;\'=1"');
  });

  it('the call report', () => {
    expect(callCell(-5)).toBe('-5');
    expect(callCell('a;=1')).toBe("a;'=1");
  });

  it('the team chat export', () => {
    const csv = exportToCsv({
      messages: [
        {
          createdAt: '2026-11-23T00:00:00Z',
          authorName: 'Ali;=1',
          body: 'x\n＝1',
          attachments: [],
        },
      ],
    } as unknown as Parameters<typeof exportToCsv>[0]);
    expect(csv).toContain("Ali;'=1");
    expect(csv).toContain("x\n'＝1");
  });

  it('the meeting attendance', () => {
    const csv = attendanceCsv([], () => '', {
      ...Object.fromEntries(
        ['joined', 'left', 'minutes', 'seats', 'removed'].map((k) => [k, k])
      ),
      name: '＝1',
    } as unknown as Parameters<typeof attendanceCsv>[2]);
    expect(csv).toContain("'＝1");
  });
});
