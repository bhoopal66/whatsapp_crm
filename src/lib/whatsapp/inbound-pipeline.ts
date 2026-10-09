// ============================================================
// The provider-agnostic inbound pipeline.
//
// One inbound message becomes CRM state here: contact dedup,
// conversation resolution, idempotent persistence, then the fan-out to
// Flows -> automations -> AI auto-reply -> outbound webhooks.
//
// This lived inside `app/api/whatsapp/webhook/route.ts` while Whapi was
// the only transport. It moved out when the Meta Cloud API was added
// back alongside it (migration 046): an account can now receive on two
// numbers, and BOTH routes have to produce identical CRM state. Two
// copies of a 900-line pipeline would have diverged inside a month.
//
// What each route still owns is authentication and tenancy, because
// they are genuinely different:
//
//   whapi -> a shared secret in the callback URL resolves the account;
//            the payload's channel_id is only cross-checked.
//   meta  -> `metadata.phone_number_id` selects the account and the
//            X-Hub-Signature-256 HMAC over the raw body proves it.
//
// By the time anything here runs, that is settled: the caller passes a
// resolved `WhatsAppChannel` with decrypted credentials, and every
// invariant below (the idempotency boundary, the status ladder, the
// flow-consumption rule) applies identically to both providers.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getMediaUrl } from '@/lib/whatsapp/provider';
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import type {
  NormalizedInboundMessage,
  NormalizedStatus,
  NormalizedStatusValue,
} from '@/lib/whatsapp/inbound';
import { describeMetaFailure } from '@/lib/whatsapp/meta-failure';
import { settleBroadcastAfterLateFailure } from '@/lib/whatsapp/broadcast-core';
import { buildHandoffSummary } from '@/lib/ai/handoff';
import { buildConversationContext } from '@/lib/ai/context';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { watchInboundMessage } from '@/lib/ai/typesafe-watch';

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once the message
// has been delivered or read, a later "failed" status event is a bug in
// the gateway's pipeline or a spoof attempt and must be ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

// messages.status climbs the same ladder in the CHECK's own vocabulary
// (migration 001: sending, sent, delivered, read, failed). Each receipt
// lists the states it may overwrite, and the list goes into the
// UPDATE's WHERE rather than a read-then-write: Meta posts receipts
// concurrently and out of order, each in its own after(), and a late
// `sent` used to land on messages already delivered or read. 'pending'
// (Whapi's queued state) is not in the CHECK, so it lists nothing and
// is skipped rather than sent as an empty IN ().
const MESSAGE_STATUS_PREDECESSORS: Record<
  NormalizedStatusValue,
  readonly string[]
> = {
  pending: [],
  sent: ['sending'],
  delivered: ['sending', 'sent'],
  read: ['sending', 'sent', 'delivered'],
  failed: ['sending', 'sent'],
};

// broadcast_recipients.status gets the same treatment in its own
// vocabulary (migration 001's CHECK: the ladder above plus 'failed').
// A compare-and-set on the status the handler had read used to drop a
// concurrent 'read' whenever 'delivered' committed first: both read
// 'sent', and the second UPDATE matched nothing — and migration 066's
// reconcile only moves rows still at 'sent', so nothing repaired it.
// With the predecessors in the WHERE a higher receipt lands whichever
// commits first, and a lower one arriving late matches nothing.
// 'replied' and 'failed' are never overwritten; 'pending' moves nothing.
const RECIPIENT_STATUS_PREDECESSORS: Record<
  NormalizedStatusValue,
  readonly string[]
> = {
  pending: [],
  sent: ['pending'],
  delivered: ['pending', 'sent'],
  read: ['pending', 'sent', 'delivered'],
  failed: ['pending', 'sent'],
};

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}

