/**
 * One queued inbound event (migration 264) turned into CRM state: the
 * shared processor of the three webhook routes and of the cron that
 * retries. Everything it calls is idempotent on the gateway's message id,
 * so processing an event twice is safe.
 *
 * Never throws; answers the outcome to settle the event with. A reason is
 * a fixed phrase plus an error code, never customer text.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { recordGroupCustomerText } from '@/lib/brain/sink';
import { caseIntakeQueueFor, caseSlaInboundHook } from '@/lib/cases/server';
import { groupDocumentFiler } from '@/lib/customer-docs/group-documents';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  applyGroupStatuses,
  persistGroupMessages,
  type GroupChannel,
  type GroupInboundMessage,
} from '@/lib/groups/inbound';
import {
  copyGroupMessageMedia,
  hasGroupFile,
} from '@/lib/groups/inbound-media';
import { recordSubmissionGroupInbound } from '@/lib/submission-groups/inbound';
import { SubmissionGroupStore } from '@/lib/submission-groups/store';
import type { WhatsAppChannel } from './channels';
import { decrypt } from './encryption';
import type { NormalizedInboundMessage, NormalizedStatus } from './inbound';
import { InboundPersistError } from './inbound-persist-error';
import { handleStatusUpdate, processMessage } from './inbound-pipeline';
import type { NormalizedOpenWAOwnSend } from './openwa-webhook';
import { persistOwnSend, resolveOpenWALidPhone } from './own-send';
import {
  sanitizePayload,
  type InboundEvent,
  type InboundOutcome,
} from './webhook-inbox';

// ---------- Payloads, one shape per kind ----------

/** `fanOut: false` only for a sender over the webhook rate limit. */
export function messagePayload(
  message: NormalizedInboundMessage,
  overLimit = false
): { message: NormalizedInboundMessage; fanOut?: false } {
  return overLimit ? { message, fanOut: false } : { message };
}

export function statusPayload(status: NormalizedStatus) {
  return { status };
}

export function ownSendPayload(ownSend: NormalizedOpenWAOwnSend) {
  return { ownSend };
}

export function groupMessagePayload(message: GroupInboundMessage) {
  return { message };
}

// ---------- Channel ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InboundConfigRow = any;

/**
 * The channel a `whatsapp_config` row stands for, as each webhook route
 * shapes it. Decrypts the token, so it can throw.
 */
export function inboundChannel(
  provider: WhatsAppChannel['provider'],
  config: InboundConfigRow
): WhatsAppChannel {
  const personal = provider === 'openwa' && config.is_personal === true;
  return {
    id: config.id,
    accountId: config.account_id,
    provider,
    label: config.label ?? null,
    phoneNumberId: config.phone_number_id,
    wabaId: config.waba_id ?? null,
    accessToken: decrypt(config.access_token),
    appSecret: null,
    // A Meta number is primary only when it says so; the other two unless
    // they say otherwise.
    isPrimary:
      provider === 'meta'
        ? config.is_primary === true
        : config.is_primary !== false,
    mirrorInboundMedia: config.mirror_inbound_media !== false,
    status: config.status ?? 'connected',
    isPersonal: personal,
    personalUserId: personal ? (config.user_id ?? null) : null,
  };
}

// ---------- Processor ----------

export interface InboundEventDeps {
  /** Service role. */
  admin?: SupabaseClient;
  /**
   * The authenticated `whatsapp_config` row, when the caller holds it. The
   * drain passes nothing: it is read by the event's number and account.
   */
  config?: InboundConfigRow;
  /**
   * Background work of a message, as for `processMessage`: the caller
   * awaits it after its loop. Without it, it is awaited here.
   */
  later?: Promise<unknown>[];
}

const DONE: InboundOutcome = { outcome: 'done' };
const failed = (reason: string): InboundOutcome => ({
  outcome: 'failed',
  reason,
});
const UNREADABLE = failed('payload is not readable');
const NO_CREDENTIALS = failed('number credentials could not be decrypted');

