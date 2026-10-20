// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends via Whapi (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of gateway plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendText,
  sendTemplate,
  sendMedia,
  sendInteractiveButtons,
  sendInteractiveList,
  explainSendFailure,
  isDefiniteSendRefusal,
  type ProviderMediaKind,
} from '@/lib/whatsapp/provider';
import {
  resolveSendChannel,
  ChannelError,
  describeChannel,
  type RoutingSurface,
  type WhatsAppProvider,
} from '@/lib/whatsapp/channels';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { publicSupabaseUrl } from '@/lib/supabase/urls';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import {
  checkNewChatAllowed,
  newChatLimitMessage,
} from '@/lib/team-activity/start-guard';
import {
  consentRefusal,
  CONSENT_REFUSAL_MESSAGES,
} from '@/lib/whatsapp/send-origin';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * True when the message certainly did not reach the customer, so a
   * retry cannot deliver it twice. It defaults to true for a 4xx, which
   * this module raises only before the gateway is called (validation,
   * lookups, routing). A 5xx defaults to false. `whatsapp_error` sets it
   * from `isDefiniteSendRefusal`, and `db_error` is false because the
   * gateway had already accepted the send.
   */
  readonly definite: boolean;
  constructor(
    code: string,
    message: string,
    status: number,
    definite: boolean = status >= 400 && status < 500
  ) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
    this.definite = definite;
  }
}

/**
 * The raw fields both gateway error classes carry, read structurally so
 * this module stays provider-blind (no gateway-client import here).
 */
export function gatewayErrorFields(err: unknown): {
  status: unknown;
  code: unknown;
  message: string;
  details: unknown;
} {
  const e = (err ?? {}) as Record<string, unknown>;
  return {
    status: e.status ?? null,
    code: e.code ?? null,
    message: err instanceof Error ? err.message : String(err),
    details: e.details ?? null,
  };
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  /**
   * Which routing surface this send belongs to (migration 046).
   * Decides which connected number carries it — see
   * `resolveSendChannel`. Defaults to the dashboard composer.
   */
  surface?: RoutingSurface;
  /**
   * Pin the send to the account's channel on this provider, ahead of
   * the surface rules. Set by the Contact detail view, whose two
   * actions map onto the two kinds of number: a free-form message on
   * Whapi, an approved template on Meta. Ignored (falls back to
   * `surface`) when that provider is not connected, so a
   * single-channel install is unaffected.
   */
  provider?: WhatsAppProvider | null;
  /**
   * Make the `provider` pin a hard requirement: fail with
   * `<provider>_not_connected` instead of falling back to the surface
   * rules. The Compass status notifications need this — they are
   * free-form, so on the Meta number they would be refused outside the
   * 24-hour window, and silently moving them there is worse than
   * failing loudly.
   */
  requireProvider?: boolean;
  replyToMessageId?: string | null;
  /**
   * The signed-in human behind this send, persisted as
   * `messages.sender_id`. The dashboard composer passes the acting
   * user; bot surfaces (Flows, automations, AI) and API-key sends
   * leave it unset, because there is no person to name. Read back by
   * `resolveConversationHandler` so the Inbox header can show who is
   * actually working a thread nobody bothered to assign.
   */
  senderUserId?: string | null;
  /**
   * This send re-delivers a message from another chat
   * (`POST /api/whatsapp/forward`). Persisted as `is_forwarded` so the
   * thread labels it; the recipient's WhatsApp shows no such label,
   * because neither gateway offers a forward that works across both.
   */
  forwarded?: boolean;
  /**
   * Pause the contact's active Flow run after sending (default true).
   * Right for a human stepping into the thread; wrong for a system
   * notification (Compass status updates), which should not knock a
   * customer out of a flow they are halfway through.
   */
  pauseActiveFlows?: boolean;
  /**
   * Refuse, before the gateway, a send to a contact marked
   * do-not-contact (migration 086) or opted out (076). The dashboard
   * sets it for the missed-call WhatsApp draft (module 015), which goes
   * out "through the consent register"; ordinary sends leave it unset.
   */
  respectConsent?: boolean;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** WhatsApp's message id for the delivered message. */
  whatsappMessageId: string;
}

/** Longest `media_url` accepted — a URL, not a data blob. */
export const MAX_MEDIA_URL_LENGTH = 2048;

