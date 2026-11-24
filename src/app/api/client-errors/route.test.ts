import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

import { POST as postCsp } from '../csp-report/route';
import { POST } from './route';

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
beforeEach(() => {
  warn.mockClear();
  h.user = { id: 'ab12cd34-0000-4000-8000-000000000000' };
});

function req(url: string, body: string, headers: Record<string, string> = {}) {
  return new Request(`http://x${url}`, {
    method: 'POST',
    body,
    headers: { 'content-length': String(body.length), ...headers },
  });
}
const report = (message: string) =>
  JSON.stringify({
    kind: 'error',
    name: 'TypeError',
    message: 'x is not defined',
    frames: [`${message} a.js:1:2`],
    path: '/inbox',
  });

describe('POST /api/client-errors', () => {
  it('logs a signed-in person’s report once, and answers 204', async () => {
    const res = await POST(req('/api/client-errors', report('one')));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      '[client-error] error /inbox user=ab12cd34 TypeError: x is not defined | one a.js:1:2'
    );
    await POST(req('/api/client-errors', report('one')));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing from a signed-out browser, a long body or junk', async () => {
    h.user = null;
    expect((await POST(req('/api/client-errors', report('two')))).status).toBe(
      204
    );
    h.user = { id: 'u-2' };
    await POST(req('/api/client-errors', report('x'.repeat(9_000))));
    await POST(req('/api/client-errors', '{nope'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops at 20 a minute per person', async () => {
    h.user = { id: 'u-3-loop' };
    for (let i = 0; i < 40; i++) {
      const name = `${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10)]}`;
      await POST(req('/api/client-errors', report(name)));
    }
    expect(warn).toHaveBeenCalledTimes(20);
  });
});

describe('POST /api/csp-report', () => {
  it('logs the rule, the origin and the screen, once', async () => {
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://w.example/settings?token=x',
        'effective-directive': 'connect-src',
        'blocked-uri': 'https://evil.example/a?b=c',
      },
    });
    const send = () =>
      postCsp(
        req('/api/csp-report', body, {
          'content-type': 'application/csp-report',
        })
      );
    expect((await send()).status).toBe(204);
    await send();
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[csp] connect-src would block https://evil.example on /settings',
    ]);
  });
});