/** An error's code or class; its message may quote the customer. */
function errorTag(error: unknown): string {
  if (error instanceof InboundPersistError) {
    return error.code ? `${error.stage} ${error.code}` : error.stage;
  }
  const e = error as { code?: unknown; name?: unknown } | null;
  for (const tag of [e?.code, e?.name]) {
    if (typeof tag === 'string' && /^\w{1,40}$/.test(tag)) return tag;
  }
  return 'unknown error';
}

export async function processInboundEvent(
  event: InboundEvent,
  deps: InboundEventDeps = {}
): Promise<InboundOutcome> {
  let result: InboundOutcome;
  try {
    // Postgres refuses U+0000 and half surrogates in any text column, not
    // only in the queue: the first try works on the same copy a retry gets.
    result = await run(
      { ...event, payload: sanitizePayload(event.payload) },
      deps
    );
  } catch (error) {
    result = failed(`${event.kind} failed: ${errorTag(error)}`);
  }
  if (result.outcome === 'failed') {
    console.error(
      `[inbound-events] ${event.provider} ${event.kind} on ${event.channel}: ${result.reason}`
    );
  }
  return result;
}

async function run(
  event: InboundEvent,
  deps: InboundEventDeps
): Promise<InboundOutcome> {
  const admin = deps.admin ?? supabaseAdmin();

  let config = deps.config;
  if (!config) {
    const { data, error } = await admin
      .from('whatsapp_config')
      .select('*')
      .eq('id', event.channel)
      .eq('account_id', event.accountId)
      .eq('provider', event.provider)
      .maybeSingle();
    if (error) return failed(`number read failed: ${errorTag(error)}`);
    if (!data) return failed('number not found');
    config = data;
  }
  // A row handed in for another number would file the event under it.
  if (config.id !== event.channel || config.account_id !== event.accountId) {
    return failed('number does not match the event');
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.kind) {
    case 'message':
      return runMessage(event, config, payload, deps);
    case 'status':
      return runStatus(event, admin, config, payload);
    case 'own_send':
      return runOwnSend(event, admin, config, payload);
    case 'group_message':
      return runGroupMessage(event, admin, config, payload, deps);
    default: {
      const unknown: never = event.kind;
      return failed(`unknown kind ${String(unknown).slice(0, 40)}`);
    }
  }
}

/** Null when the stored token does not decrypt (a rotated ENCRYPTION_KEY). */
function channelOrNull(
  event: InboundEvent,
  config: InboundConfigRow
): WhatsAppChannel | null {
  try {
    return inboundChannel(event.provider, config);
  } catch {
    return null;
  }
}

async function runMessage(
  event: InboundEvent,
  config: InboundConfigRow,
  payload: Record<string, unknown>,
  deps: InboundEventDeps
): Promise<InboundOutcome> {
  const message = payload.message as NormalizedInboundMessage | undefined;
  if (!message?.id) return UNREADABLE;
  const channel = channelOrNull(event, config);
  if (!channel) return NO_CREDENTIALS;
  await processMessage(
    message,
    event.accountId,
    config.user_id,
    channel,
    deps.later,
    {
      onPersistFailure: 'throw',
      // Over the sender's limit: kept in the inbox, answered by nothing.
      ...(payload.fanOut === false ? { fanOut: false } : {}),
    }
  );
  return DONE;
}

async function runStatus(
  event: InboundEvent,
  admin: SupabaseClient,
  config: InboundConfigRow,
  payload: Record<string, unknown>
): Promise<InboundOutcome> {
  const status = payload.status as NormalizedStatus | undefined;
  if (!status?.messageId) return UNREADABLE;
  const own = await handleStatusUpdate(status, event.accountId);
  // A 1:1 receipt matches no group row and a group's no `messages` row, so
  // every receipt goes to both.
  const groupMoved = carriesGroups(event, config)
    ? await applyGroupStatuses(admin, groupChannel(config), [status])
    : 0;
  if (own.failed) return failed('receipt not applied');
  // A repeated group receipt moves no row and so reads as unmatched, which
  // costs two cheap retries and no bell.
  return own.matched || groupMoved > 0 ? DONE : { outcome: 'unmatched' };
}

