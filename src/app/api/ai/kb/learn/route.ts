import { NextResponse } from 'next/server';
import {
  assertSalesAccess,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  KB_LEARN_SETTINGS_OFF,
  kbLearnSettingsFrom,
  parseKbLearnPut,
} from '@/lib/kb/learn-settings';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/** Postgres or PostgREST naming a table or function 270 adds. */
const notApplied = (error: { code?: string } | null) =>
  ['42P01', 'PGRST205', '42883', 'PGRST202'].includes(error?.code ?? '');

/**
 * GET /api/ai/kb/learn  (admin+)
 *
 * Whether "learn from team answers" (migration 270) is on for the active
 * workspace, and when it last ran. Read through RLS (admin+ only).
 */
export async function GET() {
  try {
    const { supabase, accountId } = assertSalesAccess(
      await requireRole('admin')
    );
    const { data, error } = await supabase
      .from('kb_learn_settings')
      .select('enabled, last_run_at')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      if (notApplied(error))
        return NextResponse.json({
          ...KB_LEARN_SETTINGS_OFF,
          available: false,
        });
      console.error('[ai/kb/learn GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load the setting' },
        { status: 500 }
      );
    }
    return NextResponse.json(kbLearnSettingsFrom(data));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/ai/kb/learn  (admin+)  `{ enabled }`
 *
 * Switches it on or off through `kb_learn_set_enabled`, which checks the
 * caller is an admin+ of their active workspace again in SQL.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, userId } = assertSalesAccess(await requireRole('admin'));
    const limit = checkRateLimit(
      `ai-kb-learn:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const parsed = parseKbLearnPut(await request.json().catch(() => null));
    if (!parsed.ok)
      return NextResponse.json({ error: parsed.error }, { status: 400 });

    const { data, error } = await supabase.rpc('kb_learn_set_enabled', {
      p_enabled: parsed.enabled,
    });
    if (error) {
      if (notApplied(error))
        return NextResponse.json(
          { error: 'Apply migration 270 first' },
          { status: 409 }
        );
      if (error.code === '42501')
        return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
      console.error('[ai/kb/learn PUT] error:', error);
      return NextResponse.json(
        { error: 'Failed to save the setting' },
        { status: 500 }
      );
    }
    return NextResponse.json(
      kbLearnSettingsFrom(data as { enabled?: unknown; last_run_at?: unknown })
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
