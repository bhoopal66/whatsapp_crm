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
  it('caches an answer for the TTL, then asks again', async () => {
    let t = 0;
    const load = vi.fn(async () => ({ allowedOrigins: ['https://a.com'] }));
    const lookup = createFrameOriginsLookup({
      load,
      ttlMs: 1000,
      now: () => t,
    });
    expect(await lookup('x')).toEqual(['https://a.com']);
    t = 999;
    expect(await lookup('x')).toEqual(['https://a.com']);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1000;
    await lookup('x');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('answers [] for an unknown form', async () => {
    const lookup = createFrameOriginsLookup({ load: async () => null });
    expect(await lookup('x')).toEqual([]);
  });

  it('fails closed on an error and does not cache it', async () => {
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

  it('keeps the cache bounded', async () => {
    const load = vi.fn(async () => ({ allowedOrigins: [] }));
    const lookup = createFrameOriginsLookup({ load, maxEntries: 2 });
    await lookup('a');
    await lookup('b');
    await lookup('c'); // evicts a
    await lookup('b');
    expect(load).toHaveBeenCalledTimes(3);
    await lookup('a');
    expect(load).toHaveBeenCalledTimes(4);
  });
});
