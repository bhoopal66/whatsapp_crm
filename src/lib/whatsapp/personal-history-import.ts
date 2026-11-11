/**
 * The one-time import of a personal number's phone history (migration
 * 191): every one-to-one chat on the person's own WhatsApp, as far back
 * as the gateway reads, text only, filed into that person's personal
 * chats.
 *
 * A job is one `personal_history_imports` row per personal OpenWA
 * number, worked in leased ticks (`claim_personal_history_import`):
 * list the phone's chats once into `personal_history_import_chats`,
 * then read each chat's history newest chat first until the tick's
 * budget is spent. Rows go in through `import_history_rows`, which
 * dedupes on `(conversation_id, message_id)` and touches neither unread
 * nor status. Nothing here runs the inbound pipeline: imported messages
 * start no flow, automation, AI reply, bell, push or webhook.
 *
 * The gateway is shared with the number's live traffic, so chats are
 * read one at a time with a pause between them. A deep history read
 * has no cursor and can take minutes; a timeout only stops our wait,
 * so a retry asks for fewer messages (2000 → 500 → 100) rather than
 * the same read again.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CHANNEL_COLUMNS,
  toChannel,
  type ChannelRow,
  type WhatsAppChannel,
} from './channels';
import { contactCardsText, parseVcard } from './contact-card';
import {
  findOrCreateContact,
  findOrCreatePersonalChat,
} from './inbound-pipeline';
import {
  OpenWAError,
  getChatHistory,
  getContactPhone,
  listChats,
  type OpenWAChatSummary,
  type OpenWAHistoryMessage,
} from './openwa-api';
import { normalizePhone } from './phone-utils';

// ============================================================
// Mapping (pure)
// ============================================================

/** One element of `import_history_rows`' jsonb array. */
export interface HistoryRow {
  sender_type: 'agent' | 'customer';
  sender_id: string | null;
  content_type: 'text';
  content_text: string;
  message_id: string;
  status: 'sent' | 'delivered';
  provider: 'openwa';
  channel_id: string;
  created_at: string;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A placeholder, then the caption on the next line when there is one. */
function withCaption(label: string, caption: string): string {
  return caption ? `${label}\n${caption}` : label;
}

/** The text a history message is stored as, or null to leave it out. */
function historyText(msg: OpenWAHistoryMessage): string | null {
  const body = trimmed(msg.body);
  switch (msg.type) {
    case 'text':
      return body || null;
    case 'image':
      return withCaption('[photo]', body);
    case 'video':
      return withCaption('[video]', body);
    case 'document':
      return withCaption('[document]', body);
    case 'audio':
      return '[audio]';
    case 'voice':
      return '[voice note]';
    case 'sticker':
      return '[sticker]';
    case 'location': {
      const place =
        trimmed(msg.location?.description) || trimmed(msg.location?.address);
      return place ? `[location: ${place}]` : '[location]';
    }
    // whatsapp-web.js puts a shared card's vCard in `body`, as live.
    case 'contact': {
      const card = body ? parseVcard(body) : null;
      return card ? contactCardsText([card]) : null;
    }
    case 'poll': {
      const name = trimmed(msg.poll?.name);
      return name ? `[poll: ${name}]` : '[poll]';
    }
    case 'call':
      return '[call]';
    // revoked, order, product, unknown and anything newer: nothing to show.
    default:
      return null;
  }
}

/**
 * One phone-history message → an `import_history_rows` row, or null
 * when there is nothing to store. The owner's own messages become
 * agent rows sent by the owner; the other side's, customer rows.
 */
export function historyMessageToRow(
  msg: OpenWAHistoryMessage,
  ctx: { ownerId: string; channelId: string }
): HistoryRow | null {
  if (!msg || typeof msg.id !== 'string' || !msg.id) return null;
  if (typeof msg.timestamp !== 'number' || !Number.isFinite(msg.timestamp)) {
    return null;
  }
  const text = historyText(msg);
  if (!text) return null;
  const fromMe = msg.fromMe === true;
  return {
    sender_type: fromMe ? 'agent' : 'customer',
    sender_id: fromMe ? ctx.ownerId : null,
    content_type: 'text',
    content_text: text,
    message_id: msg.id,
    status: fromMe ? 'sent' : 'delivered',
    provider: 'openwa',
    channel_id: ctx.channelId,
    created_at: new Date(msg.timestamp * 1000).toISOString(),
  };
}

/** Only one-to-one chats with a person are imported. */
export function isImportableChat(chat: OpenWAChatSummary): boolean {
  return (
    chat.kind === 'individual' &&
    !chat.isGroup &&
    (chat.id.endsWith('@c.us') || chat.id.endsWith('@lid'))
  );
}

// ============================================================
// The tick
// ============================================================

const CHAT_PAGE = 1000;
/** A phone with more chats than this is listed no further. */
const MAX_CHAT_PAGES = 20;
const FIRST_LIMIT = 2000;
/** The next `limit` after a failed read of `limit`. */
const LIMIT_STEPS: Record<number, number> = { 2000: 500, 500: 100 };
const MIN_LIMIT = 100;
const MAX_ATTEMPTS = 3;
const ROW_BATCH = 500;
/** No history read is started with less time left than this. */
const MIN_READ_MS = 10_000;
const READ_MARGIN_MS = 5_000;
const MAX_READ_MS = 40_000;
const PENDING_PAGE = 25;

export interface PersonalHistoryImportTickOptions {
  /** Wall time this tick may use. */
  budgetMs: number;
  /** Clock, for tests. */
  now?: () => number;
  /** The pause between two chats (gateway shared with live traffic). */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PersonalHistoryImportTickResult {
  enqueued: number;
  /** The job worked this tick, if any. */
  configId: string | null;
  status: string | null;
  chatsDone: number;
  messagesImported: number;
}

interface ImportRow {
  config_id: string;
  account_id: string;
  user_id: string;
  status: string;
  chats_total: number | null;
  chats_done: number | null;
  messages_imported: number | null;
}

interface ImportChatRow {
  chat_id: string;
  name: string | null;
  attempts: number | null;
  next_limit: number | null;
}

/** Stops the tick; the message is recorded on the job. */
class StopTick extends Error {}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 500);
}

