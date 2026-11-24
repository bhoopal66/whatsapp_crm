import { describe, expect, it } from 'vitest';

import {
  buildReport,
  maskPath,
  maskText,
  parseReport,
  reportLine,
  stackFrames,
  worthReporting,
} from './client-errors';

const ID = '75fe3779-2dc0-4f04-b6df-38e33774e67c';

describe('maskText', () => {
  it('takes out ids, numbers, emails and long quotes', () => {
    expect(
      maskText(
        `row ${ID} of +971 50 123 4567 (ali@bank.ae) said "I would like to know the charges please"`
      )
    ).toBe('row <id> of +<n> (<email>) said "<text>"');
    expect(maskText('رقم ٠٥٠١٢٣٤٥٦٧')).toBe('رقم <n>');
  });

  it('leaves code words and short numbers alone', () => {
    const text = "Cannot read properties of undefined (reading 'map') at 404";
    expect(maskText(text)).toBe(text);
  });
});

describe('maskPath', () => {
  it('keeps the screen, not whose', () => {
    expect(maskPath(`/contacts/${ID}?tab=notes#x`)).toBe('/contacts/<id>');
    expect(maskPath('/settings?tab=api&token=abc')).toBe('/settings');
    expect(maskPath(`/join/${'a'.repeat(64)}`)).toBe('/join/<x>');
    expect(maskPath('/c/971501234567')).toBe('/c/<x>');
    expect(maskPath('')).toBe('/');
  });
});

describe('stackFrames', () => {
  it('keeps names and places, not addresses', () => {
    expect(
      stackFrames(
        [
          'TypeError: x',
          '    at MessageBubble (https://wacrm.example/_next/static/chunks/0abc.js:1:2379)',
          '    at async https://wacrm.example/_next/static/chunks/9z.js?v=2:3:4',
          'render@https://wacrm.example/_next/static/chunks/ff.js:5:6',
        ].join('\n')
      )
    ).toEqual([
      'MessageBubble 0abc.js:1:2379',
      '9z.js:3:4',
      'render ff.js:5:6',
    ]);
  });

  it('is short', () => {
    const stack = Array.from(
      { length: 50 },
      (_, i) => `    at f${i} (https://h/a.js:${i}:1)`
    ).join('\n');
    expect(stackFrames(stack)).toHaveLength(8);
  });
});

describe('worthReporting', () => {
  it.each([
    'ResizeObserver loop completed with undelivered notifications.',
    'Script error.',
    'AbortError: The user aborted a request.',
    'TypeError: Failed to fetch',
    'TypeError: Load failed',
    'NotAllowedError: play() failed',
    '',
  ])('not %j', (message) => {
    expect(worthReporting(message, '')).toBe(false);
  });

  it("not an extension's own error", () => {
    expect(
      worthReporting('TypeError: x', 'at f (chrome-extension://abc/c.js:1:1)')
    ).toBe(false);
  });

  it('a break of ours', () => {
    expect(worthReporting("TypeError: can't read 'map'", '')).toBe(true);
    expect(worthReporting('ChunkLoadError: Loading chunk 12 failed', '')).toBe(
      true
    );
  });
});

describe('buildReport and parseReport', () => {
  it('a thrown error, masked at both ends', () => {
    const err = new TypeError(`no contact ${ID} on 971501234567`);
    err.stack = `TypeError: x\n    at A (https://h/_next/a.js:1:2)`;
    const report = buildReport('boundary', err, `/inbox/${ID}`);
    expect(report).toEqual({
      kind: 'boundary',
      message: 'TypeError: no contact <id> on <n>',
      frames: ['A a.js:1:2'],
      path: '/inbox/<id>',
      digest: null,
    });
    expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it('the server masks what a browser did not', () => {
    const got = parseReport({
      kind: 'error',
      message: `row ${ID}\nline two 971501234567`,
      frames: [`f ${ID}`, 7, 'x'.repeat(500)],
      path: `/contacts/${ID}?q=ali`,
      digest: 'a b',
      extra: 'ignored',
    });
    expect(got).toEqual({
      kind: 'error',
      message: 'row <id> line two <n>',
      frames: ['f <id>', 'x'.repeat(160)],
      path: '/contacts/<id>',
      digest: null,
    });
  });

  it.each([null, 'x', {}, { kind: 'other', message: 'x' }, { kind: 'error' }])(
    'refuses %j',
    (body) => {
      expect(parseReport(body)).toBeNull();
    }
  );

  it('nothing for a thrown undefined or an aborted fetch', () => {
    expect(buildReport('rejection', undefined, '/')).toBeNull();
    expect(
      buildReport('rejection', new DOMException('x', 'AbortError'), '/')
    ).toBeNull();
  });
});

it('reportLine is one line', () => {
  expect(
    reportLine(
      {
        kind: 'error',
        message: 'TypeError: x',
        frames: ['A a.js:1:2', 'B b.js:3:4'],
        path: '/inbox',
        digest: '123',
      },
      'ab12cd34'
    )
  ).toBe(
    '[client-error] error /inbox user=ab12cd34 digest=123 TypeError: x | A a.js:1:2 < B b.js:3:4'
  );
});
