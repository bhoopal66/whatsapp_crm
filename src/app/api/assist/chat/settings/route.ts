// ============================================================
// /api/assist/chat/settings — the workspace's chat-assistant switch
// (migration 323).
//
// GET (any member) → { enabled, canUse, canToggle }: the panel shows its
// button to agents and up while it is on, and to owners and admins
// always, so they can switch it on.
// PUT { enabled: boolean } (owner / admin) → { enabled }. The SQL
// function checks admin+ of the ACTIVE account again.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { canUseChatAssistant } from '@/lib/auth/roles';
import { canToggleChatAssist } from '@/lib/chat-assist/gate';
import {
  readChatAssistEnabled,
  setChatAssistEnabled,
} from '@/lib/chat-assist/settings';

export async function GET() {
  try {
    const { supabase, accountId, role } = await getCurrentAccount();
    return NextResponse.json({
      enabled: await readChatAssistEnabled(supabase, accountId),
      canUse: canUseChatAssistant(role),
      canToggle: canToggleChatAssist(role),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, role } = await getCurrentAccount();
    if (!canToggleChatAssist(role))
      return NextResponse.json(
        { error: 'Only an owner or admin can change this.' },
        { status: 403 }
      );
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (typeof body?.enabled !== 'boolean')
      return NextResponse.json(
        { error: 'enabled must be true or false' },
        { status: 400 }
      );
    const res = await setChatAssistEnabled(supabase, body.enabled);
    if (!res.ok)
      return NextResponse.json(
        {
          error:
            res.reason === 'forbidden'
              ? 'Only an owner or admin can change this.'
              : 'Failed to save the setting',
        },
        { status: res.reason === 'forbidden' ? 403 : 500 }
      );
    return NextResponse.json({ enabled: res.enabled });
  } catch (err) {
    return toErrorResponse(err);
  }
}