export async function handleStatusUpdate(
  status: NormalizedStatus,
  // The account whose credentials authenticated this callback. Every
  // write below is confined to it: a message id is only as unique as
  // the gateway that minted it, and a tenant holding its OWN valid
  // webhook secret must not be able to rewrite another account's
  // delivery ticks (or fire its webhooks) by posting that account's
  // message ids. Optional only for older callers.
  accountId?: string
) {
  // 1) Mirror onto messages. The normaliser has already mapped the
  //    gateway's vocabulary onto the CRM's, and
  //    MESSAGE_STATUS_PREDECESSORS keeps the write forward-only and
  //    inside the CHECK constraint. message_id is NOT unique (migration
  //    009 — ids repeat across numbers), so this resolves 0..N rows —
  //    inside this account — and updates those.
  let rowsQuery = supabaseAdmin()
    .from('messages')
    .select(
      'id, conversation_id, ai_generated, conversations!inner(account_id)'
    )
    .eq('message_id', status.messageId);
  if (accountId)
    rowsQuery = rowsQuery.eq('conversations.account_id', accountId);
  const { data: msgRows, error: msgLookupErr } = await rowsQuery.limit(50);

  if (msgLookupErr) {
    console.error('Error resolving message for status update:', msgLookupErr);
  }
  const rows = (msgRows ?? []) as StatusMessageRow[];

  // The rows this receipt actually moved. A replay, or a receipt that
  // arrived after a later one, moves nothing — and so tells no webhook
  // subscriber anything and hands no thread over.
  let moved: StatusMessageRow[] = [];
  const predecessors = MESSAGE_STATUS_PREDECESSORS[status.status] ?? [];
  if (rows.length > 0 && predecessors.length > 0) {
    const { data: updated, error: msgErr } = await supabaseAdmin()
      .from('messages')
      .update({ status: status.status })
      .in(
        'id',
        rows.map((r) => r.id)
      )
      .in('status', [...predecessors])
      .select('id');
    if (msgErr) {
      console.error('Error updating message status:', msgErr);
    } else {
      const movedIds = new Set(
        ((updated ?? []) as Array<{ id: string }>).map((r) => r.id)
      );
      moved = rows.filter((r) => movedIds.has(r.id));
    }
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003), again only within this account. The
  //    aggregate trigger on broadcast_recipients re-derives the parent
  //    broadcast's sent/delivered/read/failed counts automatically.
  //
  //    A receipt that arrives before its row carries the wamid finds
  //    nothing here and is not retried; migration 066's reconcile
  //    replays it from the cost ledger (end of each delivery pass and
  //    every broadcast cron tick).
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString();

  let recipientQuery = supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status, broadcast_id, broadcasts!inner(account_id)')
    .eq('whatsapp_message_id', status.messageId);
  if (accountId) {
    recipientQuery = recipientQuery.eq('broadcasts.account_id', accountId);
  }
  const { data: recipient, error: recFetchErr } = await recipientQuery
    .limit(1)
    .maybeSingle();
  const recipientPredecessors =
    RECIPIENT_STATUS_PREDECESSORS[status.status] ?? [];

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr);
  } else if (
    recipient &&
    recipientPredecessors.length > 0 &&
    // A cheap pre-filter on the status just read — forward-only on the
    // success ladder, and `failed` only from pre-delivered states. The
    // UPDATE's WHERE below is what actually enforces it.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status };
    if (status.status === 'sent' && !('sent_at' in update))
      update.sent_at = tsIso;
    if (status.status === 'delivered') update.delivered_at = tsIso;
    if (status.status === 'read') update.read_at = tsIso;
    // Why, when the gateway said (Meta only). Without it the detail
    // page shows '-' and offers Retry failed, which for most of these
    // codes only fails again.
    if (status.status === 'failed' && status.error) {
      update.error_message = describeMetaFailure(
        status.error.code,
        status.error.title,
        status.error.details
      );
    }

    const { data: flipped, error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)
      // Forward-only in SQL: a concurrent receipt may have moved the
      // row since it was read (see RECIPIENT_STATUS_PREDECESSORS).
      .in('status', [...recipientPredecessors])
      .select('id');

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr);
    } else if (
      status.status === 'failed' &&
      (flipped ?? []).length > 0 &&
      recipient.broadcast_id
    ) {
      await settleBroadcastAfterLateFailure(
        supabaseAdmin(),
        recipient.broadcast_id
      );
    }
  }

  // 3) A reply the AI bot sent that WhatsApp then refused: the bot
  //    believes it answered, so nobody else will unless the thread is
  //    handed over (two bot replies lost to 131031 sat unassigned).
  if (status.status === 'failed') {
    const handled = new Set<string>();
    for (const row of moved) {
      if (row.ai_generated !== true || handled.has(row.conversation_id)) {
        continue;
      }
      handled.add(row.conversation_id);
      const owner = accountId ?? rowAccountId(row);
      if (owner) {
        await handOffUndeliveredBotReply(owner, row.conversation_id, status);
      }
    }
  }

  // 4) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  const first = moved[0];
  if (first) {
    const ownerAccountId = accountId ?? rowAccountId(first);
    if (ownerAccountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        ownerAccountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.messageId,
          conversation_id: first.conversation_id,
          status: status.status,
        }
      );
    }
  }
}