/** A slow or failing gateway read, worth a smaller retry. */
function isRetryableRead(err: unknown): boolean {
  return err instanceof OpenWAError && err.status >= 500;
}

/** The gateway cannot serve this number now: stop, don't count attempts. */
function isNumberUnavailable(err: unknown): boolean {
  return (
    err instanceof OpenWAError &&
    (err.isAuthError ||
      err.isSessionNotFound ||
      err.status === 400 ||
      err.status === 409 ||
      err.isPacingLimited)
  );
}

/**
 * Enqueue a job for every linked personal OpenWA number that has none
 * yet; returns how many rows the enqueue offered.
 */
async function enqueue(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin
    .from('whatsapp_config')
    .select('id, account_id, user_id')
    .eq('is_personal', true)
    .eq('provider', 'openwa')
    .eq('status', 'connected')
    .not('connected_at', 'is', null);
  if (error) throw new StopTick(`enqueue: ${error.message}`);
  const rows = (
    (data ?? []) as Array<{
      id: string;
      account_id: string;
      user_id: string | null;
    }>
  )
    .filter((r) => r.user_id)
    .map((r) => ({
      config_id: r.id,
      account_id: r.account_id,
      user_id: r.user_id,
      status: 'queued',
    }));
  if (rows.length === 0) return 0;
  const { error: insertError } = await admin
    .from('personal_history_imports')
    .upsert(rows, { onConflict: 'config_id', ignoreDuplicates: true });
  if (insertError) throw new StopTick(`enqueue: ${insertError.message}`);
  return rows.length;
}

/**
 * One tick of the import: enqueue new personal numbers, claim one job,
 * and work it until `budgetMs` is spent. Never throws; a failure is
 * logged and recorded on the job's `last_error`, and the lease is
 * always released.
 */
