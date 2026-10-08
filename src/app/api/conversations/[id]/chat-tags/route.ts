// ============================================================
// PUT /api/conversations/[id]/chat-tags
//
// Set a chat's main tag and sub-tag (migration 075).
//
// Body: { chat_tag_id: string | null, chat_sub_tag_id: string | null }
// — each a tag id or null; a sub-tag needs a main tag.
//
// Agent and up; viewers read only. The write runs under the caller's
// own RLS client, so the conversations_update policy decides whose
// chats they may tag (a refused UPDATE answers no row: 404 here), and
// the 075 guard trigger decides which tags pair up. The answer is the
// row the database kept, which may have dropped the sub-tag.
//
// A change fires the account's `chat_tag_set` automations after the
// response, inside `after()` and awaited there: a floating promise is
// killed with the request (issue #301).
// ============================================================

import { NextResponse, after } from 'next/server';

import { dispatchChatTagSet } from '@/lib/automations/chat-tag-dispatch';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { writeConversationChatTags } from '@/lib/chat-tags/server';

// Automations dispatched in after() may send messages.
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTagId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID.test(value));
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await context.params;
    if (!UUID.test(id)) {
      return NextResponse.json({ error: 'Invalid chat id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      chat_tag_id?: unknown;
      chat_sub_tag_id?: unknown;
    } | null;
    const chatTagId = body?.chat_tag_id;
    const chatSubTagId = body?.chat_sub_tag_id;
    if (!isTagId(chatTagId) || !isTagId(chatSubTagId)) {
      return NextResponse.json(
        {
          error:
            'chat_tag_id and chat_sub_tag_id are required, each a tag id or null',
        },
        { status: 400 }
      );
    }
    if (chatSubTagId !== null && chatTagId === null) {
      return NextResponse.json(
        { error: 'A sub-tag needs a main tag' },
        { status: 400 }
      );
    }

    const result = await writeConversationChatTags(supabase, {
      accountId,
      conversationId: id,
      next: { chat_tag_id: chatTagId, chat_sub_tag_id: chatSubTagId },
    });

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return NextResponse.json(
          { error: "Chat not found, or you can't change its tags." },
          { status: 404 }
        );
      }
      if (result.reason === 'invalid') {
        // The database's own wording names constraints; say it plainly.
        return NextResponse.json(
          {
            error:
              "Those tags can't go together on this chat. The tag may have been removed, or the sub-tag belongs to another tag.",
          },
          { status: 400 }
        );
      }
      console.error('[conversations/chat-tags] save failed:', result.message);
      return NextResponse.json(
        { error: 'Failed to save the chat tags' },
        { status: 500 }
      );
    }

    const { previous, saved } = result;
    if (
      previous.chat_tag_id !== saved.chat_tag_id ||
      previous.chat_sub_tag_id !== saved.chat_sub_tag_id
    ) {
      after(async () => {
        await dispatchChatTagSet({
          accountId,
          contactId: result.contactId,
          conversationId: result.conversationId,
          previous,
          saved,
        });
      });
    }

    return NextResponse.json({
      chat_tag_id: saved.chat_tag_id,
      chat_sub_tag_id: saved.chat_sub_tag_id,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