interface StatusMessageRow {
  id: string;
  conversation_id: string;
  ai_generated?: boolean | null;
  conversations: unknown;
}

function rowAccountId(row: StatusMessageRow): string | undefined {
  // PostgREST returns a many-to-one embed as a single object, but the
  // client's generated types widen every embed to an array. Handle
  // both shapes rather than trusting either.
  const rawConv = row.conversations;
  const conv = (Array.isArray(rawConv) ? rawConv[0] : rawConv) as
    { account_id: string } | null | undefined;
  return conv?.account_id;
}

/**
 * Hand a thread to a person because WhatsApp refused a reply the AI
 * bot sent. The same hand-off the bot makes itself in auto-reply.ts,
 * reason `error`: the bot stops on this thread, the configured hand-off
 * agent gets it (assigning notifies them), and the note says why. No
 * farewell — it would go out on the number that just failed.
 *
 * Once per thread: one already handed off is left alone, and the write
 * is conditional so a replayed receipt cannot hand it off twice. Never
 * throws — this runs on the status webhook's path.
 */
async function handOffUndeliveredBotReply(
  accountId: string,
  conversationId: string,
  status: NormalizedStatus
): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr) {
      console.error('[status] handoff lookup failed:', convErr.message);
      return;
    }
    if (!conv || conv.ai_autoreply_disabled) return;

    const { data: aiConfig } = await db
      .from('ai_configs')
      .select('handoff_agent_id')
      .eq('account_id', accountId)
      .maybeSingle();
    const handoffAgentId =
      (aiConfig as { handoff_agent_id?: string | null } | null)
        ?.handoff_agent_id ?? null;
    const assign = Boolean(handoffAgentId && !conv.assigned_agent_id);

    const why = status.error
      ? describeMetaFailure(
          status.error.code,
          status.error.title,
          status.error.details
        )
      : 'WhatsApp reported it as failed.';
    const summary = buildHandoffSummary({
      messages: await buildConversationContext(db, conversationId).catch(
        () => []
      ),
      replyCount: conv.ai_reply_count ?? 0,
      reason: 'error',
      reasonText: `Reason: WhatsApp did not deliver the bot's last reply — ${why}`,
    });

    let write = db
      .from('conversations')
      .update({
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
        ai_handoff_reason: 'error',
        ...(assign ? { assigned_agent_id: handoffAgentId } : {}),
      })
      .eq('id', conversationId)
      .eq('ai_autoreply_disabled', false);
    // Never stomp an assignment made since the read above.
    if (assign) write = write.is('assigned_agent_id', null);
    const { error: updErr } = await write;
    if (updErr) {
      console.error('[status] handoff update failed:', {
        conversationId,
        error: updErr.message,
      });
    }
  } catch (err) {
    console.error(
      '[status] handoff after a failed bot reply threw:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast, and stamp the conversation with
 * that campaign (migration 048) — the Campaign inbox lists
 * conversations by it, and the AI auto-reply reads it to know which
 * campaign message the customer is answering.
 *
 * Returns the campaign this message was the FIRST reply to, with the
 * flow it asks to be continued by (migration 054), or null when the
 * message answers no campaign — a second reply to the same campaign is
 * null too, because the recipient row is already `replied`. The flow
 * runner starts that flow exactly once, on this first reply.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(
  accountId: string,
  contactId: string,
  conversationId: string
): Promise<{ broadcastId: string; followUpFlowId: string | null } | null> {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select(
        'id, status, broadcast_id, broadcasts!inner(account_id, follow_up_flow_id)'
      )
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return null;

    const row = recs[0];
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr);
      return null;
    }

    const { error: convErr } = await supabaseAdmin()
      .from('conversations')
      .update({
        campaign_broadcast_id: row.broadcast_id,
        campaign_replied_at: new Date().toISOString(),
      })
      .eq('id', conversationId);
    if (convErr) {
      console.error('Error stamping conversation with campaign:', convErr);
    }

    // PostgREST types an embedded to-one relation as an object or an
    // array depending on how it inferred the FK; read it either way.
    const parent = Array.isArray(row.broadcasts)
      ? row.broadcasts[0]
      : row.broadcasts;
    return {
      broadcastId: row.broadcast_id,
      followUpFlowId:
        (parent as { follow_up_flow_id?: string | null } | null | undefined)
          ?.follow_up_flow_id ?? null,
    };
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err);
    return null;
  }
}

