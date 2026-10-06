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
} from '@/lib/whatsapp/provider';
import {
  resolveChannelForSurface,
  ChannelError,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { validateContactPhone } from '@/lib/contacts/phone-validation';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { headerMediaProblem } from '@/lib/whatsapp/template-send-builder';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

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
  planned: PlannedRecipient[];
  /** Phones rejected up front by validateContactPhone; no row is created. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

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
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: checked.normalized,
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
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

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
  plan: BroadcastPlan
): Promise<void> {
  // Set when the NUMBER failed rather than the recipient (logged-out
  // phone, revoked token, lapsed subscription). Every later send would
  // fail the same way, and a recipient stamped 'failed' is out of reach
  // of Resume and the cron, which plan from 'pending' — so the pass
  // stops and leaves this and every later recipient pending instead.
  let channelFailure: unknown = null;
  let attempted = 0;

  for (const recipient of plan.planned) {
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
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
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

  // Receipts that beat a wamid stamp above were matched to nothing.
  await reconcileBroadcastStatuses({ broadcastId: plan.broadcastId });
  await finalizeBroadcastStatus(db, plan.broadcastId);
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
 * any recipient is still pending.
 */
async function terminalStatusFromRecipients(
  db: SupabaseClient,
  broadcastId: string
): Promise<'sent' | 'failed' | null> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  if ((await countWhere('pending')) > 0) return null;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  return failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent';
}