/**
 * Whether `mediaUrl` may be stored and sent. It must be an absolute
 * https:// URL, or an object in our own public storage bucket — which a
 * self-hosted dev install may serve over plain http.
 *
 * The stored value is later fetched *server-side* (forwarding re-hosts
 * it with a gateway token in hand), so an arbitrary string here is an
 * SSRF / credential-leak foothold: `http://169.254.169.254/…`,
 * `file:`, a relative path. The download layer guards too; this keeps
 * the junk out of `messages` in the first place.
 *
 * `publicStorageBase` defaults to `publicSupabaseUrl()`; injectable so
 * this stays testable.
 */
export function isAcceptableMediaUrl(
  mediaUrl: string,
  publicStorageBase: string | undefined = publicSupabaseUrl()
): boolean {
  if (mediaUrl.length > MAX_MEDIA_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  const base = (publicStorageBase ?? '').replace(/\/+$/, '');
  return (
    url.protocol === 'http:' &&
    !!base &&
    url.href.startsWith(`${base}/storage/v1/object/public/`)
  );
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const {
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against
  // WhatsApp's limits up front so a bad payload 400s before we touch
  // the gateway.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Checked whenever present, not only for media kinds: the send core
  // persists `media_url` for every type.
  if (mediaUrl != null && mediaUrl !== '') {
    if (typeof mediaUrl !== 'string' || !isAcceptableMediaUrl(mediaUrl)) {
      throw new SendMessageError(
        'bad_request',
        'media_url must be an absolute https:// URL',
        400
      );
    }
  }

  // WhatsApp caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

/**
 * Does `userId` reach this conversation ONLY through a chat share
 * (migration 130), and not by the ordinary rules? The coordinator case:
 * the database lets them read the chat and insert their own reply on
 * the chat's own number, but not update the conversation row.
 *
 * Asked of the database on the caller's client: `coordinator_share_grants`
 * (an open share to auth.uid(), bank held, live agent / team leader) and
 * `can_view_conversation` (the ordinary rule, admins included). The
 * owner and the assignee see the chat anyway, so they skip the round
 * trips. Any error, or anything but a plain boolean, answers false:
 * this only ever narrows a send or completes a write the share already
 * entitles, so not knowing falls back to the behaviour before 130.
 */
async function reachesOnlyByShare(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  conversation: {
    id: string;
    user_id?: string | null;
    assigned_agent_id?: string | null;
    channel_id?: string | null;
    send_channel_id?: string | null;
  }
): Promise<boolean> {
  if (
    conversation.user_id === userId ||
    conversation.assigned_agent_id === userId
  ) {
    return false;
  }
  try {
    const [grants, ordinary] = await Promise.all([
      db.rpc('coordinator_share_grants', {
        p_conversation_id: conversation.id,
      }),
      db.rpc('can_view_conversation', {
        p_account_id: accountId,
        p_owner_id: conversation.user_id ?? null,
        p_assigned_id: conversation.assigned_agent_id ?? null,
        p_channel_id: conversation.channel_id ?? null,
        p_send_channel_id: conversation.send_channel_id ?? null,
      }),
    ]);
    if (grants.error || ordinary.error) return false;
    return grants.data === true && ordinary.data === false;
  } catch {
    return false;
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
    surface = 'inbox',
    provider: preferredProvider,
    requireProvider = false,
    senderUserId,
    forwarded = false,
    pauseActiveFlows = true,
    respectConsent = false,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  // Read with the conversation just now, so a customer marked since the
  // draft was offered is still refused. Nothing has reached a gateway.
  if (respectConsent) {
    const refusal = consentRefusal(contact);
    if (refusal) {
      throw new SendMessageError(
        refusal,
        CONSENT_REFUSAL_MESSAGES[refusal],
        409
      );
    }
  }
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400
    );
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError(
      'bad_request',
      'Invalid phone number format',
      400
    );
  }

  // Which connected number carries this send (migration 046). An
  // account may now have both a Whapi channel and a Meta Cloud API
  // number; for a thread reply this follows whichever the customer
  // last wrote to, and for a bot surface it obeys the admin's route.
  // A caller that has already chosen the kind of number (Contact
  // detail: message → Whapi, template → Meta) pins it by provider.
  //
  // Credentials come back decrypted, so nothing below touches
  // `whatsapp_config` or `encryption` directly.
  let channel;
  try {
    channel = await resolveSendChannel(
      db,
      accountId,
      surface,
      conversationId,
      preferredProvider,
      // A thread with no number yet starts from the one this person is
      // allocated to (migration 060).
      senderUserId,
      // Already read above — spare the hot path a second round trip.
      {
        channelId: (conversation.channel_id as string | null) ?? null,
        sendChannelId: (conversation.send_channel_id as string | null) ?? null,
      }
    );
  } catch (err) {
    if (err instanceof ChannelError) {
      // Choosing the number comes before any gateway call, so even a
      // 500 here certainly sent nothing.
      throw new SendMessageError(err.code, err.message, err.status, true);
    }
    throw err;
  }

  if (
    requireProvider &&
    preferredProvider &&
    channel.provider !== preferredProvider
  ) {
    throw new SendMessageError(
      `${preferredProvider}_not_connected`,
      `No ${preferredProvider === 'whapi' ? 'Whapi' : 'Meta Cloud API'} channel is connected on this account.`,
      409
    );
  }

  // A chat shared with a coordinator (migration 130) may be answered
  // only on its own number: the messages INSERT policy refuses any
  // other. That refusal comes AFTER the gateway call, as a db_error on a
  // message that already went out, so a share-only sender is refused
  // here instead when the resolved number is neither the chat's number
  // nor its pin (a thread with no number yet, or a provider pin to the
  // other kind). Asked only on that mismatch, so an ordinary send pays
  // no extra round trip.
  const ownNumbers = [conversation.channel_id, conversation.send_channel_id];
  // Memoised: the last-message update below asks the same question.
  let shareOnly: Promise<boolean> | null = null;
  const senderReachesOnlyByShare = () =>
    (shareOnly ??= senderUserId
      ? reachesOnlyByShare(db, accountId, senderUserId, conversation)
      : Promise.resolve(false));
  if (
    senderUserId &&
    !ownNumbers.includes(channel.id) &&
    (await senderReachesOnlyByShare())
  ) {
    throw new SendMessageError(
      'shared_chat_number',
      ownNumbers.some(Boolean)
        ? "This chat was shared with you, so you can reply only on the chat's own WhatsApp number."
        : 'This chat was shared with you and has no WhatsApp number yet, so you cannot send in it until its owner does.',
      409
    );
  }

  // Team activity (migration 068): with "Block new chats over the
  // limit" on, a person's message that would START a chat on a Whapi
  // number is refused once they, or the number, are at the day's
  // limit — before anything reaches the gateway. Replies, API and bot
  // sends, owners and admins are never refused, and any error in the
  // check lets the message through.
  if (senderUserId && channel.provider === 'whapi') {
    const check = await checkNewChatAllowed(db, conversationId, channel.id);
    if (check.blocked) {
      throw new SendMessageError(
        'new_chat_limit',
        newChatLimitMessage(check),
        429
      );
    }
  }

  // Resolve the reply target to its WhatsApp message id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let quotedMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id, provider, channel_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    // A WhatsApp message id only means something to the gateway that
    // carried it. Since a chat can switch numbers mid-conversation
    // (migration 061), the quoted message may have gone through another
    // one — quoting it there is rejected or silently dropped. Send
    // unquoted instead; the CRM thread still shows the quote, from
    // `reply_to_message_id`.
    //
    // A parent from before migration 060 records only its provider. That
    // proves "same number" only while the account has ONE number of that
    // provider; with two Whapi numbers it could be either, so play safe.
    let carriedElsewhere: boolean;
    if (parent.channel_id) {
      carriedElsewhere = parent.channel_id !== channel.id;
    } else if (parent.provider && parent.provider !== channel.provider) {
      carriedElsewhere = true;
    } else {
      const { count } = await db
        .from('whatsapp_config')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('provider', channel.provider);
      carriedElsewhere = (count ?? 0) > 1;
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no WhatsApp message id; sending unquoted'
      );
    } else if (carriedElsewhere) {
      console.info(
        '[send-message] reply target was carried by another number; sending unquoted'
      );
    } else {
      quotedMessageId = parent.message_id;
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — open Settings → Templates and re-save it.',
        500,
        // Before the gateway call: nothing went out.
        true
      );
    }
    templateRow = resolved.row;
    if (!templateRow) {
      // Whapi renders templates locally, so with no row there is
      // nothing to send. Checked here rather than inside `attempt`
      // below: that runs once per phone variant and its catch-all
      // would relabel this precondition as a gateway failure.
      throw new SendMessageError(
        'template_not_found',
        `No template named "${templateName}" exists on this account.`,
        404
      );
    }
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      // The local row drives BOTH providers, but they consume it very
      // differently: Whapi renders it and posts an ordinary message,
      // while Meta addresses an already-approved template in the WABA
      // registry by (name, language). `resolveTemplateRow` above picks
      // the right localized row either way; its presence is guaranteed
      // by the guard above.
      const result = await sendTemplate({
        channel,
        to: phone,
        template: templateRow!,
        bodyParams: templateBodyParams(templateParams, templateMessageParams),
        messageParams: templateMessageParams,
        quotedMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMedia({
        channel,
        to: phone,
        kind: messageType as ProviderMediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        quotedMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          channel,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          quotedMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        channel,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        quotedMessageId,
      });
      return result.messageId;
    }
    const result = await sendText({
      channel,
      to: phone,
      text: contentText!,
      quotedMessageId,
    });
    return result.messageId;
  };

  // Send via Whapi — retry across phone-number variants if the gateway
  // rejects the recipient; persist a working variant back to the
  // contact so the next send goes straight through.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const variants = phoneVariants(sanitizedPhone);
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected by the gateway, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    // `explainSendFailure` names the provider-specific failures that
    // are otherwise opaque numeric codes — above all Meta's closed
    // 24-hour service window, which is the single most common reason a
    // send to the marketing number is refused — and, for a Whapi
    // 401/403, probes the number to say whether the phone was logged
    // out or the token revoked.
    const message = await explainSendFailure(err, channel);
    // The gateway's own status/code/text too: the friendly message above
    // replaces it, and without the raw values a past incident cannot be
    // told apart after the fact.
    console.error(
      `[send-message] send failed for all variants on ${describeChannel(channel)}:`,
      message,
      gatewayErrorFields(err)
    );
    throw new SendMessageError(
      'whatsapp_error',
      `WhatsApp API error: ${message}`,
      502,
      // Only a gateway 4xx proves nothing went out. A timeout, a 5xx or
      // an accepted send with no id back may already have reached the
      // customer, and the inbox must not offer to send it again.
      isDefiniteSendRefusal(err)
    );
  }

  if (workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      // Who sent it, when a human did. Null for API-key and bot
      // sends — the column is nullable and every reader treats a
      // missing sender as "not attributable to a person".
      sender_id: senderUserId ?? null,
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
      // Which number carried it (migration 046). Read back by
      // `resolveReplyChannel` so the thread keeps answering on the
      // channel the conversation is actually happening on.
      provider: channel.provider,
      channel_id: channel.id,
      is_forwarded: forwarded,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      // The raw database text stays in the log above: this message reaches
      // the public API and Compass's stored error, which must not carry
      // internal wording (docs/public-api.md).
      'The message was sent to WhatsApp but could not be saved. It will not appear in the conversation.',
      500,
      // Sent: a retry would deliver it twice, and the media it links to
      // must be kept.
      false
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  const summary = {
    last_message_text: lastMessageText,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data: summarised, error: summaryError } = await db
    .from('conversations')
    .update(summary)
    .eq('id', conversationId)
    .select('id');
  // A coordinator reaches a shared chat through SELECT and INSERT
  // policies only (migration 130): under RLS this update matches 0 rows,
  // silently, and the inbox list would show a stale last message. Only
  // for a sender who reaches the chat by the share alone, this one write
  // goes through the service role, confined to this conversation in
  // this account. Everyone else keeps the RLS result as it was.
  if (
    !summaryError &&
    Array.isArray(summarised) &&
    summarised.length === 0 &&
    (await senderReachesOnlyByShare())
  ) {
    const { error: adminSummaryError } = await supabaseAdmin()
      .from('conversations')
      .update(summary)
      .eq('id', conversationId)
      .eq('account_id', accountId);
    if (adminSummaryError) {
      console.warn(
        '[send-message] could not update the shared chat summary:',
        adminSummaryError.message
      );
    }
  }

  // An agent-initiated thread is on the number it was started from
  // (migration 060). Only ever filled in, never moved: re-pointing a
  // thread is admin-only, and the inbound pipeline is what follows a
  // customer to another number. A separate statement, because the
  // database refuses the stamp for a number the sender may not use
  // (`conversations_channel_guard`, 062) — and that refusal must not
  // also throw away the last-message update above.
  if (!conversation.channel_id) {
    const { error: stampError } = await db
      .from('conversations')
      .update({ channel_id: channel.id })
      .eq('id', conversationId)
      .is('channel_id', null);
    if (stampError) {
      console.warn(
        '[send-message] could not record the number on this conversation:',
        stampError.message
      );
    }
  }

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  if (pauseActiveFlows) {
    try {
      const { error: pauseErr } = await supabaseAdmin()
        .from('flow_runs')
        .update({
          status: 'paused_by_agent',
          ended_at: new Date().toISOString(),
          end_reason: 'agent_replied',
        })
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .eq('status', 'active');
      if (pauseErr) {
        console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
      }
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
