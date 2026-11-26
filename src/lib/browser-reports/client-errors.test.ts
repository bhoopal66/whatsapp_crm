import { describe, expect, it } from 'vitest';

import {
  buildReport,
  engineMessage,
  maskPath,
  parseReport,
  reportLine,
  stackFrames,
  worthReporting,
} from './client-errors';

const ID = '75fe3779-2dc0-4f04-b6df-38e33774e67c';

/** An error as V8 makes it: the stack begins with the message. */
function thrown(message: string, Ctor: ErrorConstructor = Error): Error {
  const err = new Ctor(message);
  err.stack = `${err.name}: ${message}\n    at A (https://h/_next/a.js:1:2)`;
  return err;
}
const logged = (err: unknown, path = '/inbox') => {
  const report = buildReport('error', err, path);
  const parsed = report && parseReport(JSON.parse(JSON.stringify(report)));
  return parsed ? reportLine(parsed, 'ab12cd34') : null;
};

describe('engineMessage', () => {
  it.each([
    "Cannot read properties of undefined (reading 'map')",
    "Cannot set properties of null (setting 'value')",
    'e.filter is not a function',
    'x is not defined',
    "Cannot access 'a' before initialization",
    'Maximum call stack size exceeded',
    'Loading chunk 12 failed',
  ])('keeps %j', (text) => {
    expect(engineMessage(text)).toBe(text);
  });

  it('keeps only the engine’s part of a longer message', () => {
    expect(
      engineMessage(
        "Failed to execute 'removeChild' on 'Node': The node Ahmed is not a child"
      )
    ).toBe("Failed to execute 'removeChild' on 'Node'");
    expect(
      engineMessage(
        'Minified React error #418; visit https://react.dev/errors/418?args[]=Ahmed'
      )
    ).toBe('Minified React error #418');
  });

  it.each([
    'Ahmed Ali has been blocked, notes: loan of 50k',
    'No chat for ahmed@bank.ae, phone +971 50 123 4567',
    'URL constructor: Ahmed Ali is not a valid URL.',
    `Unexpected token 'H', "Hello Ahmed" is not valid JSON`,
    'رسالة من أحمد',
    'Key (phone)=(971501234567) already exists.',
    '971501234567 is not a function',
    '',
  ])('withholds %j', (text) => {
    expect(engineMessage(text)).toBeNull();
  });
});

describe('nothing typed or received reaches the log', () => {
  it.each([
    'No chat for ahmed@bank.ae, phone +971 50 123 4567 Ahmed Ali',
    'at the bank he asked for 971501234567',
    'two lines\n    at Ahmed Ali 971501234567:1:2\nahmed@bank.ae:3:4',
    'a JID 971501234567@c.us:12:3',
    `Message "مرحبا احمد" bad`,
    'Ahmed (https://wacrm.example/inbox?q=ahmed)',
  ])('not from the message or its lines: %j', (message) => {
    for (const Ctor of [Error, TypeError, SyntaxError, RangeError]) {
      const line = logged(thrown(message, Ctor as ErrorConstructor));
      expect(line).not.toMatch(/ahmed|ali|971|bank|c\.us|[^\x20-\x7e]/i);
      expect(line).toContain('A a.js:1:2');
    }
  });

  it('not from a thrown text', () => {
    expect(logged('Ahmed Ali has been blocked')).toBe(
      '[client-error] error /inbox user=ab12cd34 ThrownText: (message withheld)'
    );
  });

  it('not from what a browser posts by hand', () => {
    const got = parseReport({
      kind: 'error',
      name: 'Ahmed Ali',
      message: 'Ahmed Ali',
      frames: [
        'Error: a@b.ae 971501234567',
        'Ahmed Ali a.js:1:2',
        'f a.js:1:2',
        7,
      ],
      path: `/contacts/${ID}?q=ahmed`,
      digest: 'a b',
      extra: 'ignored',
    });
    expect(got).toEqual({
      kind: 'error',
      name: 'Error',
      message: null,
      frames: ['f a.js:1:2'],
      path: '/contacts/<id>',
      digest: null,
    });
  });
});

describe('maskPath', () => {
  it('keeps the screen, not whose', () => {
    expect(maskPath(`/contacts/${ID}?tab=notes#x`)).toBe('/contacts/<id>');
    expect(maskPath('/settings?tab=api&token=abc')).toBe('/settings');
    expect(maskPath(`/join/${'a'.repeat(64)}`)).toBe('/join/<x>');
    expect(maskPath('/join/AbC-12_x')).toBe('/join/<x>');
    expect(maskPath('/c/971501234567')).toBe('/c/<x>');
    expect(maskPath('/contacts/Ahmed%20Ali')).toBe('/contacts/<x>');
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
          '    at Object.onClick (https://wacrm.example/a/b.js:9:8)',
          'render@https://wacrm.example/_next/static/chunks/ff.js:5:6',
        ].join('\n')
      )
    ).toEqual([
      'MessageBubble 0abc.js:1:2379',
      '9z.js:3:4',
      'Object.onClick b.js:9:8',
      'render ff.js:5:6',
    ]);
  });

  it('a line without an address and a position is no frame', () => {
    expect(
      stackFrames('Error: a@b.ae 971501234567\n    at f (https://h/a.js:1:2)')
    ).toEqual(['f a.js:1:2']);
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
  it('what is logged of an ordinary break', () => {
    expect(
      logged(
        thrown(
          "Cannot read properties of undefined (reading 'map')",
          TypeError as ErrorConstructor
        ),
        `/inbox/${ID}`
      )
    ).toBe(
      "[client-error] error /inbox/<id> user=ab12cd34 TypeError: Cannot read properties of undefined (reading 'map') | A a.js:1:2"
    );
  });

  it('carries the digest that matches the server log', () => {
    const err = Object.assign(thrown('An error occurred'), {
      digest: '1234567890',
    });
    expect(logged(err)).toContain('digest=1234567890');
  });

  it.each([null, 'x', {}, { kind: 'other', name: 'x' }, { kind: 'error' }])(
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