/**
 * Resolve a WhatsApp message id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install, or one
 * sent from the operator's phone before the channel was connected).
 */
async function lookupInternalIdByWhatsAppId(
  whatsappMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', whatsappMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error(
      '[inbound] lookupInternalIdByWhatsAppId failed:',
      error.message
    );
    return null;
  }
  return data?.id ?? null;
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: NormalizedInboundMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction;
  if (!reaction?.targetMessageId) return;

  const targetInternalId = await lookupInternalIdByWhatsAppId(
    reaction.targetMessageId,
    conversationId
  );
  if (!targetInternalId) {
    console.warn(
      '[inbound] reaction target message not found; skipping',
      reaction.targetMessageId
    );
    return;
  }

  // Empty emoji = the customer removed their reaction.
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId);
    if (delError) {
      console.error('[inbound] reaction delete failed:', delError.message);
    }
    return;
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    );
  if (upsertError) {
    console.error('[inbound] reaction upsert failed:', upsertError.message);
  }
}

export async function processMessage(
  message: NormalizedInboundMessage,
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp channel; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  // The number this arrived on, credentials already decrypted. Carries
  // the gateway to pull media bytes from, the provider stamped onto the
  // message row, and the per-channel media-mirror opt-out (migration
  // 039).
  channel: WhatsAppChannel,
  // Work that must finish inside the route's after() but need not hold
  // up the next message of the same delivery (TypeSafe's watch). The
  // route awaits it after its loop; without it, it is awaited here.
  later?: Promise<unknown>[]
) {
  const mirrorMedia = channel.mirrorInboundMedia;
  const senderPhone = normalizePhone(message.from);
  // Whapi carries the sender's WhatsApp display name on the message
  // itself (`from_name`), so there's no separate contacts array to zip
  // against as there was with Meta. Fall back to the number when the
  // sender has no public display name.
  const contactName = message.fromName || senderPhone;

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    channel.id
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(
      supabaseAdmin(),
      accountId,
      'conversation.created',
      {
        conversation_id: conversation.id,
        contact_id: contactRecord.id,
      }
    );
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id);
    return;
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(
      message,
      channel,
      mirrorMedia ? { accountId } : null
    );

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null;
  if (message.contextMessageId) {
    replyToInternalId = await lookupInternalIdByWhatsAppId(
      message.contextMessageId,
      conversation.id
    );
    if (!replyToInternalId) {
      console.warn(
        '[inbound] reply context parent not found:',
        message.contextMessageId
      );
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_type, template_name, message_id, status,
  //   created_at

  // The messages.content_type CHECK constraint (widened in migration 010
  // for 'interactive' and 050 for 'contacts') allows:
  //   text, image, document, audio, video, location, template,
  //   interactive, contacts
  // The normaliser already narrowed Whapi's much larger type vocabulary
  // down to this set plus `sticker`, which has no column value of its
  // own and maps to the closest allowed one.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
    'contacts',
  ]);
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image' // stickers are WebP images
      : 'text'; // anything unforeseen

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  // Existence, not a count: `count: 'exact'` walked every customer
  // message in the thread on every inbound, to compare the total to 0.
  const { data: priorCustomerMsg } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
    .limit(1);
  const isFirstInboundMessage = (priorCustomerMsg ?? []).length === 0;

  // Idempotent insert. Meta retries webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message.id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert — an empty result means this delivery
  // was a replay. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        // Meta's MIME type for the attachment (migration 039). Was
        // discarded before, which forced the download path to guess an
        // extension from the fetched blob — impossible to do until the
        // bytes had already been fetched successfully.
        media_type: mediaType,
        message_id: message.id,
        status: 'delivered',
        // Which number this came in on (migration 046). Read back by
        // `resolveReplyChannel` so an agent's reply goes out on the
        // same one the customer used.
        provider: channel.provider,
        // The exact number (migration 060) — `provider` stopped naming
        // one once an account could hold two Whapi channels.
        channel_id: channel.id,
        created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'. Migration 010 added
        // the column; null for every other content_type so existing inserts
        // behave identically.
        interactive_reply_id: interactiveReplyId,
        // The parsed card(s) on a shared contact (migration 050).
        contact_cards: message.type === 'contacts' ? message.contacts : null,
        // The customer forwarded this from another chat (migration 055).
        is_forwarded: message.forwarded,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id');

  if (msgError) {
    console.error('Error inserting message:', msgError);
    return;
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      message.id
    );
    return;
  }

  // Update conversation. The unread bump is done DB-side (migration 037's
  // bump_conversation_on_inbound) rather than as a read-modify-write of the
  // snapshot loaded above: two inbound messages for the same conversation
  // can process concurrently, and computing `snapshot + 1` in the app let
  // both reads see the same value and write the same increment, losing one
  // (issue #369). The RPC increments in a single UPDATE and refreshes the
  // last-message summary in the same statement.
  const { error: convError } = await supabaseAdmin().rpc(
    'bump_conversation_on_inbound',
    {
      p_conversation_id: conversation.id,
      p_last_message_text: contentText || `[${message.type}]`,
    }
  );

  if (convError) {
    console.error('Error updating conversation:', convError);
  }

  // The thread is on whichever number the customer just wrote to
  // (migration 060) — that decides which allocated members see it and
  // which number the next reply leaves from. Conditional, so the common
  // case (same number as last time) writes nothing. After the
  // idempotency boundary like everything else side-effecting.
  //
  // Not while a person has pinned the chat to a number (migration 061):
  // the customer answering on the number an agent just moved them to
  // must not hand the chat to that number's team and away from the
  // agent who is working it.
  if (!conversation.send_channel_id && conversation.channel_id !== channel.id) {
    const { error: channelError } = await supabaseAdmin()
      .from('conversations')
      .update({ channel_id: channel.id })
      .eq('id', conversation.id)
      // Re-checked in the statement: a person may have pinned the chat
      // (061) since the snapshot above was read.
      .is('send_channel_id', null);
    if (channelError) {
      console.error(
        '[inbound] could not stamp conversation channel:',
        channelError
      );
    }
  }

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate conditional statement rather than a `status` field on the
  // update above so the write can be gated on the row's CURRENT status in
  // SQL — see the helper for why that matters.
  await reopenClosedConversation(supabaseAdmin(), conversation);

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003). A first reply to a campaign
  // with a follow-up flow is also what starts that flow, below.
  const campaignReply = await flagBroadcastReplyIfAny(
    accountId,
    contactRecord.id,
    conversation.id
  );

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // A campaign's first reply starts the campaign's follow-up flow
  // (migration 054) ahead of the entry triggers; the runner's `ai`
  // fallback answers off-script messages mid-run on the bot's number,
  // which is why the inbound provider goes along.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    inboundProvider: channel.provider,
    inboundChannelId: channel.id,
    campaign: campaignReply?.followUpFlowId
      ? {
          broadcastId: campaignReply.broadcastId,
          followUpFlowId: campaignReply.followUpFlowId,
        }
      : null,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: contentText ?? message.text ?? '',
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply');
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated)
    automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage)
    automationTriggers.unshift('first_inbound_message');
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run. That is issue #301's failure mode
  // recurring one level down, and it's what issue #409 reported as runs
  // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // AI auto-reply. Runs for any inbound the deterministic flow runner
  // did NOT consume (flows win over the LLM), and only when the account
  // has enabled it. Awaited inside `after()` (same reason as the webhook
  // dispatch below); `dispatchInboundToAiReply` owns its eligibility
  // gates + try/catch and never throws.
  //
  // A button tap is not excluded here. It used to be, on the assumption
  // that a Flow or an `interactive_reply` automation always owns the
  // buttons — but the most common tap is a *template* quick-reply on a
  // campaign sent with no follow-up Flow, and with nothing else claiming
  // it the customer heard nothing back. The tapped title ("Get a quote")
  // is the customer's message and the bot answers it like typed text;
  // `dispatchInboundToAiReply` still stands down when an active
  // `interactive_reply` automation exists, mirroring the message-level
  // rule, so an automation-driven menu is not double-answered.
  //
  // A run that broke on this message (`failed`, migration 054) hands it
  // back here too, so the customer is not left with a bot that stopped
  // mid-sentence.
  const flowBroke = flowResult.outcome === 'failed';
  if ((flowBroke || !flowConsumed) && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
      inboundProvider: channel.provider,
      inboundChannelId: channel.id,
      interactiveReply: Boolean(interactiveReplyId),
      interactiveReplyId: interactiveReplyId ?? null,
      inboundMessageId: message.id,
      // A media caption is not in the bot's text context (context.ts
      // keeps text/interactive rows only); the gates still read it.
      inboundText,
    });
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  });

  // TypeSafe's watch on conversations the bot did not answer (migration
  // 064): catches an opt-out written to a person, a flow or an
  // automation. Last, and handed to `later` when the route collects it,
  // so it delays nothing the customer, an endpoint or the next message
  // in the delivery waits for. It skips a message the bot's own triage
  // already judged, is off unless the account switched it on, and never
  // throws.
  const watch = watchInboundMessage({
    accountId,
    conversationId: conversation.id,
    contactId: contactRecord.id,
    messageId: message.id,
    text: inboundText,
    configOwnerUserId,
  });
  if (later) later.push(watch);
  else await watch;
}
/**
 * Turn a normalised inbound message into the columns the `messages`
 * row needs: display text, a durable media URL, the MIME type, and the
 * tapped-option id for interactive replies.
 *
 * ─── Where inbound media comes from under Whapi ───────────────────
 *
 * `registerWebhook` turns Whapi's auto-download on, so an attachment
 * arrives with a `link` already pointing at Whapi's file store. That
 * link is NOT durable — Whapi retains inbound files for roughly 30
 * days, exactly the same expiry problem Meta's media ids had (issue
 * #466), and an attachment that silently becomes "Photo unavailable" a
 * month later is a bad outcome for a CRM whose whole job is history.
 *
 * So the link is a starting point, not a destination: `mirrorInboundMedia`
 * copies the bytes into the account's `chat-media` bucket and we persist
 * that permanent URL instead. When auto-download hasn't populated a link
 * (a channel configured before this CRM registered its webhook), we fall
 * back to resolving the media id through `GET /media/{id}`.
 *
 * The mirror is strictly best-effort — it swallows its own failures and
 * returns null. A webhook that threw would have Whapi redeliver and
 * re-run everything downstream, which is far worse than an attachment
 * that expires.
 */
