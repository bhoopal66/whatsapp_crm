import { NextResponse } from 'next/server';

import { parseCspReport, worthKeeping } from '@/lib/browser-reports/csp-report';
import { createRepeatGate } from '@/lib/browser-reports/repeat-gate';
import { clientIp } from '@/lib/edge/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';

const MAX_BYTES = 16_384;
const gate = createRepeatGate({ windowMs: 6 * 3_600_000, maxKeys: 200 });

/**
 * Where browsers report what the Content-Security-Policy would block
 * (`report-uri`, src/lib/csp.ts). No session: the browser sends these by
 * itself, from the sign-in page too. Only the rule, the blocked origin and
 * the screen are logged, each once per six hours.
 */
export async function POST(request: Request) {
  const done = new NextResponse(null, { status: 204 });
  try {
    const length = Number(request.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0 || length > MAX_BYTES) {
      return done;
    }
    const ip = clientIp(request.headers) ?? 'unknown';
    if (
      !checkRateLimit(`csp-report:ip:${ip}`, { limit: 60, windowMs: 60_000 })
        .success ||
      !checkRateLimit('csp-report', { limit: 300, windowMs: 60_000 }).success
    ) {
      return done;
    }
    const body: unknown = await request.json().catch(() => null);
    for (const v of parseCspReport(body).filter(worthKeeping)) {
      const said = gate.admit(`${v.directive}|${v.blocked}|${v.path}`);
      if (said) {
        console.warn(
          `[csp] ${v.directive} would block ${v.blocked} on ${v.path}` +
            (said.held > 0 ? ` (+${said.held} since)` : '')
        );
      }
    }
  } catch (err) {
    console.error(
      '[csp] report not kept:',
      err instanceof Error ? err.message : err
    );
  }
  return done;
}
