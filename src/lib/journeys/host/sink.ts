/**
 * The journey engine's `ActionSink` on Supabase: executes one outbox
 * item. Server-only (service-role client). Idempotent by `item.id`, as
 * ports.ts requires: a redelivered item is a no-op host-side.
 *
 * - SEND is at most once. `journey_claim_delivery` claims the item
 *   before the gateway call and the WhatsApp message id is stored in
 *   `delivery_ref` after it. A claim older than two minutes without a
 *   ref may or may not have reached WhatsApp, so it is never sent again:
 *   it is recorded as `delivery_ref = 'unconfirmed'` and logged.
 *   SESSION messages go out as interactive buttons / a list (ids = the
 *   workflow payload ids) or text, worded by `copy.ts`; MARKETING and
 *   UTILITY go out as the account's `message_templates` row. A template
 *   that is missing — or not APPROVED while the send would go out on a
 *   Meta number, which rejects it — drops the item (TEMPLATE_UNAVAILABLE)
 *   and opens one task per template per day.
 * - ADVISOR_TASK opens a task (sourceRef = the item id); REQUEST_CALLBACK
 *   queues a `callback_requests` row (unique on the item id).
 * - SET_OPT_OUT writes the register through `journey_set_opt_out`.
 * - START_NEW_JOURNEY opens the contact's next file and stores its id in
 *   the item's `delivery_ref`: that is the marker for the inbound job (a
 *   fresh file, version 0 and entry null, which the next inbound event —
 *   or the one that caused it, re-run on the new file — starts).
 * - SET_TIMER / CANCEL_TIMERS (timers live in the file, and
 *   `journey_files.next_timer_at` is kept by journey_commit), CLOSE,
 *   LOG_COST (costs come from the Meta pricing ledger, migration 051) and
 *   MARK_OPTIN_WELCOME_SENT (the SEND claims the welcome itself; the
 *   committed MARK already holds the step-time cap) are no-ops.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendText,
} from '@/lib/flows/channel-send';
import { engineSendTemplate } from '@/lib/automations/channel-send';
import { resolveBotChannel } from '@/lib/whatsapp/channels';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { createSystemTask, resolveTaskOwner } from '@/lib/tasks/system';
import type { ActionSink, OutboxItem } from '../ports';
import type { WorkflowDef } from '../schema';
import type { Action } from '../types';
import { SHIPPED_WORKFLOW } from '../workflow';
import { loadJourneyCopy, renderSession } from './copy';
import {
  JourneyDbError,
  SupabaseJourneyStore,
  ensureOpenFile,
  rpcScalar,
} from './store';

/**
 * The senders' `userId` is an audit label they do not persist or use for
 * tenancy; journey sends are the bot's (`sender_type = 'bot'`).
 */
const JOURNEY_SENDER = 'journey-bot';

/** Another delivery claimed this SEND under two minutes ago: stop the drain and retry later. */
export class JourneyDeliveryInFlightError extends Error {
  constructor(readonly itemId: string) {
    super(`journey outbox item ${itemId}: another delivery is in flight`);
    this.name = 'JourneyDeliveryInFlightError';
  }
}

export type ClaimState =
  'claimed' | 'delivered' | 'dropped' | 'in_flight' | 'stale';
const CLAIM_STATES: readonly unknown[] = [
  'claimed',
  'delivered',
  'dropped',
  'in_flight',
  'stale',
];

const TASK_TITLES: Record<string, string> = {
  REISSUE_OFFER: 'Re-issue the expired quote/offer',
  CALLBACK: 'Call the customer back',
  CALLBACK_BLOCKED_DNC: 'Callback requested by a do-not-contact customer',
  ADVISOR_NUDGE: 'Nudge the customer (free-text, within 24 h)',
  WINDOW_CLOSED: 'Window closed — send a template',
};

/** A task title for an ADVISOR_TASK kind: named ones, else the kind humanised. */
export function taskTitle(kind: string): string {
  if (TASK_TITLES[kind]) return TASK_TITLES[kind];
  const words = kind.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Journey task';
}

interface FileCtx {
  accountId: string;
  contactId: string;
  conversationId: string | null;
  workflowKey: string;
}

type SendAction = Extract<Action, { type: 'SEND' }>;

export interface JourneySinkDeps {
  db: SupabaseClient;
  now?: () => Date;
  /** The workflow whose template registry SESSION sends are rendered from. */
  def?: WorkflowDef;
}