async function parseMessageContent(
  message: NormalizedInboundMessage,
  channel: WhatsAppChannel,
  // Tenancy + opt-out for the media mirror. Null disables mirroring
  // entirely, which is what the account-level toggle does.
  mirror: { accountId: string } | null
): Promise<{
  contentText: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null;
}> {
  // Default shape — each branch overrides only what it cares about.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  };

  // ---- Non-media types resolve without any network call ----------

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text };

    case 'location': {
      const loc = message.location;
      if (!loc) return empty;
      const locationText = [
        loc.name,
        loc.address,
        `${loc.latitude},${loc.longitude}`,
      ]
        .filter(Boolean)
        .join(' - ');
      return { ...empty, contentText: locationText };
    }

    case 'contacts':
      return { ...empty, contentText: message.text };

    case 'reaction':
      // Never reached in practice — processMessage short-circuits
      // reactions before calling here — but kept total so a future
      // caller can't fall through to the media path with no payload.
      return { ...empty, contentText: message.reaction?.emoji ?? null };

    case 'interactive':
      // The customer tapped a reply button or a list row on a message we
      // sent. Use the human-readable title as contentText so the inbox
      // bubble reads legibly ("Existing customer"), and keep the stable
      // id separately so Flows and the `interactive_reply` automation
      // trigger can route on it.
      return {
        ...empty,
        contentText:
          message.interactiveReplyTitle ??
          message.interactiveReplyId ??
          '[Interactive reply]',
        interactiveReplyId: message.interactiveReplyId,
      };
  }

  // ---- Media types: image / video / audio / document / sticker ----

  const media = message.media;
  if (!media) {
    return { ...empty, contentText: message.text };
  }

  const mediaUrl = await resolveInboundMediaUrl(message, channel, mirror);

  return {
    ...empty,
    // A document with no caption still deserves a legible bubble, so
    // fall back to its filename.
    contentText:
      message.text ?? (message.type === 'document' ? media.filename : null),
    mediaUrl,
    mediaType: media.mimeType,
  };
}

