// ============================================================
// POST /api/insights/meaning-test
//
// "Test a message" in the Flow and Automation builders' "Customer
// means…" trigger (docs/jev-insights.md, "Flows and automations that
// understand meaning"). Body: { description, examples?, sensitivity?,
// message }.
//
// Admin and up: the same role the flow and automation save routes
// require, since only an editor of the trigger has a reason to test it.
// The config is validated exactly as a save is
// (`validateIntentTriggerConfig`). The settings switch and Jev's
// availability are checked first (409 { reason: 'off' | 'unavailable' }),
// then a per-person rate limit, because every click is a Jev request.
//
// One candidate, no recent turns: the sample message is judged on its
// own. Nothing is stored and no memo is touched (this does not go
// through `judgeMeanings`, which keys on a real inbound).
//
// 200 { p, threshold, matches } — `matches` is p ≥ the sensitivity's
// threshold. 502 { reason: 'error' } when the judgment failed.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  meaningThreshold,
  validateIntentTriggerConfig,
} from '@/lib/insights/meaning-config';
import { getInsightSettings, insightsAvailable } from '@/lib/insights/settings';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getDecisionLayer } from '@/lib/typesafe';

const MEANING_TEST_MESSAGE_MAX_CHARS = 1000;

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > MEANING_TEST_MESSAGE_MAX_CHARS) {
      return NextResponse.json(
        {
          error: `Type a sample message of 1–${MEANING_TEST_MESSAGE_MAX_CHARS} characters`,
        },
        { status: 400 }
      );
    }
    const config = {
      description: body.description,
      examples: body.examples,
      sensitivity: body.sensitivity,
    };
    const issues = validateIntentTriggerConfig(config);
    if (issues.length > 0) {
      return NextResponse.json(
        { error: issues[0].message, issues },
        { status: 400 }
      );
    }

    if (!insightsAvailable(accountId)) {
      return NextResponse.json(
        { error: 'Jev is not available', reason: 'unavailable' },
        { status: 409 }
      );
    }
    const settings = await getInsightSettings(accountId);
    if (!settings.meaningTriggersEnabled) {
      return NextResponse.json(
        { error: 'Meaning triggers are turned off', reason: 'off' },
        { status: 409 }
      );
    }

    const limit = checkRateLimit(
      `meaning-test:${userId}`,
      RATE_LIMITS.meaningTestUser
    );
    if (!limit.success) return rateLimitResponse(limit);

    const ts = getDecisionLayer();
    if (!ts) {
      return NextResponse.json(
        { error: 'Jev is not available', reason: 'unavailable' },
        { status: 409 }
      );
    }
    const description = (config.description as string).trim();
    const examples = Array.isArray(config.examples)
      ? (config.examples as string[]).map((e) => e.trim())
      : undefined;
    const res = await ts.intentMatch({
      accountId,
      message,
      recentTurns: [],
      candidates: [{ description, examples }],
    });
    if (!res.ok || typeof res.p[0] !== 'number') {
      return NextResponse.json(
        { error: 'Could not test the message', reason: 'error' },
        { status: 502 }
      );
    }
    const p = res.p[0];
    const threshold = meaningThreshold(config.sensitivity);
    return NextResponse.json({ p, threshold, matches: p >= threshold });
  } catch (err) {
    return toErrorResponse(err);
  }
}
