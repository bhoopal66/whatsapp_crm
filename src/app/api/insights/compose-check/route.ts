import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  checkDraft,
  COMPOSE_CHECK_BUDGET_MS,
} from '@/lib/insights/compose-check';

/** The longest draft the check accepts. */
const MAX_TEXT_CHARS = 4096;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/insights/compose-check { conversationId, text }
 *   → { warnings, eventId }
 * "Message check before sending": the composer asks before a send.
 * The conversation must be visible to the caller (their RLS client);
 * checkDraft gates itself and never throws.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const body = (json ?? {}) as Record<string, unknown>;
    const { conversationId, text } = body;
    if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId))
      return NextResponse.json(
        { error: 'conversationId must be a uuid' },
        { status: 400 }
      );
    if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS)
      return NextResponse.json(
        {
          error: `text must be a string of at most ${MAX_TEXT_CHARS} characters`,
        },
        { status: 400 }
      );

    const limit = checkRateLimit(
      `compose-check:${userId}`,
      RATE_LIMITS.composeCheckUser
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { data: conversation, error } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[compose-check POST] visibility error:', error.message);
      return NextResponse.json(
        { error: 'Failed to check the message' },
        { status: 500 }
      );
    }
    if (!conversation)
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );

    const result = await checkDraft({
      accountId,
      userId,
      conversationId,
      text,
      db: supabase,
      deadlineAt: startedAt + COMPOSE_CHECK_BUDGET_MS,
    });
    return NextResponse.json({
      warnings: result.warnings,
      eventId: result.eventId,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
