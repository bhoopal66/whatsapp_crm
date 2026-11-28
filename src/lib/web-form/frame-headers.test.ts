import { describe, expect, it, vi } from 'vitest';

import { contentSecurityPolicy } from '@/lib/csp';

import {
  FRAME_ANCESTORS_NONE,
  frameAncestorSources,
  frameHeadersFor,
  withFrameAncestors,
} from './frame-headers';
import { createFrameOriginsLookup } from './frame-lookup';
import { MAX_ALLOWED_ORIGINS } from './origin';

const NONE = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
};

describe('frameHeadersFor', () => {
  it('forbids framing for no list, an empty list or only garbage', () => {
    expect(frameHeadersFor(null)).toEqual(NONE);
    expect(frameHeadersFor(undefined)).toEqual(NONE);
    expect(frameHeadersFor([])).toEqual(NONE);
    expect(
      frameHeadersFor([
        '',
        '   ',
        '*',
        'https://*',
        'https://*.example.com',
        'https:',
        'https://',
        'http://www.example.com',
        'http://localhost:3000',
        'https://example.com/path',
        'https://user@example.com',
        "'self'",
        "'none'",
        'data:',
        42,
        null,
      ] as unknown[])
    ).toEqual(NONE);
  });

  it('allows the normalised, de-duplicated origins and drops XFO', () => {
    expect(
      frameHeadersFor([
        'https://www.Example.com/',
        ' https://www.example.com ',
        'https://shop.example.com:8443',
        'not an origin',
      ])
    ).toEqual({
      'Content-Security-Policy':
        'frame-ancestors https://www.example.com https://shop.example.com:8443',
    });
  });

  it('never lets an entry add a directive or a source', () => {
    for (const evil of [
      'https://a.com; script-src *',
      'https://a.com;frame-ancestors *',
      'https://a.com\nframe-ancestors *',
      'https://a.com\r\nX-Frame-Options: ALLOWALL',
      "https://a.com 'unsafe-inline'",
      'https://a.com https://b.com',
      'https://a.com,https://b.com',
      'https://a.com"',
      "https://a.com'",
    ]) {
      const h = frameHeadersFor([evil]);
      expect(h).toEqual(NONE);
    }
    // Only the clean entry of a mixed list survives.
    const h = frameHeadersFor(['https://a.com; script-src *', 'https://b.com']);
    expect(h['Content-Security-Policy']).toBe('frame-ancestors https://b.com');
    expect(h['X-Frame-Options']).toBeUndefined();
  });

  it('caps the number of sources', () => {
    const many = Array.from(
      { length: MAX_ALLOWED_ORIGINS + 10 },
      (_, i) => `https://s${i}.example.com`
    );
    expect(frameAncestorSources(many)).toHaveLength(MAX_ALLOWED_ORIGINS);
  });

  it('restates frame-ancestors in the Report-Only policy and leaves the rest', () => {
    const base = contentSecurityPolicy({});
    const open = frameHeadersFor(['https://a.com'], { reportOnlyCsp: base });
    expect(open['Content-Security-Policy-Report-Only']).toBe(
      base.replace("frame-ancestors 'none'", 'frame-ancestors https://a.com')
    );
    const closed = frameHeadersFor([], { reportOnlyCsp: base });
    expect(closed['Content-Security-Policy-Report-Only']).toBe(base);
  });

  it('appends frame-ancestors to a policy that has none', () => {
    expect(withFrameAncestors("default-src 'self'", FRAME_ANCESTORS_NONE)).toBe(
      "default-src 'self'; frame-ancestors 'none'"
    );
  });
});

describe('createFrameOriginsLookup', () => {
  it('reads the row on every request: a removed origin stops at once', async () => {
    let origins = ['https://a.com'];
    const load = vi.fn(async () => ({ allowedOrigins: origins }));
    const lookup = createFrameOriginsLookup({ load });
    expect(await lookup('x')).toEqual(['https://a.com']);
    origins = [];
    expect(await lookup('x')).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one read between requests that overlap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = vi.fn(async () => {
      await gate;
      return { allowedOrigins: ['https://a.com'] };
    });
    const lookup = createFrameOriginsLookup({ load });
    const both = Promise.all([lookup('x'), lookup('x')]);
    release();
    expect(await both).toEqual([['https://a.com'], ['https://a.com']]);
    expect(load).toHaveBeenCalledTimes(1);
    await lookup('x');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('answers [] for an unknown form', async () => {
    const lookup = createFrameOriginsLookup({ load: async () => null });
    expect(await lookup('x')).toEqual([]);
  });

  it('fails closed on an error, and asks again next time', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ allowedOrigins: ['https://a.com'] });
    const lookup = createFrameOriginsLookup({ load });
    expect(await lookup('x')).toEqual([]);
    expect(await lookup('x')).toEqual(['https://a.com']);
  });

  it('fails closed on a timeout', async () => {
    const lookup = createFrameOriginsLookup({
      load: () => new Promise(() => {}),
      timeoutMs: 5,
    });
    expect(await lookup('x')).toEqual([]);
  });

  it('keeps the in-flight map bounded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = vi.fn(async () => {
      await gate;
      return { allowedOrigins: [] };
    });
    const lookup = createFrameOriginsLookup({ load, maxEntries: 1 });
    const all = Promise.all([lookup('a'), lookup('b'), lookup('b')]);
    release();
    await all;
    // 'a' was shared-capable, 'b' (over the cap) read once per request.
    expect(load).toHaveBeenCalledTimes(3);
  });
});
