import { NextResponse } from 'next/server';

import { UnauthorizedError, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  parseMediaForm,
  parsePostBody,
  sendRoomMessage,
} from '@/lib/deal-rooms/operations';
import { listRoomMessages, parsePageQuery } from '@/lib/deal-rooms/reads';
import { createClient } from '@/lib/supabase/server';

/** One gateway round trip. */
export const maxDuration = 60;

/**
 * Send to the deal room's WhatsApp group (module 014c): `{ text }`, or
 * `{ templateName, language, params? }`, or a file as multipart form
 * data (`file`, optional `caption`: a JPEG/PNG image up to 5 MB or a
 * document up to 9 MB, 400 `media_type` / `media_size` otherwise). The
 * only route that reaches a group, so everyone in the room sees what it
 * sends; nothing sent can be edited or deleted. Free text and files need
 * the group's 24-hour window open (409 `window_closed` otherwise, before
 * the file is stored); templates are allowed at any time. A sent file is
 * kept in the deal file (`deal_files`, source `deal_room_media`).
 *
 * Bank guests may post in their own rooms, and `requireRole` refuses
 * them, so this route authenticates the session itself and leaves the
 * decision to `deal_room_can_post`, asked as the caller. The send then
 * runs on the service role. Errors are `{ error, code }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) throw new UnauthorizedError();
    const { id } = await params;
    const { data: canPost, error } = await supabase.rpc('deal_room_can_post', {
      p_room: id,
    });
    if (error) console.error('[deal-rooms] can_post failed:', error.message);
    if (canPost !== true) {
      return NextResponse.json(
        { error: 'You cannot post in this deal room', code: 'forbidden' },
        { status: 403 }
      );
    }
    const multipart = (request.headers.get('content-type') ?? '')
      .toLowerCase()
      .startsWith('multipart/form-data');
    let parsed: Awaited<ReturnType<typeof parseMediaForm>>;
    if (multipart) {
      parsed = await parseMediaForm(await request.formData().catch(() => null));
    } else {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const json = parsePostBody(body);
      parsed = json.ok
        ? json
        : { ok: false, error: json.error, code: 'invalid' };
    }
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, code: parsed.code },
        { status: 400 }
      );
    }
    const result = await sendRoomMessage(supabaseAdmin(), {
      roomId: id,
      userId: auth.user.id,
      input: parsed.value,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code, ...result.detail },
        { status: result.status }
      );
    }
    return NextResponse.json(
      { id: result.id, waMessageId: result.waMessageId },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * A page of the group's messages, oldest first: `?before=<createdAt>`
 * (exclusive; pass the previous page's `nextBefore`) and `limit` (1 to
 * 100, default 50). Each message carries `senderName` / `senderRole`
 * from the roster (a staff member's post reads "<name> · <workspace
 * name>", "<name> · Team" when the workspace has no name),
 * `fileName` for media, and `deliveredCount` / `readCount` from the
 * receipts. Guest-capable and read as the caller (RLS decides); only
 * the posters' names and the workspace name are looked up on the
 * service role. 404 when the caller cannot see the room.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) throw new UnauthorizedError();
    const { id } = await params;
    const query = parsePageQuery(new URL(request.url).searchParams);
    if (!query.ok) {
      return NextResponse.json(
        { error: query.error, code: 'invalid' },
        { status: 400 }
      );
    }
    const page = await listRoomMessages(supabase, supabaseAdmin(), {
      roomId: id,
      before: query.before,
      limit: query.limit,
    });
    if (!page) {
      return NextResponse.json(
        { error: 'Deal room not found', code: 'not_found' },
        { status: 404 }
      );
    }
    return NextResponse.json(page, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
