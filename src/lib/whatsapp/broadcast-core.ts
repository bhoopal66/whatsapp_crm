// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTemplate,
  describeSendFailure,
  isChannelLevelFailure,
  isDefiniteSendRefusal,
} from '@/lib/whatsapp/provider';
import {
  resolveChannelForSurface,
  ChannelError,
  isLinkedDeviceProvider,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { validateContactPhone } from '@/lib/contacts/phone-validation';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { headerMediaProblem } from '@/lib/whatsapp/template-send-builder';
import { isInQuietHours, type QuietHours } from '@/lib/broadcasts/quiet-hours';
import {
  RESENDABLE_FILTER,
  SEND_UNCONFIRMED_REASON,
  SENT_NOT_RECORDED_REASON,
} from '@/lib/broadcasts/unconfirmed-send';
import {
  consentRefusal,
  type ConsentRefusal,
} from '@/lib/whatsapp/send-origin';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import {
  checkAutoStartAllowed,
  companyConversationId,
  campaignDailyLimitMessage,
} from '@/lib/team-activity/auto-guard';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Throw `template_media_missing` when a Meta send of this template could
 * not carry its header media. Planners (create, resume, scheduled) call
 * it for Meta channels only — Whapi renders such a template as text.
 */
export function assertHeaderMedia(
  template: MessageTemplate,
  headerMediaUrl: string | null | undefined
): void {
  const problem = headerMediaProblem(template, headerMediaUrl);
  if (problem) {
    throw new BroadcastError('template_media_missing', problem, 400);
  }
}

export interface BroadcastRecipientInput {
  /** International phone with its country code (validateContactPhone). */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /**
   * Flow started for each recipient on their first reply (migration
   * 054). Must be an active flow on this account; rejected otherwise,
   * before anything is persisted.
   */
  flowId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  /**
   * The recipient's contact, for the number's daily new-chat limit
   * (migration 204). Absent on a plan built before it was carried.
   */
  contactId?: string | null;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  /** Whapi channel id — carried for logging and resume bookkeeping. */
  channelId: string;
  /** Decrypted Whapi channel token. */
  /**
   * The number this broadcast sends from. Resolved once at plan time
   * from the `broadcast` route (migration 046), so every recipient in
   * one campaign goes out on the same channel even if an admin changes
   * the routing mid-delivery.
   */
  channel: WhatsAppChannel;
  /**
   * The local template row. Under Whapi this is the message itself, not
   * a lookup key for a remote registry, so it is required — planners
   * reject a missing row before they build a plan.
   */
  templateRow: MessageTemplate;
  /**
   * Media header (image / video / document URL) chosen for this campaign
   * in the wizard, persisted on `broadcasts.header_media_url` (migration
   * 053) so a scheduled or resumed pass sends the same asset the
   * original would have. Null/undefined → the provider falls back to the
   * template's stored URL.
   */
  headerMediaUrl?: string | null;
  /**
   * The campaign's "do not send between" window (migration 053), read
   * again before every send. Null/undefined: the campaign has none.
   */
  quietHours?: QuietHours | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front by validateContactPhone; no row is created. */
  rejected: number;
  /**
   * Recipients left out because the customer opted out
   * (`contacts.opted_out_at`, migration 076) or is marked do-not-contact
   * (`do_not_contact_at`, 086). At plan time no row is
   * created for them; a resume pass stamps their pending rows failed.
   */
  skippedOptedOut: number;
}

const MAX_RECIPIENTS = 1000;

/** The failure reason stamped on a recipient who opted out. */
export const OPTED_OUT_REASON = 'Customer opted out of messages';

/** The failure reason for each answer of the consent register. */
export const CONSENT_FAILURE_REASONS: Record<ConsentRefusal, string> = {
  opted_out: OPTED_OUT_REASON,
  do_not_contact: 'Customer is marked do-not-contact',
};

/**
 * Why a pass stopped, or a Resume was refused, for quiet hours. The
 * prefix is what the cron recognises the stop by.
 */
export const QUIET_HOURS_STOP_PREFIX = 'Stopped for quiet hours';

export function quietHoursMessage(quiet: QuietHours): string {
  return `${QUIET_HOURS_STOP_PREFIX}: nothing is sent between ${quiet.start} and ${quiet.end} (${quiet.tz}). Resume after ${quiet.end} to send the rest.`;
}

/**
 * Contact ids per opted-out lookup: the ids travel in the request URL,
 * and 1000 of them would outgrow a proxy's request-line limit.
 */
const OPT_OUT_LOOKUP_CHUNK = 100;

/**
 * Which of these contacts must not be messaged, and why: opted out
 * (migration 076) or do-not-contact (086). Throws on a failed read: a broadcast must not go out to people who
 * opted out because the check could not run.
 */
async function consentRefusals(
  db: SupabaseClient,
  accountId: string,
  contactIds: string[]
): Promise<Map<string, ConsentRefusal>> {
  const refusals = new Map<string, ConsentRefusal>();
  for (let i = 0; i < contactIds.length; i += OPT_OUT_LOOKUP_CHUNK) {
    const { data, error } = await db
      .from('contacts')
      .select('id, opted_out_at, do_not_contact_at')
      .eq('account_id', accountId)
      .in('id', contactIds.slice(i, i + OPT_OUT_LOOKUP_CHUNK));
    if (error) {
      console.error('[broadcast-core] opted-out lookup error:', error);
      throw new BroadcastError('internal', 'Failed to check opt-outs', 500);
    }
    for (const row of data ?? []) {
      const refusal = consentRefusal(row);
      if (refusal) refusals.set(row.id, refusal);
    }
  }
  return refusals;
}

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Which number this campaign sends from. Fails fast, before any
  // recipient rows exist, so a misconfigured account does not leave a
  // half-planned broadcast behind.
  //
  // This obeys the admin's `broadcast` route rather than following any
  // conversation: a campaign is business-initiated, and routing
  // marketing to the Cloud API number is the entire reason the selector
  // exists. On Meta the template must also be APPROVED — see sendTemplate.
  let channel: WhatsAppChannel;
  try {
    channel = await resolveChannelForSurface(db, accountId, 'broadcast');
  } catch (err) {
    if (err instanceof ChannelError) {
      throw new BroadcastError(err.code, err.message, err.status);
    }
    throw err;
  }

  // Template row (once). Under Whapi the row IS the broadcast message —
  // it is rendered locally and sent as an ordinary WhatsApp message —
  // so both a malformed row and a missing one are hard failures, caught
  // here rather than as N identical opaque per-recipient errors.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — open Settings → Templates and re-save it before broadcasting.',
      500
    );
  }
  if (!resolvedTemplate.row) {
    throw new BroadcastError(
      'template_not_found',
      `No template named "${templateName}" exists on this account.`,
      404
    );
  }
  const templateRow = resolvedTemplate.row;

  // A media header with no media fails every recipient identically at
  // send time on Meta; say so once, before anything is persisted.
  if (channel.provider === 'meta') {
    assertHeaderMedia(templateRow, null);
  }

  // The follow-up flow (054), checked before any row exists: a campaign
  // that names a flow nobody can start is a campaign that silently
  // behaves like one without, which is the kind of thing that is only
  // noticed once the replies have gone unanswered.
  const flowId =
    typeof params.flowId === 'string' && params.flowId.trim()
      ? params.flowId.trim()
      : null;
  if (flowId) {
    const { data: flow } = await db
      .from('flows')
      .select('id, status')
      .eq('id', flowId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!flow) {
      throw new BroadcastError(
        'flow_not_found',
        `No flow with id "${flowId}" exists on this account.`,
        404
      );
    }
    if (flow.status !== 'active') {
      throw new BroadcastError(
        'flow_not_active',
        `Flow "${flowId}" is ${flow.status}; activate it before pointing a campaign at it.`,
        400
      );
    }
  }

  // Resolve each recipient to a contact. A number that fails the
  // contact-entry rule POST /api/v1/contacts applies (no country code,
  // too short, a malformed +971 number, spreadsheet notation) is dropped
  // and counted as rejected rather than aborting the whole broadcast:
  // the gateway accepts a send to a local number as 'sent' to nobody,
  // and the contact created for it would later take the customer's
  // real inbound. A valid number goes on in its normalized form.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  let firstRejection: string | null = null;
  for (const [index, r] of recipients.entries()) {
    const checked = validateContactPhone(
      typeof r.to === 'string' ? r.to : '',
      `'recipients[${index}].to'`
    );
    if (!checked.ok) {
      rejected++;
      firstRejection ??= checked.error;
      continue;
    }
    // Stored only on a contact this call creates (migration 249), as the
    // wizard's CSV audience does (csv-contact-insert.ts).
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: checked.normalized,
      lead_source: 'broadcast',
    });
    resolved.push({
      contactId: id,
      phone: checked.normalized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const unique = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  // A customer who asked not to be messaged (migration 076) gets no
  // recipient row at all, so no later pass can send to them either.
  const refusals = await consentRefusals(
    db,
    accountId,
    unique.map((r) => r.contactId)
  );
  const deduped = unique.filter((r) => !refusals.has(r.contactId));
  const skippedOptedOut = unique.length - deduped.length;

  if (deduped.length === 0 && skippedOptedOut > 0) {
    throw new BroadcastError(
      'bad_request',
      'Every recipient with a valid phone number has opted out of messages or is marked do-not-contact.',
      400
    );
  }
  // Only reachable when every recipient was rejected, so the first
  // rejection is set; it says what to fix.
  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      `No recipient had a valid phone number. ${firstRejection ?? ''}`.trim(),
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // The create function predates 054 and takes no flow; stamp it after.
  // A failure here is logged, not thrown: the rows exist and the send
  // should go ahead — the campaign just behaves as one without a flow.
  if (flowId) {
    const { error: flowErr } = await db
      .from('broadcasts')
      .update({ follow_up_flow_id: flowId })
      .eq('id', broadcastId);
    if (flowErr) {
      console.error(
        '[broadcast-core] follow_up_flow_id update error:',
        flowErr
      );
    }
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        contactId: row.contact_id,
        phone: r.phone,
        params: r.params,
      };
    }
  );

  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    channelId: channel.phoneNumberId,
    channel,
    templateRow,
    planned,
    rejected,
    skippedOptedOut,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one recipient's failure never aborts the
 * rest; a failure of the channel itself does (see `channelFailure`).
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan,
  opts: {
    /** Refresh the delivery lock; false when it may be another pass's. */
    keepLock?: () => Promise<boolean>;
  } = {}
): Promise<void> {
  // Set when the NUMBER failed rather than the recipient (logged-out
  // phone, revoked token, lapsed subscription). Every later send would
  // fail the same way, and a recipient stamped 'failed' is out of reach
  // of Resume and the cron, which plan from 'pending' — so the pass
  // stops and leaves this and every later recipient pending instead.
  let channelFailure: unknown = null;
  // Set when the number reached its daily new-chat limit (migration
  // 204). Handled like `channelFailure`: every later start on this
  // number would be refused too, so the pass stops instead of asking
  // once per recipient, and the rest stay pending for a Resume once the
  // day turns.
  let dailyLimit: string | null = null;
  // Set when the pass reached the campaign's quiet hours, or the database
  // stopped answering the reads and writes that keep a send safe. Both
  // stop it the same way.
  let stopped: string | null = null;
  // Set when the delivery lock is no longer certainly this pass's: the
  // campaign is then another pass's to send and to settle.
  let lockLost = false;
  let attempted = 0;
  let refreshedAt = Date.now();
  let refreshedAtAttempt = 0;

  for (const recipient of plan.planned) {
    if (
      opts.keepLock &&
      (attempted - refreshedAtAttempt >= LOCK_REFRESH_SENDS ||
        Date.now() - refreshedAt >= LOCK_REFRESH_MS)
    ) {
      if (!(await opts.keepLock())) {
        lockLost = true;
        stopped = 'the delivery lock could not be kept';
        break;
      }
      refreshedAt = Date.now();
      refreshedAtAttempt = attempted;
    }

    // A pass of hundreds of sends outlives the moment it was planned, so
    // both of these are asked again for every recipient.
    if (plan.quietHours && isInQuietHours(new Date(), plan.quietHours)) {
      stopped = quietHoursMessage(plan.quietHours);
      await db
        .from('broadcast_recipients')
        .update({ error_message: stopped })
        .eq('id', recipient.recipientRowId)
        .in('status', ['pending', 'failed']);
      break;
    }
    if (recipient.contactId && plan.channel.accountId) {
      let refusal: ConsentRefusal | undefined;
      try {
        refusal = (
          await consentRefusals(db, plan.channel.accountId, [
            recipient.contactId,
          ])
        ).get(recipient.contactId);
      } catch {
        stopped = 'the opt-out check failed';
        break;
      }
      if (refusal) {
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: CONSENT_FAILURE_REASONS[refusal],
          })
          .eq('id', recipient.recipientRowId);
        continue;
      }
    }

    if (
      recipient.contactId &&
      plan.channel.accountId &&
      isLinkedDeviceProvider(plan.channel.provider)
    ) {
      const admin = supabaseAdmin();
      const check = await checkAutoStartAllowed(
        admin,
        plan.channel.accountId,
        await companyConversationId(
          admin,
          plan.channel.accountId,
          recipient.contactId
        ),
        plan.channel
      );
      if (check.blocked) {
        dailyLimit = campaignDailyLimitMessage(check);
        await db
          .from('broadcast_recipients')
          .update({ error_message: dailyLimit })
          .eq('id', recipient.recipientRowId)
          .in('status', ['pending', 'failed']);
        break;
      }
    }

    // Write-ahead: the row says "may have been sent" BEFORE the gateway is
    // asked, so a pass that dies mid-send leaves a row the next plan fails
    // instead of sending again. Conditional, so a row another pass already
    // sent or is sending matches nothing and is skipped.
    const { data: marked, error: markError } = await db
      .from('broadcast_recipients')
      .update({ error_message: SEND_UNCONFIRMED_REASON })
      .eq('id', recipient.recipientRowId)
      .in('status', ['pending', 'failed'])
      .or(RESENDABLE_FILTER)
      .select('id');
    if (markError) {
      stopped = `the next send could not be recorded: ${markError.message}`;
      break;
    }
    if (!marked || marked.length === 0) continue;

    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await sendTemplate({
          channel: plan.channel,
          to: variant,
          template: plan.templateRow,
          bodyParams: recipient.params,
          headerMediaUrl: plan.headerMediaUrl ?? undefined,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        if (isChannelLevelFailure(error)) {
          channelFailure = error;
          break;
        }
        if (!isDefiniteSendRefusal(error)) {
          // A timeout or a 5xx may have reached the customer: no other
          // variant, and no Retry (`RESENDABLE_FILTER`).
          console.error(
            `[broadcast-core] ${plan.broadcastId}: unconfirmed send to recipient ${recipient.recipientRowId}:`,
            describeSendFailure(error)
          );
          lastError = SEND_UNCONFIRMED_REASON;
          break;
        }
        // Provider-aware: names Meta's closed 24-hour window and
        // unapproved-template rejections, which are otherwise stored
        // against the recipient row as bare numeric codes.
        const message = describeSendFailure(error);
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (channelFailure) {
      // The row keeps its status — 'pending' for Resume, or 'failed'
      // on a Retry failed pass — but says why the pass stopped.
      // Otherwise nothing in the app does: the detail page shows '-'
      // (or the old per-recipient reason) against every recipient,
      // each Resume stops at this same row, and the health monitor
      // probes Whapi numbers only, so a revoked Meta token raises no
      // alert. The status filter keeps a concurrent pass's 'sent'
      // stamp from getting a stale reason. A later successful stamp
      // clears it.
      await db
        .from('broadcast_recipients')
        .update({ error_message: describeSendFailure(channelFailure) })
        .eq('id', recipient.recipientRowId)
        .in('status', ['pending', 'failed']);
      break;
    }
    attempted++;

    if (sentMessageId) {
      const stampError = await stampSent(
        db,
        recipient.recipientRowId,
        sentMessageId
      );
      if (stampError) {
        // The customer has the message. Any terminal status keeps the row
        // out of the next pass; the write-ahead mark does if this fails
        // too.
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: SENT_NOT_RECORDED_REASON,
          })
          .eq('id', recipient.recipientRowId);
        stopped = `a send could not be recorded: ${stampError}`;
        break;
      }
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  if (channelFailure) {
    console.error(
      `[broadcast-core] ${plan.broadcastId}: stopped after ${attempted} of ${plan.planned.length} recipients; the rest stay pending for Resume.`,
      describeSendFailure(channelFailure)
    );
  }
  if (dailyLimit ?? stopped) {
    console.warn(
      `[broadcast-core] ${plan.broadcastId}: stopped after ${attempted} of ${plan.planned.length} recipients; ${dailyLimit ?? stopped}`
    );
  }

  // Receipts that beat a wamid stamp above were matched to nothing.
  await reconcileBroadcastStatuses({ broadcastId: plan.broadcastId });
  if (!lockLost) await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * A pass refreshes its lock after this many sends or this long, whichever
 * comes first: both well inside DELIVERY_LOCK_STALE_MS, even when every
 * send waits out the gateway's timeout.
 */
const LOCK_REFRESH_SENDS = 20;
const LOCK_REFRESH_MS = 5 * 60 * 1000;

const SENT_STAMP_ATTEMPTS = 3;

/** Stamp a delivered send. Returns the last error, or null once stored. */
async function stampSent(
  db: SupabaseClient,
  recipientRowId: string,
  messageId: string
): Promise<string | null> {
  const sentAt = new Date().toISOString();
  let lastError = '';
  for (let attempt = 1; attempt <= SENT_STAMP_ATTEMPTS; attempt++) {
    const { error } = await db
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        sent_at: sentAt,
        whatsapp_message_id: messageId,
        error_message: null,
      })
      .eq('id', recipientRowId);
    if (!error) return null;
    lastError = error.message;
    if (attempt < SENT_STAMP_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  return lastError;
}

let reconcileMissingLogged = false;

/**
 * Apply Meta receipts the status webhook could not match (migration 066,
 * `reconcile_broadcast_recipient_statuses`): a receipt that arrives
 * before its recipient row carries the wamid is otherwise lost, and a
 * lost `failed` leaves the recipient 'sent' forever.
 *
 * Service role only, so it goes through `supabaseAdmin()` whatever
 * client the caller holds. Returns the rows changed, or null when the
 * function is unavailable or failed. Never throws: it runs at the end
 * of a delivery pass and on every cron tick, and a build deployed ahead
 * of its migration must keep delivering.
 */
export async function reconcileBroadcastStatuses(
  opts: { broadcastId?: string | null; since?: string } = {}
): Promise<number | null> {
  try {
    const args: Record<string, unknown> = {
      p_broadcast_id: opts.broadcastId ?? null,
    };
    if (opts.since) args.p_since = opts.since;
    const { data, error } = await supabaseAdmin().rpc(
      'reconcile_broadcast_recipient_statuses',
      args
    );
    if (error) {
      // PGRST202: PostgREST has no such function; 42883: Postgres agrees.
      if (error.code === 'PGRST202' || error.code === '42883') {
        if (!reconcileMissingLogged) {
          reconcileMissingLogged = true;
          console.warn(
            '[broadcast-core] reconcile_broadcast_recipient_statuses is missing — apply migration 066.'
          );
        }
        return null;
      }
      console.error('[broadcast-core] reconcile failed:', error.message);
      return null;
    }
    return typeof data === 'number' ? data : null;
  } catch (err) {
    console.error(
      '[broadcast-core] reconcile threw:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const status = await terminalStatusFromRecipients(db, broadcastId);
  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if (!status) return;

  await db
    .from('broadcasts')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', broadcastId);
}

/**
 * The finalize rule, re-applied when a recipient fails AFTER the pass
 * that finalized its campaign: Meta accepts a send, answers with a
 * wamid, and only later reports it failed (131031 on a locked account,
 * 131049, 131026…). Without this a campaign in which every recipient
 * failed that way reads 'sent' forever.
 *
 * Moves 'sent' to 'failed' and nothing else — a campaign still sending,
 * scheduled, or already failed is left alone. Never throws: it runs on
 * the status webhook's path.
 */
export async function settleBroadcastAfterLateFailure(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  try {
    if ((await terminalStatusFromRecipients(db, broadcastId)) !== 'failed') {
      return;
    }
    const { error } = await db
      .from('broadcasts')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', broadcastId)
      .eq('status', 'sent');
    if (error) {
      console.error('[broadcast-core] late-failure settle failed:', error);
    }
  } catch (err) {
    console.error(
      '[broadcast-core] late-failure settle threw:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * 'failed' when every recipient failed, 'sent' otherwise, and null while
 * any recipient is still pending or when a count could not be read: a
 * failed read counted as zero pending closed campaigns with hundreds of
 * customers still to message.
 */
async function terminalStatusFromRecipients(
  db: SupabaseClient,
  broadcastId: string
): Promise<'sent' | 'failed' | null> {
  const countWhere = async (status?: string): Promise<number | null> => {
    let query = db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId);
    if (status) query = query.eq('status', status);
    const { count, error } = await query;
    if (error) {
      console.error('[broadcast-core] recipient count failed:', error.message);
      return null;
    }
    return count;
  };

  if ((await countWhere('pending')) !== 0) return null;

  const failed = await countWhere('failed');
  const total = await countWhere();
  if (failed === null || total === null) return null;

  return failed > 0 && failed === total ? 'failed' : 'sent';
}
