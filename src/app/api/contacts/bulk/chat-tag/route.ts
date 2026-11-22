// ============================================================
// POST /api/contacts/bulk/chat-tag
//
// Set the chat tag of many contacts' company chats at once (Contacts
// screen bulk bar). Body:
//   { contactIds: string[] (<= 200), chatTagId: string | null,
//     subTagId?: string | null }
//
// Each contact goes through the same server path as the inbox header
// (PUT /api/conversations/[id]/chat-tags): writeConversationChatTags
// under the CALLER's RLS client (compare-and-set, the 075 guard trigger
// decides pairings, conversations_update decides whose chats), the
// suggestion reset, then chat_tag_set dispatched once per chat that
// really changed, inside after() and awaited there (issue #301).
//
// Answer: { updated, unchanged, skipped, failed }. `skipped` = no
// company chat for the contact, or the caller may not change its tags;
// `failed` = the database refused the pairing or the write errored.
// Agent and up; limited concurrency so a tunnel is not flooded.
// ============================================================

import { NextResponse, after } from 'next/server';

import { dispatchChatTagSet } from '@/lib/automations/chat-tag-dispatch';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { clearTagSuggestion } from '@/lib/chat-tags/clear-suggestion';
import { writeConversationChatTags } from '@/lib/chat-tags/server';
import { mapWithConcurrency } from '@/lib/contacts/chat-tag-column';
import {
  parseBulkChatTagBody,
  tallyBulkOutcomes,
  type BulkOutcome,
} from '@/lib/contacts/bulk-chat-tag';

// Automations dispatched in after() may send messages.
export const maxDuration = 60;

const CONCURRENCY = 4;

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const parsed = parseBulkChatTagBody(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { contactIds, chatTagId, subTagId } = parsed.value;

    const changes: Parameters<typeof dispatchChatTagSet>[0][] = [];
    const outcomes = await mapWithConcurrency(
      contactIds,
      CONCURRENCY,
      async (contactId): Promise<BulkOutcome> => {
        const result = await writeConversationChatTags(supabase, {
          accountId,
          contactId,
          next: { chat_tag_id: chatTagId, chat_sub_tag_id: subTagId },
        });
        if (!result.ok) {
          if (result.reason === 'not_found') return 'skipped';
          console.error(
            '[contacts/bulk/chat-tag] write failed:',
            result.reason
          );
          return 'failed';
        }
        const { previous, saved } = result;
        if (
          previous.chat_tag_id === saved.chat_tag_id &&
          previous.chat_sub_tag_id === saved.chat_sub_tag_id
        ) {
          return 'unchanged';
        }
        await clearTagSuggestion(accountId, result.conversationId);
        changes.push({
          accountId,
          contactId: result.contactId,
          conversationId: result.conversationId,
          previous,
          saved,
        });
        return 'updated';
      }
    );

    if (changes.length > 0) {
      after(async () => {
        for (const change of changes) {
          await dispatchChatTagSet(change);
        }
      });
    }

    return NextResponse.json(tallyBulkOutcomes(outcomes));
  } catch (err) {
    return toErrorResponse(err);
  }
}
