// ============================================================
// POST /api/v1/messages — send a WhatsApp message via the public API.
//
// The headline public endpoint (issue #245). Unlike the dashboard's
// `/api/whatsapp/send` (which takes an internal `conversation_id`),
// this takes a phone number — what an external automation actually
// has — resolves-or-creates the contact + conversation, then runs the
// same shared send core.
//
// Auth: API key with the `messages:send` scope. Account context (and
// the service-role client) come from `requireApiKey`.
//
// Body:
//   {
//     "to": "+14155550123",                 // required, E.164
//     "type": "text",                        // text|template|image|video|document|audio (default: text)
//     "text": "Hello!",                      // text body, or media caption
//     "media_url": "https://…/file.pdf",     // required for image/video/document/audio
//     "filename": "invoice.pdf",             // optional, document filename
//     "template": {                          // required when type=template
//       "name": "order_update",
//       "language": "en_US",
//       "params": ["A123"] | { "body": [...] }   // array = positional body; object = structured
//     },
//     "reply_to_message_id": "<uuid>",       // optional, must be in the same conversation
//     "name": "Jane Doe"                     // optional, names a newly-created contact
//   }
//
// Response (201):
//   { "data": { "message_id", "whatsapp_message_id", "conversation_id",
//               "contact_id", "contact_created" } }
//
// Sent but not saved: 201 as well, `message_id` null and `"warning":
// "not_recorded"`. An error would be retried, and the customer would get
// it twice.
//
// Optional `Idempotency-Key` header (or `idempotency_key` field): the
// message is sent at most once per key (`lib/api/v1/message-keys.ts`).
//
// A customer who opted out or is marked do-not-contact is never
// messaged: 422 `customer_opted_out`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import {
  claimMessageKey,
  deliveryUnconfirmed,
  hashRequest,
  readIdempotencyKey,
  type MessageClaim,
  type SentMessageAnswer,
} from '@/lib/api/v1/message-keys';
import {
  ok,
  fail,
  toApiErrorResponse,
  unavailable,
} from '@/lib/api/v1/respond';
import { readTemplateParams } from '@/lib/api/v1/template-params';
import {
  ContactLookupError,
  findMatchingContacts,
} from '@/lib/contacts/dedupe';
import {
  contactLookupNumber,
  resolveConversationByPhone,
} from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { consentRefusal } from '@/lib/whatsapp/send-origin';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

interface ConsentRegister {
  opted_out_at?: string | null;
  do_not_contact_at?: string | null;
}

const customerOptedOut = () =>
  fail(
    'customer_opted_out',
    'The customer has opted out of WhatsApp messages. Nothing was sent.',
    422
  );

export async function POST(request: Request) {
  let claim: MessageClaim | null = null;
  // From here on only a definite refusal proves nothing went out.
  let handedToGateway = false;
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const key = readIdempotencyKey(
      request.headers.get('idempotency-key'),
      body.idempotency_key
    );

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) {
      return fail('bad_request', "'to' is required", 400);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';

    // Unpack the optional `template` object into the flat params the
    // send core expects. `params` as an array → legacy positional body
    // params; as an object → structured header/body/button params. A value
    // that is neither text nor a number is refused, never left out.
    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;
    const { templateParams, templateMessageParams } =
      type === 'template' ? readTemplateParams(template?.params) : {};

    // Validate the message shape BEFORE resolveConversationByPhone
    // finds-or-creates a contact + conversation, so a bad payload 400s
    // without leaving an orphan contact/conversation behind.
    // Validated by `validateSendMessageParams` below; the cast just bridges
    // the untyped JSON body to the send-core param type.
    const interactivePayload =
      body.interactive_payload && typeof body.interactive_payload === 'object'
        ? (body.interactive_payload as InteractiveMessagePayload)
        : null;

    validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
      interactivePayload,
    });

    // Before anything else: a repeat is answered as it was the first time,
    // whatever has changed since.
    if (key !== null) {
      const claimed = await claimMessageKey(
        ctx.supabase,
        ctx,
        key,
        hashRequest(body)
      );
      if ('replay' in claimed) {
        return ok({ ...claimed.replay, replayed: true });
      }
      claim = claimed.claim;
    }
    const held = claim;

    // The opt-out may sit on an older twin of the contact this number
    // resolves to, so every contact it matches is asked, as Compass does.
    // Before the find-or-create: a refused send leaves nothing behind.
    const twins = (await findMatchingContacts(
      ctx.supabase,
      ctx.accountId,
      contactLookupNumber(to).number
    )) as ConsentRegister[];
    if (twins.some((c) => consentRefusal(c))) {
      await held?.settle({ state: 'failed' });
      return customerOptedOut();
    }

    // Find-or-create the conversation for this phone, then send. Both
    // steps share `SendMessageError`, so one catch maps the whole
    // pipeline to the envelope.
    const resolved = await resolveConversationByPhone(
      ctx.supabase,
      ctx.accountId,
      to,
      typeof body.name === 'string' ? body.name : null
    );

    const sent = (
      messageId: string | null,
      whatsappMessageId: string | null
    ): SentMessageAnswer => ({
      message_id: messageId,
      whatsapp_message_id: whatsappMessageId,
      conversation_id: resolved.conversationId,
      contact_id: resolved.contactId,
      contact_created: resolved.contactCreated,
    });

    const answer = await sendMessageToConversation(
      ctx.supabase,
      ctx.accountId,
      {
        conversationId: resolved.conversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName: typeof template?.name === 'string' ? template.name : null,
        templateLanguage:
          typeof template?.language === 'string' ? template.language : null,
        templateParams,
        templateMessageParams,
        interactivePayload,
        // The public API is its own routing surface (migration 046), so
        // an admin can point external automations at one number without
        // moving the dashboard composer. Like the composer, a reply into
        // an existing thread still follows the channel the customer used.
        surface: 'api',
        // A start on a company phone number at its daily new-chat limit
        // is refused 429 `number_daily_limit` (migration 204).
        enforceNumberDailyLimit: true,
        // Asked again on the contact itself, right before the gateway.
        respectConsent: true,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
        beforeGateway: held
          ? async () => {
              await held.handOver(resolved.contactId);
              handedToGateway = true;
            }
          : undefined,
      }
    ).then(
      (r) => sent(r.messageId, r.whatsappMessageId),
      (err: unknown) => {
        // Raised only after the gateway took it: the customer has it.
        if (!(err instanceof SendMessageError) || err.code !== 'db_error') {
          throw err;
        }
        return {
          ...sent(null, err.whatsappMessageId ?? null),
          warning: 'not_recorded' as const,
        };
      }
    );

    await claim?.settle({
      state: 'sent',
      contactId: resolved.contactId,
      answer,
    });
    return ok(answer, 201);
  } catch (err) {
    if (claim) {
      const unsent =
        !handedToGateway || (err instanceof SendMessageError && err.definite);
      await claim.settle({ state: unsent ? 'failed' : 'unconfirmed' });
      if (!unsent) {
        console.error('[api/v1/messages] send outcome unconfirmed:', err);
        return toApiErrorResponse(deliveryUnconfirmed());
      }
    }
    if (err instanceof SendMessageError) {
      if (err.code === 'opted_out' || err.code === 'do_not_contact') {
        return customerOptedOut();
      }
      return fail(err.code, err.message, err.status);
    }
    // Only ever before the send: whether the customer opted out is unknown.
    if (err instanceof ContactLookupError) {
      return toApiErrorResponse(unavailable());
    }
    return toApiErrorResponse(err);
  }
}
