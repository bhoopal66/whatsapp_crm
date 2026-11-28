// ============================================================
// POST /api/assist/chat/[conversationId]/run — run ONE suggested
// action the person has already confirmed (migration 323).
//
// Body: { pendingId, tool, args } — exactly what the card carried.
//
// The panel first confirms through POST /api/assist/pending/[id] (the
// HumanOrigin is minted from the session there). Here the same tool and
// arguments go back through 019a's guarded router with the pending id:
// the guard consumes the pending action only if it is confirmed, the
// caller's own, in the active workspace, unexpired, unused, and its
// arguments hash to what was confirmed; only then does the handler run,
// on the caller's own client. Anything else is refused and runs nothing.
// ============================================================

import { NextResponse, after } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { chatAssistGate, chatAssistRefusalBody } from '@/lib/chat-assist/gate';
import { chatAssistHandlers } from '@/lib/chat-assist/handlers';
import {
  chatAssistContext,
  createChatAssistRouter,
  runConfirmed,
} from '@/lib/chat-assist/router';
import { readChatAssistEnabled } from '@/lib/chat-assist/settings';
import { isChatAssistWriteTool, parseToolArgs } from '@/lib/chat-assist/tools';

// A tag change dispatches automations in after().
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_ERRORS = new Set([
  'bad_args',
  'not_found',
  'refused',
  'changed',
  'invalid',
  'failed',
]);

type Params = { params: Promise<{ conversationId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();
    const { conversationId } = await params;
    if (!UUID.test(conversationId))
      return NextResponse.json({ error: 'Invalid chat id' }, { status: 400 });

    const gate = chatAssistGate({
      role,
      enabled: await readChatAssistEnabled(supabase, accountId),
    });
    if (!gate.ok)
      return NextResponse.json(chatAssistRefusalBody(gate.reason), {
        status: 403,
      });

    const body = (await request.json().catch(() => null)) as {
      pendingId?: unknown;
      tool?: unknown;
      args?: unknown;
    } | null;
    const pendingId = body?.pendingId;
    const tool = body?.tool;
    if (typeof pendingId !== 'string' || !UUID.test(pendingId))
      return NextResponse.json({ error: 'Invalid pendingId' }, { status: 400 });
    if (!isChatAssistWriteTool(tool))
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    const args = parseToolArgs(tool, body?.args);
    if (!args || args.conversationId !== conversationId)
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

    const assist = createChatAssistRouter(
      supabaseAdmin(),
      chatAssistHandlers({
        rls: supabase,
        accountId,
        userId,
        conversationId,
        defer: (fn) => after(fn),
      })
    );
    const res = await runConfirmed(
      assist,
      chatAssistContext({ userId, accountId }),
      { tool, args, pendingId }
    );
    switch (res.status) {
      case 'ok':
        return NextResponse.json({ ok: true, result: res.result });
      case 'denied':
        // NOT_CONFIRMED, HASH_MISMATCH, EXPIRED, NOT_PENDING, …: nothing ran.
        return NextResponse.json(
          { error: res.reason, code: res.reason },
          { status: res.reason === 'RATE_LIMITED' ? 429 : 409 }
        );
      case 'needs_confirmation':
        // Unreachable with a pending id; nothing ran either way.
        return NextResponse.json(
          { error: 'NOT_CONFIRMED', code: 'NOT_CONFIRMED' },
          { status: 409 }
        );
      case 'error': {
        const code = ACTION_ERRORS.has(res.message) ? res.message : 'failed';
        return NextResponse.json(
          { error: code, code },
          { status: code === 'failed' ? 500 : 409 }
        );
      }
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
