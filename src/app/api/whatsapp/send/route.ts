import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { isWhatsAppProvider } from '@/lib/whatsapp/channels';

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape, with the `code` and
// `retryable` the inbox's Retry reads (see `sendErrorResponse`).
export async function POST(request: Request) {
  try {
    // Requires the 'agent' role, matching both `canSendMessages` and the
    // `messages_modify` RLS policy (migration 017).
    //
    // Resolving `account_id` off the profile — which any 'viewer' has —
    // was previously the only gate. RLS did block the message INSERT, but
    // the send core calls Meta BEFORE it persists, so a viewer's request
    // still delivered a real WhatsApp message to the customer and merely
    // failed to record it (surfacing as "sent to Meta but failed to save
    // to DB"). RLS can't un-send that, so the role check belongs here.
    const { supabase, accountId, userId } = await requireRole('agent');

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
      // Optional `'whapi' | 'meta'`: pin the send to that number. The
      // Contact detail view sends a plain message on Whapi and a
      // template on Meta; the inbox composer leaves it unset and lets
      // the reply follow the customer's number.
      provider,
    } = body;

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      );
    }

    if (provider != null && !isWhatsAppProvider(provider)) {
      return NextResponse.json(
        { error: "provider must be 'whapi' or 'meta'" },
        { status: 400 }
      );
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return sendErrorResponse(err);
      }
      throw err;
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null;

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single();

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }
      conversationId = data.id;
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle();

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        );
      }

      let resolved: string | null;
      try {
        resolved = await findOrCreateConversation(
          supabase,
          accountId,
          userId,
          contact_id
        );
      } catch (err) {
        // Map SendMessageError here rather than letting it reach the
        // outer catch, which collapses everything unknown to a generic
        // 500 and would throw away the "ask an admin" wording.
        if (err instanceof SendMessageError) {
          return sendErrorResponse(err);
        }
        throw err;
      }
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        );
      }
      conversationId = resolved;
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
        provider: provider ?? null,
        // Stamp the human behind the send. Nothing used to record it,
        // so a thread worked by an agent who never assigned it to
        // themselves had no name anywhere in the UI — the Inbox header
        // now reads this back through `resolveConversationHandler`.
        senderUserId: userId,
      });

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return sendErrorResponse(err);
      }
      throw err;
    }
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp send POST:', error);
    return toErrorResponse(error);
  }
}

/**
 * The dashboard's `{ error }` for a `SendMessageError`, plus what the
 * inbox needs to decide on a Retry (`lib/inbox/failed-send.ts`):
 *
 *   - `code`, the machine code, so `db_error` ("sent but not saved")
 *     is told apart without parsing the wording.
 *   - `retryable`, true only when the message certainly did not reach
 *     the customer. A `whatsapp_error` after a timeout or a gateway 5xx
 *     may already have been delivered, and sending it again would reach
 *     the customer twice.
 *
 * Dashboard only. The v1 envelope is a published contract and does not
 * carry this.
 */
function sendErrorResponse(err: SendMessageError) {
  return NextResponse.json(
    { error: err.message, code: err.code, retryable: err.definite },
    { status: err.status }
  );
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 *
 * A conversation created here starts assigned to whoever opened it. This
 * is the outbound path — an agent picking a contact and writing first —
 * so there is a right answer to "whose chat is this" from the very first
 * message, and the inbox shows a name instead of Unassigned. The inbound
 * path deliberately does NOT do this: a message from a stranger arrives
 * unowned and belongs in the triage queue until someone takes it.
 *
 * It is a starting point, not a lock. Admins reassign to anyone and team
 * leaders within their own team, both enforced by the assignment trigger
 * (migrations 042 and 044); self-assigning here is what that trigger
 * permits for every member anyway, so this needs no new privilege.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      assigned_agent_id: userId,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation on (account_id, contact_id). Since
    // migration 042 a conversation is only visible to its owner, its
    // assignee and admins — so the SELECT above can come back empty
    // for a thread that genuinely exists and belongs to a colleague.
    // The insert then collides with the index. Say what actually
    // happened instead of reporting a generic failure: the caller has
    // done nothing wrong and needs an admin to hand them the chat.
    if (error.code === '23505') {
      throw new SendMessageError(
        'conversation_not_yours',
        'This contact already has a conversation owned by someone else. Ask an admin to assign it to you.',
        409
      );
    }
    console.error(
      'Error creating conversation for contact send:',
      error.message
    );
    return null;
  }

  return created.id;
}