async function runOwnSend(
  event: InboundEvent,
  admin: SupabaseClient,
  config: InboundConfigRow,
  payload: Record<string, unknown>
): Promise<InboundOutcome> {
  // Filed only on a personal number; a company number's are already rows.
  if (event.provider !== 'openwa' || config.is_personal !== true) return DONE;
  const own = payload.ownSend as NormalizedOpenWAOwnSend | undefined;
  if (!own?.id) return UNREADABLE;
  const channel = channelOrNull(event, config);
  if (!channel) return NO_CREDENTIALS;
  const peerPhone =
    own.peerPhone ??
    (own.peerLid
      ? await resolveOpenWALidPhone({
          apiKey: channel.accessToken,
          sessionId: channel.phoneNumberId,
          lid: own.peerLid,
        })
      : null);
  if (!peerPhone) {
    console.warn('[inbound-events] own send to a peer with no phone number');
    // A lid the gateway has not learned yet gets `unmatched`'s two short
    // retries, and never a bell; with no lid there is nothing to learn.
    return own.peerLid ? { outcome: 'unmatched' } : DONE;
  }
  await persistOwnSend(
    admin,
    channel,
    { id: own.id, peerPhone, text: own.text, timestamp: own.timestamp },
    { onPersistFailure: 'throw' }
  );
  return DONE;
}

/** Meta's groups are deal rooms (their own path); a personal number has none. */
function carriesGroups(event: InboundEvent, config: InboundConfigRow): boolean {
  switch (event.provider) {
    case 'whapi':
      return true;
    case 'openwa':
      return config.is_personal !== true;
    case 'meta':
      return false;
    default: {
      const unknown: never = event.provider;
      throw new Error(`Unknown provider: ${String(unknown)}`);
    }
  }
}

function groupChannel(config: InboundConfigRow): GroupChannel {
  return {
    id: config.id,
    accountId: config.account_id,
    wabaId: config.waba_id ?? null,
  };
}

async function runGroupMessage(
  event: InboundEvent,
  admin: SupabaseClient,
  config: InboundConfigRow,
  payload: Record<string, unknown>,
  deps: InboundEventDeps
): Promise<InboundOutcome> {
  const message = payload.message as GroupInboundMessage | undefined;
  if (!message?.id) return UNREADABLE;
  if (event.provider === 'meta') return failed('group message on Meta');
  if (!carriesGroups(event, config)) return DONE;

  const channel = groupChannel(config);
  let error: string | null = null;
  try {
    await persistGroupMessages(admin, channel, [message]);
  } catch (e) {
    error = `group message failed: ${errorTag(e)}`;
  }
  // The file's bytes, once the row is stored. Never throws, so the event
  // settles the same whether or not the copy works; a retry finds our link
  // on the row and copies nothing.
  if (!error && hasGroupFile(message)) {
    const copy = copyGroupMessageMedia(
      admin,
      () => inboundChannel(event.provider, config),
      message
    );
    if (deps.later) deps.later.push(copy);
    else await copy;
  }
  if (event.provider !== 'whapi') return error ? failed(error) : DONE;

  // Submission groups (Whapi only) are not in `whatsapp_groups`. Both
  // writes are idempotent on (group, message id), so each runs whatever the
  // other did. The hooks collect; the filer and the intake run after, the
  // intake last because it reads what the filer wrote.
  const filer = groupDocumentFiler({
    admin,
    channel: () => inboundChannel(event.provider, config),
  });
  const intake = caseIntakeQueueFor(admin);
  try {
    const sg = await recordSubmissionGroupInbound(
      new SubmissionGroupStore(admin),
      channel,
      [message],
      {
        caseSla: caseSlaInboundHook(admin),
        customerDocument: (doc) => {
          filer.hook(doc);
          intake.document(doc);
        },
        customerText: async (m) => {
          intake.text(m);
          await recordGroupCustomerText(m);
        },
      }
    );
    if (sg.failed > 0) error ??= 'submission group message failed';
  } catch (e) {
    error ??= `submission group message failed: ${errorTag(e)}`;
  } finally {
    // Never throw. Only a newly recorded message was collected, so a retry
    // files nothing twice.
    await filer.run();
    await intake.run();
  }
  return error ? failed(error) : DONE;
}
