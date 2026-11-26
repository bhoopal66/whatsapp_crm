import { describe, expect, it } from 'vitest';

import { parseCspReport, worthKeeping } from './csp-report';
import { createRepeatGate } from './repeat-gate';

const PAGE =
  'https://wacrm.example/contacts/75fe3779-2dc0-4f04-b6df-38e33774e67c?q=ali';

describe('parseCspReport', () => {
  it('reads the report-uri form, without the addresses', () => {
    expect(
      parseCspReport({
        'csp-report': {
          'document-uri': PAGE,
          'violated-directive': "img-src 'self'",
          'effective-directive': 'img-src',
          'blocked-uri': 'http://pics.example/a/b.png?who=ali',
        },
      })
    ).toEqual([
      {
        directive: 'img-src',
        blocked: 'http://pics.example',
        path: '/contacts/<id>',
      },
    ]);
  });

  it('reads the Reporting API form and skips other reports', () => {
    expect(
      parseCspReport([
        { type: 'deprecation', body: {} },
        {
          type: 'csp-violation',
          body: {
            documentURL: PAGE,
            effectiveDirective: 'script-src-elem',
            blockedURL: 'inline',
          },
        },
      ])
    ).toEqual([
      {
        directive: 'script-src-elem',
        blocked: 'inline',
        path: '/contacts/<id>',
      },
    ]);
  });

  it.each([null, 'x', {}, [], { 'csp-report': { 'blocked-uri': 'x' } }])(
    'nothing from %j',
    (body) => {
      expect(parseCspReport(body)).toEqual([]);
    }
  );

  it('an extension is not ours', () => {
    expect(
      worthKeeping({
        directive: 'script-src',
        blocked: 'chrome-extension://abc',
        path: '/',
      })
    ).toBe(false);
  });
});

describe('createRepeatGate', () => {
  it('says a thing once per window and counts what it held back', () => {
    const gate = createRepeatGate({ windowMs: 1_000, maxKeys: 10 });
    expect(gate.admit('a', 0)).toEqual({ held: 0 });
    expect(gate.admit('a', 10)).toBeNull();
    expect(gate.admit('a', 20)).toBeNull();
    expect(gate.admit('b', 20)).toEqual({ held: 0 });
    expect(gate.admit('a', 1_000)).toEqual({ held: 2 });
  });

  it('stays small whatever it is fed', () => {
    const gate = createRepeatGate({ windowMs: 1_000, maxKeys: 3 });
    for (let i = 0; i < 100; i++) gate.admit(`k${i}`, 0);
    expect(gate.size()).toBeLessThanOrEqual(4);
    // Room again once the window has passed.
    expect(gate.admit('later', 2_000)).toEqual({ held: 0 });
    expect(gate.size()).toBeLessThanOrEqual(4);
  });
});