export function createJourneySink({
  db,
  now = () => new Date(),
  def = SHIPPED_WORKFLOW,
}: JourneySinkDeps): ActionSink {
  const store = new SupabaseJourneyStore(db);

  async function fileCtx(fileId: string): Promise<FileCtx> {
    const { data, error } = await db
      .from('journey_files')
      .select('account_id, contact_id, conversation_id, workflow_key')
      .eq('id', fileId)
      .maybeSingle();
    if (error) throw new JourneyDbError('journey_files', error);
    const row = data as {
      account_id: string;
      contact_id: string;
      conversation_id: string | null;
      workflow_key: string;
    } | null;
    if (!row) throw new Error(`journey file ${fileId} not found`);
    return {
      accountId: row.account_id,
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      workflowKey: row.workflow_key,
    };
  }

  /** The file's conversation, else the contact's latest one. */
  async function conversationOf(ctx: FileCtx): Promise<string | null> {
    if (ctx.conversationId) return ctx.conversationId;
    const { data, error } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new JourneyDbError('conversations', error);
    return (data as { id: string } | null)?.id ?? null;
  }

  async function setRef(itemId: string, ref: string): Promise<void> {
    const { error } = await db
      .from('journey_outbox')
      .update({ delivery_ref: ref })
      .eq('id', itemId);
    if (error) throw new JourneyDbError('journey_outbox', error);
  }

  async function claim(itemId: string): Promise<ClaimState> {
    const { data, error } = await db.rpc('journey_claim_delivery', {
      p_item_id: itemId,
    });
    if (error) throw new JourneyDbError('journey_claim_delivery', error);
    const state = rpcScalar('journey_claim_delivery', data);
    if (CLAIM_STATES.includes(state)) return state as ClaimState;
    throw new Error(
      `journey_claim_delivery: unexpected result ${JSON.stringify(data)}`
    );
  }

  /** Drops the item and opens one task per template per day (best-effort: a failed task is only logged). */
  async function templateUnavailable(
    item: OutboxItem,
    a: SendAction,
    ctx: FileCtx,
    why: string
  ): Promise<void> {
    await store.markDropped(item.id, 'TEMPLATE_UNAVAILABLE');
    const day = now().toISOString().slice(0, 10);
    try {
      await createSystemTask(db, {
        accountId: ctx.accountId,
        kind: 'journey',
        title: `WhatsApp template "${a.template}" is not available`,
        note: `The journey bot could not send "${a.template}" (${a.category}): ${why}. Journey messages that need it are skipped until it is available.`,
        source: 'journey',
        sourceRef: `tpl:${a.template}:${day}`,
        meta: { template: a.template, category: a.category, reason: why },
      });
    } catch (err) {
      console.error(
        `[journeys] could not open the missing-template task for ${a.template}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  async function send(item: OutboxItem, a: SendAction): Promise<void> {
    const ctx = await fileCtx(item.fileId);
    const conversationId = await conversationOf(ctx);
    if (!conversationId) {
      console.warn(
        `[journeys] outbox item ${item.id}: contact ${ctx.contactId} has no conversation; ${a.template} dropped`
      );
      await store.markDropped(item.id, 'NO_CONVERSATION');
      return;
    }

    const state = await claim(item.id);
    if (state === 'delivered' || state === 'dropped') return;
    if (state === 'in_flight') throw new JourneyDeliveryInFlightError(item.id);
    if (state === 'stale') {
      // At most once: the earlier attempt may have reached WhatsApp.
      console.warn(
        `[journeys] outbox item ${item.id} (${a.template}): stale delivery claim with no message id; recorded as unconfirmed, not resent`
      );
      await setRef(item.id, 'unconfirmed');
      return;
    }

    const base = {
      accountId: ctx.accountId,
      userId: JOURNEY_SENDER,
      conversationId,
      contactId: ctx.contactId,
    };
    let messageId: string;
    try {
      if (a.category === 'SESSION') {
        const t = def.templates[a.template];
        const msg = t
          ? renderSession(
              a.template,
              t,
              await loadJourneyCopy(db, ctx.accountId),
              a.variant
            )
          : null;
        if (!msg)
          return await templateUnavailable(item, a, ctx, 'no session copy');
        const r =
          msg.kind === 'text'
            ? await engineSendText({ ...base, text: msg.text, surface: 'flow' })
            : msg.kind === 'buttons'
              ? await engineSendInteractiveButtons({
                  ...base,
                  bodyText: msg.body,
                  buttons: msg.buttons,
                })
              : await engineSendInteractiveList({
                  ...base,
                  bodyText: msg.body,
                  buttonLabel: msg.buttonLabel,
                  sections: [{ rows: msg.rows }],
                });
        messageId = r.whatsapp_message_id;
      } else {
        const { row } = await resolveTemplateRow(db, ctx.accountId, a.template);
        if (!row)
          return await templateUnavailable(item, a, ctx, 'no template row');
        const status = String(
          (row as { status?: unknown }).status ?? ''
        ).toUpperCase();
        if (status !== 'APPROVED') {
          // The number engineSendTemplate will use (its 'automation' route).
          const channel = await resolveBotChannel(
            db,
            ctx.accountId,
            'automation',
            conversationId
          );
          if (channel.provider === 'meta')
            return await templateUnavailable(
              item,
              a,
              ctx,
              `status ${status || 'unknown'} on a Meta number`
            );
        }
        const r = await engineSendTemplate({
          ...base,
          templateName: a.template,
        });
        messageId = r.whatsapp_message_id;
      }
    } catch (err) {
      // The claim stays: a send that failed half-way is not retried.
      await db
        .from('journey_outbox')
        .update({
          last_error: (err instanceof Error ? err.message : String(err)).slice(
            0,
            500
          ),
        })
        .eq('id', item.id)
        .then(
          () => undefined,
          () => undefined
        );
      throw err;
    }
    await setRef(item.id, messageId || 'unconfirmed');
  }

  async function advisorTask(
    item: OutboxItem,
    a: Extract<Action, { type: 'ADVISOR_TASK' }>
  ): Promise<void> {
    const ctx = await fileCtx(item.fileId);
    const conversationId = await conversationOf(ctx);
    const owner = await resolveTaskOwner(db, ctx.accountId, {
      contactId: ctx.contactId,
      conversationId,
    });
    await createSystemTask(db, {
      accountId: ctx.accountId,
      kind: a.kind.startsWith('CALLBACK') ? 'callback' : 'journey',
      title: taskTitle(a.kind),
      note: a.note || null,
      contactId: ctx.contactId,
      conversationId,
      assignedTo: owner,
      dueAt: a.dueAt,
      source: 'journey',
      sourceRef: item.id,
      meta: { journeyFileId: item.fileId, kind: a.kind },
    });
  }

  async function requestCallback(
    item: OutboxItem,
    a: Extract<Action, { type: 'REQUEST_CALLBACK' }>
  ): Promise<void> {
    const ctx = await fileCtx(item.fileId);
    const conversationId = await conversationOf(ctx);
    const owner = await resolveTaskOwner(db, ctx.accountId, {
      contactId: a.contactId,
      conversationId,
    });
    const { error } = await db.from('callback_requests').upsert(
      {
        account_id: ctx.accountId,
        contact_id: a.contactId,
        conversation_id: conversationId,
        journey_file_id: a.fileId,
        source: 'journey',
        not_before: a.notBefore ?? null,
        assigned_to: owner,
        outbox_item_id: item.id,
      },
      { onConflict: 'outbox_item_id', ignoreDuplicates: true }
    );
    if (error) throw new JourneyDbError('callback_requests', error);
  }

  async function setOptOut(item: OutboxItem, optedOut: boolean): Promise<void> {
    const ctx = await fileCtx(item.fileId);
    const { error } = await db.rpc('journey_set_opt_out', {
      p_contact_id: ctx.contactId,
      p_opted_out: optedOut,
    });
    if (error) throw new JourneyDbError('journey_set_opt_out', error);
  }

  async function startNewJourney(
    item: OutboxItem,
    a: Extract<Action, { type: 'START_NEW_JOURNEY' }>
  ): Promise<void> {
    const ctx = await fileCtx(item.fileId);
    const fileId = await ensureOpenFile(db, {
      accountId: ctx.accountId,
      contactId: a.contactId,
      conversationId: await conversationOf(ctx),
      workflowKey: ctx.workflowKey,
    });
    if (fileId === item.fileId) {
      // The old file is still open (not WON / NOT_WON): nothing new to start.
      console.warn(
        `[journeys] outbox item ${item.id}: START_NEW_JOURNEY while file ${fileId} is still open`
      );
      return;
    }
    await setRef(item.id, fileId);
  }

  return {
    async deliver(item: OutboxItem): Promise<void> {
      const a = item.action;
      switch (a.type) {
        case 'SEND':
          return send(item, a);
        case 'ADVISOR_TASK':
          return advisorTask(item, a);
        case 'REQUEST_CALLBACK':
          return requestCallback(item, a);
        case 'SET_OPT_OUT':
          return setOptOut(item, a.optedOut);
        case 'START_NEW_JOURNEY':
          return startNewJourney(item, a);
        case 'SET_TIMER':
        case 'CANCEL_TIMERS':
        case 'CLOSE':
        case 'LOG_COST':
        case 'MARK_OPTIN_WELCOME_SENT':
          return;
        default: {
          const unknown: never = a;
          throw new Error(
            `journey sink: unknown action ${JSON.stringify(unknown)}`
          );
        }
      }
    },
  };
}
