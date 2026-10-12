/**
 * The journey bot's inbound hook (module 016): runs a customer message
 * through the contact's open journey file. Server-only (service role).
 *
 * inbound-pipeline.ts calls it after Flows, and only when no Flow
 * consumed the message. When it consumes the message, the content
 * automations and the AI reply stand down exactly as they do for a
 * Flow; the relationship triggers still fire. It never throws: a
 * failure is logged and reads as "not consumed".
 *
 * - Only for accounts with `journey_settings.enabled`.
 * - The contact's open file takes the event; with none, one is opened
 *   only when `start_on_first_inbound` is on.
 * - text → INBOUND_TEXT (with the Click-to-WhatsApp `freeEntry`), a
 *   button / list / template quick reply → BUTTON with its workflow
 *   payload (`payloadForReply`: the id, then the account's titles, then
 *   the default titles; an unmatched reply is INBOUND_TEXT with its
 *   title), media → MEDIA. Event id `wa:<message id>`.
 * - A START_NEW_JOURNEY the event caused, once delivered (its
 *   `delivery_ref` is the contact's new open file), re-runs the same
 *   event on the new file as `wa:<message id>:new`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound';
import { createRunner, type HandleResult } from '../runner';
import type { WorkflowDef } from '../schema';
import { NEW_STATE, type JourneyEvent } from '../types';
import { SHIPPED_WORKFLOW } from '../workflow';
import { SupabaseConsentPort } from './consent';
import { mergeCopy, payloadForReply, type JourneyCopy } from './copy';
import { createJourneySink, withFailureRecording } from './sink';
import { JourneyDbError, SupabaseJourneyStore, ensureOpenFile } from './store';
import { SHIPPED_WORKFLOW_KEY } from './tick';

export type InboundJourneyEvent = Extract<
  JourneyEvent,
  { type: 'INBOUND_TEXT' | 'BUTTON' | 'MEDIA' }
>;

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** The journey event a WhatsApp message stands for, or null (location, contacts, an empty text…). */
export function journeyEventFor(
  message: NormalizedInboundMessage,
  copy: JourneyCopy,
  at: string
): InboundJourneyEvent | null {
  if (message.type === 'interactive') {
    const pick = (s: string | null) => (s ? payloadForReply(s, copy) : null);
    const payload =
      pick(message.interactiveReplyId) ?? pick(message.interactiveReplyTitle);
    if (payload) return { type: 'BUTTON', payload, at };
    const title = (
      message.interactiveReplyTitle ??
      message.interactiveReplyId ??
      ''
    ).trim();
    return title
      ? { type: 'INBOUND_TEXT', text: title, at, freeEntry: message.freeEntry }
      : null;
  }
  if (MEDIA_TYPES.has(message.type)) return { type: 'MEDIA', count: 1, at };
  if (message.type === 'text' && message.text?.trim())
    return {
      type: 'INBOUND_TEXT',
      text: message.text,
      at,
      freeEntry: message.freeEntry,
    };
  return null;
}

type Runner = Pick<ReturnType<typeof createRunner>, 'handle'>;

export interface JourneyInboundArgs {
  /** The service-role client. */
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  conversationId: string;
  message: NormalizedInboundMessage;
}

export interface JourneyInboundDeps {
  now?: () => Date;
  /** Workflow definitions by `journey_settings.workflow_key`; the shipped one by default. */
  workflows?: Record<string, WorkflowDef>;
  runnerFor?: (def: WorkflowDef, db: SupabaseClient) => Runner;
}

const shippedRunner = (def: WorkflowDef, db: SupabaseClient): Runner =>
  createRunner({
    def,
    store: new SupabaseJourneyStore(db),
    consent: new SupabaseConsentPort(db),
    sink: withFailureRecording(createJourneySink({ db, def }), db),
  });

async function openFile(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<{ id: string; state: string } | null> {
  const { data, error } = await db
    .from('journey_files')
    .select('id, state')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .is('closed_at', null)
    .maybeSingle();
  if (error) throw new JourneyDbError('journey_files', error);
  return (data as { id: string; state: string } | null) ?? null;
}

/** The contact's new open file when `oldFileId` delivered the START_NEW_JOURNEY that opened it. */
async function startedFile(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  oldFileId: string
): Promise<{ id: string; state: string } | null> {
  const open = await openFile(db, accountId, contactId);
  if (!open || open.id === oldFileId) return null;
  const { data, error } = await db
    .from('journey_outbox')
    .select('delivery_ref')
    .eq('file_id', oldFileId)
    .eq('status', 'delivered')
    .eq('action->>type', 'START_NEW_JOURNEY');
  if (error) throw new JourneyDbError('journey_outbox', error);
  const refs = (data ?? []) as { delivery_ref: string | null }[];
  return refs.some((r) => r.delivery_ref === open.id) ? open : null;
}

/** A file handled the event: its state changed or it produced actions. */
const handled = (r: HandleResult, before: string): boolean =>
  r.status === 'ok' &&
  (r.result.file.state !== before || r.result.actions.length > 0);

export async function dispatchInboundToJourney(
  { db, accountId, contactId, conversationId, message }: JourneyInboundArgs,
  deps: JourneyInboundDeps = {}
): Promise<{ consumed: boolean }> {
  try {
    const { data, error } = await db
      .from('journey_settings')
      .select('enabled, workflow_key, start_on_first_inbound, copy')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new JourneyDbError('journey_settings', error);
    const settings = data as {
      enabled: boolean;
      workflow_key: string;
      start_on_first_inbound: boolean;
      copy: unknown;
    } | null;
    if (!settings?.enabled) return { consumed: false };
    const workflows = deps.workflows ?? {
      [SHIPPED_WORKFLOW_KEY]: SHIPPED_WORKFLOW,
    };
    const def = workflows[settings.workflow_key];
    if (!def) {
      console.warn(
        `[journeys] account ${accountId}: unknown workflow ${settings.workflow_key}; inbound not handled`
      );
      return { consumed: false };
    }

    const now = (deps.now?.() ?? new Date()).toISOString();
    const sec = Number(message.timestamp);
    const at =
      Number.isFinite(sec) && sec > 0
        ? new Date(sec * 1000).toISOString()
        : now;
    const event = journeyEventFor(message, mergeCopy(settings.copy), at);
    if (!event) return { consumed: false };

    let file = await openFile(db, accountId, contactId);
    if (!file) {
      if (!settings.start_on_first_inbound) return { consumed: false };
      file = {
        id: await ensureOpenFile(db, {
          accountId,
          contactId,
          conversationId,
          workflowKey: settings.workflow_key,
        }),
        state: NEW_STATE,
      };
    }

    const runner = (deps.runnerFor ?? shippedRunner)(def, db);
    const id = `wa:${message.id}`;
    const first = await runner.handle({ ...event, id, fileId: file.id }, now);
    if (first.status === 'rejected')
      console.warn(
        `[journeys] file ${file.id}: ${id} rejected: ${first.error.code}`
      );
    let consumed = handled(first, file.state);

    if (
      first.status === 'ok' &&
      first.result.actions.some((a) => a.type === 'START_NEW_JOURNEY')
    ) {
      const next = await startedFile(db, accountId, contactId, file.id);
      if (next) {
        const again = await runner.handle(
          { ...event, id: `${id}:new`, fileId: next.id },
          now
        );
        consumed = handled(again, next.state) || consumed;
      }
    }
    return { consumed };
  } catch (err) {
    console.error(
      `[journeys] inbound ${message.id}: journey hook failed:`,
      err instanceof Error ? err.message : err
    );
    return { consumed: false };
  }
}
