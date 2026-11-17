import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isMissingFunction } from '@/lib/team-activity/db-errors';
import {
  DEFAULT_NEW_CHAT_NOTICE,
  parseNewChatNotice,
  parseNoticeInput,
} from '@/lib/team-activity/new-chat-notice';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Db = Awaited<ReturnType<typeof requireRole>>['supabase'];

/** The caller's notice; a database without migration 207 gets the default. */
async function readNotice(supabase: Db) {
  const { data, error } = await supabase.rpc('team_activity_new_chat_notice');
  if (error) {
    if (isMissingFunction(error)) return { ...DEFAULT_NEW_CHAT_NOTICE };
    throw error;
  }
  return parseNewChatNotice(data);
}

/**
 * GET /api/team-activity/new-chat-notice (any staff role) → { notice }
 *
 * The reminder shown to people about to open a chat with a new client
 * (migration 207).
 */
export async function GET() {
  try {
    const { supabase } = await requireRole('viewer');
    try {
      return NextResponse.json({ notice: await readNotice(supabase) });
    } catch (e) {
      console.error(
        '[team-activity/new-chat-notice] read failed:',
        (e as { message?: string })?.message
      );
      return NextResponse.json(
        { error: 'Failed to load the reminder' },
        { status: 500 }
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/team-activity/new-chat-notice (admin+), body
 * `{ enabled, channelId, text }` → { notice }
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `team-activity-new-chat-notice:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = parseNoticeInput(json);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { error } = await supabase
      .from('team_activity_new_chat_notice')
      .upsert(
        {
          account_id: accountId,
          enabled: parsed.value.enabled,
          marketing_channel_id: parsed.value.channelId,
          notice_text: parsed.value.text,
        },
        { onConflict: 'account_id' }
      );

    if (error) {
      // 22023: a personal number; 23503: a number of another account.
      if (error.code === '22023' || error.code === '23503') {
        return NextResponse.json(
          { error: "That number can't be the marketing number" },
          { status: 400 }
        );
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
      }
      console.error(
        '[team-activity/new-chat-notice] save failed:',
        error.message
      );
      return NextResponse.json(
        { error: 'Failed to save the reminder' },
        { status: 500 }
      );
    }

    try {
      return NextResponse.json({ notice: await readNotice(supabase) });
    } catch {
      return NextResponse.json(
        { error: 'Saved, but failed to reload the reminder' },
        { status: 500 }
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