export async function runPersonalHistoryImportTick(
  admin: SupabaseClient,
  opts: PersonalHistoryImportTickOptions
): Promise<PersonalHistoryImportTickResult> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pauseMs = opts.pauseMs ?? 1_000;
  const deadline = now() + opts.budgetMs;
  const result: PersonalHistoryImportTickResult = {
    enqueued: 0,
    configId: null,
    status: null,
    chatsDone: 0,
    messagesImported: 0,
  };

  try {
    result.enqueued = await enqueue(admin);
  } catch (err) {
    // A failed enqueue still lets an existing job progress.
    console.error('[history-import] enqueue failed:', errorText(err));
  }

  let job: ImportRow;
  try {
    const { data, error } = await admin.rpc('claim_personal_history_import', {
      p_lease_seconds: Math.ceil(opts.budgetMs / 1000) + 30,
    });
    if (error) throw new Error(error.message);
    const claimed = (Array.isArray(data) ? data[0] : data) as
      ImportRow | null | undefined;
    if (!claimed) return result;
    job = claimed;
  } catch (err) {
    console.error('[history-import] claim failed:', errorText(err));
    return result;
  }

  result.configId = job.config_id;
  const state = {
    status: job.status,
    chatsTotal: job.chats_total ?? 0,
    chatsDone: job.chats_done ?? 0,
    messagesImported: job.messages_imported ?? 0,
    lastError: undefined as string | null | undefined,
    finishedAt: undefined as string | undefined,
  };

  try {
    await work(admin, job, state, { now, deadline, sleep, pauseMs, result });
  } catch (err) {
    state.lastError = errorText(err);
    console.error(
      '[history-import] job',
      job.config_id,
      'stopped:',
      state.lastError
    );
  }

  // Always release the lease, with whatever progress was made.
  const patch: Record<string, unknown> = {
    status: state.status,
    chats_total: state.chatsTotal,
    chats_done: state.chatsDone,
    messages_imported: state.messagesImported,
    lease_until: null,
    updated_at: new Date(now()).toISOString(),
  };
  if (state.lastError !== undefined) patch.last_error = state.lastError;
  if (state.finishedAt) patch.finished_at = state.finishedAt;
  const { error: releaseError } = await admin
    .from('personal_history_imports')
    .update(patch)
    .eq('config_id', job.config_id);
  if (releaseError) {
    console.error(
      '[history-import] release failed:',
      job.config_id,
      releaseError.message
    );
  }

  result.status = state.status;
  return result;
}

interface JobState {
  status: string;
  chatsTotal: number;
  chatsDone: number;
  messagesImported: number;
  lastError: string | null | undefined;
  finishedAt: string | undefined;
}

interface WorkCtx {
  now: () => number;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
  pauseMs: number;
  result: PersonalHistoryImportTickResult;
}

async function work(
  admin: SupabaseClient,
  job: ImportRow,
  state: JobState,
  ctx: WorkCtx
): Promise<void> {
  const { data: row, error } = await admin
    .from('whatsapp_config')
    .select(`${CHANNEL_COLUMNS}, connected_at`)
    .eq('id', job.config_id)
    .maybeSingle();
  if (error) throw new StopTick(`config: ${error.message}`);
  // Deleted between claim and now: the cascade takes the job with it.
  if (!row) return;
  const channel = toChannel(row as unknown as ChannelRow);
  if (
    !channel.isPersonal ||
    channel.provider !== 'openwa' ||
    channel.status !== 'connected'
  ) {
    state.status = 'paused';
    return;
  }

  // A paused job lists again: listing is idempotent and cheap.
  if (
    state.status === 'queued' ||
    state.status === 'listing' ||
    state.status === 'paused'
  ) {
    state.status = 'listing';
    await listInto(admin, job, channel, state);
    state.status = 'running';
  }

  const ownerId = channel.personalUserId ?? job.user_id;
  const ownPhone = normalizePhone(channel.wabaId ?? '');
  let first = true;

  for (;;) {
    const { data: pending, error: pendingError } = await admin
      .from('personal_history_import_chats')
      .select('chat_id, name, attempts, next_limit')
      .eq('config_id', job.config_id)
      .eq('status', 'pending')
      .order('chat_ts', { ascending: false, nullsFirst: false })
      .limit(PENDING_PAGE);
    if (pendingError) throw new StopTick(`chats: ${pendingError.message}`);
    const chats = (pending ?? []) as ImportChatRow[];
    if (chats.length === 0) {
      state.status = 'done';
      state.lastError = null;
      state.finishedAt = new Date(ctx.now()).toISOString();
      return;
    }
    for (const chat of chats) {
      const remaining = ctx.deadline - ctx.now();
      if (remaining < MIN_READ_MS) return;
      if (!first && ctx.pauseMs > 0) await ctx.sleep(ctx.pauseMs);
      first = false;
      const left = ctx.deadline - ctx.now();
      if (left < MIN_READ_MS) return;
      await importChat(admin, job, channel, chat, state, ctx, {
        ownerId,
        ownPhone,
        timeoutMs: Math.min(left - READ_MARGIN_MS, MAX_READ_MS),
      });
    }
  }
}

