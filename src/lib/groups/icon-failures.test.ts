import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../../../next.config';
import { iconChanged, iconFailed, markIconFailed } from './icon-failures';

// Untyped in next: the matcher its header rules go through.
const { pathToRegexp } = createRequire(import.meta.url)(
  'next/dist/compiled/path-to-regexp'
) as { pathToRegexp: (source: string) => RegExp };

afterEach(() => vi.useRealTimers());

describe('group pictures that did not load', () => {
  it('are remembered for ten minutes, per group', () => {
    vi.useFakeTimers();
    markIconFailed('g1', 0);
    expect(iconFailed('g1', 0)).toBe(true);
    expect(iconFailed('g2', 0)).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(iconFailed('g1', 0)).toBe(false);
  });

  it('are tried again after a change, whatever the browser kept', () => {
    markIconFailed('g3', 0);
    markIconFailed('g3', 1);
    const fetchImpl = vi.fn(async () => new Response());
    iconChanged('g3', 0, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    iconChanged('g3', 1, fetchImpl);
    expect(iconFailed('g3', 0)).toBe(false);
    expect(iconFailed('g3', 1)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith('/api/whatsapp/groups/g3/icon?v=0', {
      cache: 'reload',
    });
  });
});

describe("next.config's no-store rule for /api", () => {
  it('leaves only the group picture to its route', async () => {
    const config = nextConfig as { headers(): Promise<{ source: string }[]> };
    const rules = await config.headers();
    const matches = (path: string) =>
      rules.some(
        (r) => r.source.startsWith('/api/') && pathToRegexp(r.source).test(path)
      );
    expect(matches('/api/whatsapp/groups/abc/icon')).toBe(false);
    for (const path of [
      '/api/whatsapp/groups',
      '/api/whatsapp/groups/abc',
      '/api/whatsapp/groups/abc/icon/x',
      '/api/whatsapp/groups/abc/messages',
      '/api/v1/contacts',
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });
});
