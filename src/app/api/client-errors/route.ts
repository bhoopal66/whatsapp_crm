import { NextResponse } from 'next/server';

import { parseReport, reportLine } from '@/lib/browser-reports/client-errors';
import { createRepeatGate } from '@/lib/browser-reports/repeat-gate';
import { isAuthUnavailable } from '@/lib/auth/auth-unavailable';
import { clientIp } from '@/lib/edge/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { createClient } from '@/lib/supabase/server';

const MAX_BYTES = 8_192;
/** The same break, once per ten minutes, with how often it was held back. */
const gate = createRepeatGate({ windowMs: 10 * 60_000, maxKeys: 300 });

/**
 * A staff browser's report of a screen that broke. Signed-in people only;
 * the answer never says whether it was kept, and nothing here may throw
 * into a page that is already failing.
 */
export async function POST(request: Request) {
  const done = new NextResponse(null, { status: 204 });
  try {
    const length = Number(request.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0 || length > MAX_BYTES) {
      return done;
    }
    // Per address first, so that one noisy browser (or a stranger, who is
    // told nothing) leaves everyone else's reports their room.
    const ip = clientIp(request.headers) ?? 'unknown';
    if (
      !checkRateLimit(`client-errors:ip:${ip}`, {
        limit: 120,
        windowMs: 60_000,
      }).success ||
      !checkRateLimit('client-errors', { limit: 600, windowMs: 60_000 }).success
    ) {
      return done;
    }
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    // An outage of the auth service: the report is not worth a fight.
    if (isAuthUnavailable(authError) || !user) return done;
    if (
      !checkRateLimit(`client-errors:${user.id}`, {
        limit: 20,
        windowMs: 60_000,
      }).success
    ) {
      return done;
    }
    const report = parseReport(await request.json().catch(() => null));
    if (!report) return done;
    const said = gate.admit(
      `${report.kind}|${report.name}|${report.message ?? ''}|${report.frames[0] ?? report.path}`
    );
    if (said) {
      console.warn(
        reportLine(report, user.id.slice(0, 8)) +
          (said.held > 0 ? ` (+${said.held} more like it)` : '')
      );
    }
  } catch (err) {
    console.error(
      '[client-error] report not kept:',
      err instanceof Error ? err.message : err
    );
  }
  return done;
}
