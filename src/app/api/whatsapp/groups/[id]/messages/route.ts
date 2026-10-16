// ============================================================
// /api/whatsapp/groups/[id]/messages — a group's own chat log (114).
// GET pages it newest-first from the DB and answers oldest-first,
// through the caller's RLS client. POST sends text into the group as
// our number: managers only, not on a group we have left, and where the
// group restricts sending to admins our number must be one. At most
// GROUP_SEND_LIMIT sends a minute per group (anti-ban). The row is
// written after the gateway accepts; the webhook echo of the same
// message may win the race, in which case we only attribute it.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  GROUP_SEND_LIMIT,
  parseGroupText,
  parseMessagePage,
  requireActive,
  requireGroupAdmin,
} from '@/lib/groups/member-requests';
import {
  channelForGroup,
  GroupHttpError,
  groupErrorResponse,
  loadGroupForCaller,
  supabaseAdmin,
} from '@/lib/groups/server';
import { sendGroupText } from '@/lib/whatsapp/groups';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const MESSAGE_COLUMNS =
  'id, group_id, wa_message_id, direction, sender_wa_id, sender_name, sender_user_id, type, body, media, status, created_at';

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { before, limit } = parseMessagePage(
      new URL(request.url).searchParams
    );
    const group = await loadGroupForCaller(ctx, id);
    let query = ctx.supabase
      .from('whatsapp_group_messages')
      .select(MESSAGE_COLUMNS)
      .eq('account_id', ctx.accountId)
      .eq('group_id', group.id);
    if (before) query = query.lt('created_at', before);
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (error) {
      console.error('[groups] messages read failed', error);
      throw new GroupHttpError(503, 'unavailable', 'Could not load messages');
    }
    const rows = (data ?? []) as unknown[];
    return NextResponse.json({
      messages: rows.slice(0, limit).reverse(),
      hasMore: rows.length > limit,
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { text } = parseGroupText(await request.json().catch(() => null));
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    if (group.settings.send_messages === 'admins') requireGroupAdmin(group);
    else requireActive(group);

    const admin = supabaseAdmin();
    const since = new Date(
      Date.now() - GROUP_SEND_LIMIT.windowMs
    ).toISOString();
    const { count, error: countError } = await admin
      .from('whatsapp_group_messages')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
      .eq('group_id', group.id)
      .eq('direction', 'out')
      .gte('created_at', since);
    if (countError) {
      console.error('[groups] send count failed', countError);
      throw new GroupHttpError(503, 'unavailable', 'Could not check the limit');
    }
    if ((count ?? 0) >= GROUP_SEND_LIMIT.perWindow) {
      throw new GroupHttpError(
        429,
        'rate_limited',
        'This group is receiving messages too fast; wait a minute'
      );
    }

    const channel = await channelForGroup(group);
    const sent = await sendGroupText({
      channel,
      groupId: group.wa_group_id,
      text,
    });

    const { data: me } = await admin
      .from('profiles')
      .select('full_name')
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const senderName =
      (me as { full_name: string | null } | null)?.full_name ?? null;

    const { data: inserted, error: insertError } = await admin
      .from('whatsapp_group_messages')
      .upsert(
        {
          account_id: ctx.accountId,
          group_id: group.id,
          wa_message_id: sent.messageId,
          direction: 'out',
          sender_user_id: ctx.userId,
          sender_name: senderName,
          type: 'text',
          body: text,
          status: 'sent',
        },
        { onConflict: 'group_id,wa_message_id', ignoreDuplicates: true }
      )
      .select(MESSAGE_COLUMNS);
    if (insertError) {
      // The message went out; failing here would invite a resend.
      console.error('[groups] sent message not recorded', insertError);
    } else if ((inserted ?? []).length === 0) {
      // The webhook echo won the race: only attribute its row.
      const { error } = await admin
        .from('whatsapp_group_messages')
        .update({ sender_user_id: ctx.userId, sender_name: senderName })
        .eq('group_id', group.id)
        .eq('wa_message_id', sent.messageId);
      if (error) console.error('[groups] attribution failed', error);
    }
    const { data: row } = await admin
      .from('whatsapp_group_messages')
      .select(MESSAGE_COLUMNS)
      .eq('group_id', group.id)
      .eq('wa_message_id', sent.messageId)
      .maybeSingle();
    return NextResponse.json({ message: row });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