/** Page the phone's chats into `personal_history_import_chats`. */
async function listInto(
  admin: SupabaseClient,
  job: ImportRow,
  channel: WhatsAppChannel,
  state: JobState
): Promise<void> {
  let total = 0;
  for (let page = 0; page < MAX_CHAT_PAGES; page++) {
    let chats: OpenWAChatSummary[];
    try {
      chats = await listChats({
        apiKey: channel.accessToken,
        sessionId: channel.phoneNumberId,
        limit: CHAT_PAGE,
        offset: page * CHAT_PAGE,
      });
    } catch (err) {
      throw new StopTick(`list chats: ${errorText(err)}`);
    }
    const rows = chats.filter(isImportableChat).map((c) => ({
      config_id: job.config_id,
      chat_id: c.id,
      name: c.name,
      chat_ts:
        c.timestamp !== null
          ? new Date(c.timestamp * 1000).toISOString()
          : null,
      status: 'pending',
    }));
    if (rows.length > 0) {
      const { error } = await admin
        .from('personal_history_import_chats')
        .upsert(rows, {
          onConflict: 'config_id,chat_id',
          ignoreDuplicates: true,
        });
      if (error) throw new StopTick(`save chats: ${error.message}`);
    }
    total += rows.length;
    if (chats.length < CHAT_PAGE) break;
  }
  state.chatsTotal = total;
}

async function updateChat(
  admin: SupabaseClient,
  configId: string,
  chatId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await admin
    .from('personal_history_import_chats')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('config_id', configId)
    .eq('chat_id', chatId);
  if (error) throw new StopTick(`chat update: ${error.message}`);
}

/** The phone digits behind a chat id, or null when unknown. */
async function resolveChatPhone(
  channel: WhatsAppChannel,
  chatId: string
): Promise<string | null> {
  if (chatId.endsWith('@c.us')) {
    return normalizePhone(chatId.split('@')[0]) || null;
  }
  const phone = await getContactPhone({
    apiKey: channel.accessToken,
    sessionId: channel.phoneNumberId,
    contactId: chatId,
  });
  return phone ? normalizePhone(phone) || null : null;
}

async function importChat(
  admin: SupabaseClient,
  job: ImportRow,
  channel: WhatsAppChannel,
  chat: ImportChatRow,
  state: JobState,
  ctx: WorkCtx,
  args: { ownerId: string; ownPhone: string; timeoutMs: number }
): Promise<void> {
  const limit = chat.next_limit ?? FIRST_LIMIT;
  try {
    const phone = await resolveChatPhone(channel, chat.chat_id);
    if (!phone || phone === args.ownPhone) {
      await updateChat(admin, job.config_id, chat.chat_id, {
        status: 'skipped',
        last_error: phone ? 'own number' : 'no phone number',
      });
      state.chatsDone++;
      return;
    }

    const history = await getChatHistory({
      apiKey: channel.accessToken,
      sessionId: channel.phoneNumberId,
      chatId: chat.chat_id,
      limit,
      deep: true,
      timeoutMs: args.timeoutMs,
    });
    const rows = history
      .map((m) =>
        historyMessageToRow(m, {
          ownerId: args.ownerId,
          channelId: channel.id,
        })
      )
      .filter((r): r is HistoryRow => r !== null);

    let imported = 0;
    if (rows.length > 0) {
      const contact = await findOrCreateContact(
        job.account_id,
        args.ownerId,
        phone,
        chat.name || phone,
        { rename: false }
      );
      if (!contact) throw new StopTick(`contact for ${chat.chat_id}`);
      const conv = await findOrCreatePersonalChat(
        admin,
        job.account_id,
        contact.contact.id,
        channel
      );
      if (!conv) throw new StopTick(`personal chat for ${chat.chat_id}`);
      for (let i = 0; i < rows.length; i += ROW_BATCH) {
        const { data, error } = await admin.rpc('import_history_rows', {
          p_conversation_id: conv.conversation.id,
          p_rows: rows.slice(i, i + ROW_BATCH),
        });
        if (error) throw new StopTick(`import rows: ${error.message}`);
        imported += typeof data === 'number' ? data : 0;
      }
    }

    await updateChat(admin, job.config_id, chat.chat_id, {
      status: 'done',
      messages_imported: imported,
      last_error: null,
    });
    state.chatsDone++;
    state.messagesImported += imported;
    ctx.result.chatsDone++;
    ctx.result.messagesImported += imported;
  } catch (err) {
    if (err instanceof StopTick || isNumberUnavailable(err)) throw err;
    const attempts = (chat.attempts ?? 0) + 1;
    const message = errorText(err);
    const giveUp =
      !isRetryableRead(err) || attempts >= MAX_ATTEMPTS || limit <= MIN_LIMIT;
    await updateChat(
      admin,
      job.config_id,
      chat.chat_id,
      giveUp
        ? { status: 'failed', attempts, last_error: message }
        : {
            attempts,
            next_limit: LIMIT_STEPS[limit] ?? MIN_LIMIT,
            last_error: message,
          }
    );
    if (giveUp) state.chatsDone++;
  }
}