/**
 * Produce the durable URL stored on `messages.media_url`, preferring a
 * copy in our own bucket and degrading gracefully at every step.
 *
 * Returns null only when the bytes are genuinely unreachable — the
 * message still persists, just without an attachment, which is what the
 * inbox renders as a missing-media bubble.
 */
async function resolveInboundMediaUrl(
  message: NormalizedInboundMessage,
  channel: WhatsAppChannel,
  mirror: { accountId: string } | null
): Promise<string | null> {
  const media = message.media;
  if (!media) return null;

  let downloadUrl = media.link;
  let mimeType = media.mimeType;
  let fileSize = media.fileSize;

  // No link on the payload — resolve the media id through whichever
  // gateway this arrived on. Whapi auto-downloads so it usually HAS a
  // link; Meta never sends one, so every Cloud API attachment lands
  // here.
  if (!downloadUrl) {
    if (!media.id) return null;
    try {
      const info = await getMediaUrl({ channel, mediaId: media.id });
      downloadUrl = info.url;
      mimeType = mimeType ?? info.mimeType;
      fileSize = fileSize ?? info.fileSize;
    } catch (error) {
      console.error(
        `[inbound] could not resolve media ${media.id}:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  if (mirror) {
    try {
      const mirrored = await mirrorInboundMedia({
        storage: supabaseAdmin().storage,
        accountId: mirror.accountId,
        mediaId: media.id ?? message.id,
        downloadUrl,
        accessToken: channel.accessToken,
        mimeType: mimeType ?? undefined,
        fileSize,
        fileName: media.filename,
        messageTimestamp: message.timestamp,
      });
      if (mirrored) return mirrored;
    } catch (error) {
      // mirrorInboundMedia already swallows its own failures; this is
      // belt-and-braces so an unexpected throw can't lose the message.
      console.error(
        '[inbound] media mirror threw unexpectedly:',
        error instanceof Error ? error.message : error
      );
    }
  }

  // Mirroring off or failed: fall back to Whapi's own link. It works
  // today and expires in ~30 days, which beats an empty bubble now.
  return downloadUrl;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

interface ContactOutcome {
  contact: ContactRow;
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean;
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone
  );

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(
        supabaseAdmin(),
        accountId,
        phone
      );
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('Error creating contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  // The number this arrived on (migration 060). Stamped at creation so
  // the thread is visible to that number's people from its very first
  // realtime event — stamped later, the INSERT and first-message events
  // are evaluated against a NULL channel and never reach them.
  channelId: string
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('Error finding conversation:', findError);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      channel_id: channelId,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('Error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}
