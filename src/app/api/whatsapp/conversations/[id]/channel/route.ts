// ============================================================
// PUT /api/whatsapp/conversations/[id]/channel
//
// Choose which WhatsApp number this chat sends from (migration 061).
//
// Body: { channel_id: string | null } — a number id to pin the chat to,
// or null to go back to automatic (reply on the number the customer
// last wrote to).
//
// Agent and up; viewers read only. Every rule — can the caller see the
// chat, may they use that number (allocated to them, or shared, or they
// are an admin) — lives in `set_conversation_send_channel`, which also
// writes the note the thread shows. This route only translates its
// errors into HTTP.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase } = await requireRole('agent');
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      channel_id?: unknown;
    };

    if (!('channel_id' in body)) {
      return NextResponse.json(
        { error: 'channel_id is required (a number id, or null for automatic)' },
        { status: 400 }
      );
    }
    const channelId = body.channel_id;
    if (channelId !== null && typeof channelId !== 'string') {
      return NextResponse.json(
        { error: 'channel_id must be a string or null' },
        { status: 400 }
      );
    }

    const { data: eventId, error } = await supabase.rpc(
      'set_conversation_send_channel',
      { p_conversation_id: id, p_channel_id: channelId }
    );

    if (error) {
      if (error.code === 'P0002') {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      // 22P02: a malformed uuid in the path or the body.
      if (error.code === '22P02') {
        return NextResponse.json(
          { error: 'Invalid conversation or number id' },
          { status: 400 }
        );
      }
      console.error('[conversations/channel] switch failed:', error);
      return NextResponse.json(
        { error: 'Failed to switch the sending number' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      send_channel_id: channelId,
      // null when nothing changed (already on that number).
      event_id: eventId ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
