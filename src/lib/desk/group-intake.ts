/**
 * Files posted in a WhatsApp group linked to a bank (migration 324, the
 * "CC group wall" slice B), run through the case desk like a staff
 * member's own WhatsApp upload (route-inbound.ts), and optionally answered
 * in the group.
 *
 * Called from inbound-events.ts once the group row is stored and its media
 * copy has run (so `media.link` is ours when the number mirrors files).
 * Only an inbound file of a group whose link has intake on is looked at;
 * text is never recorded. The poster must be the one live staff member
 * with that saved number; the bytes are read only from this install's own
 * storage (`readDocumentBytes`), never from the gateway's link.
 *
 * The intake item id and idempotency key derive from the account and the
 * WhatsApp message id, so a redelivery, or a second number of ours in the
 * same group, submits the same item and the desk replays it.
 *
 * A reply goes out at most once per message: `claimReply` is the guard
 * (off -> pending once, only with replies on), the group's anti-ban budget
 * is checked after the claim, and a failed or skipped send settles
 * 'failed' and is never retried. A replayed item is not answered: the
 * first submission already was (or chose not to be).
 *
 * Never throws: it runs inside `after()` or the cron drain, and a throw
 * there would fail the event. Logs carry codes only, never a phone, a
 * caption or a link.
 */
import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readDocumentBytes,
  type CaseFilesStorage,
} from '@/lib/case-files/bytes';
import { CASE_FILE_MIME, normalizeMime } from '@/lib/case-files/checks';
import { GROUP_SEND_LIMIT } from '@/lib/groups/member-requests';
import { chatMediaPathOf } from '@/lib/groups/outbound-media';
import { checkRateLimit } from '@/lib/rate-limit';
import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { sendGroupText } from '@/lib/whatsapp/groups';

import {
  DeskGroupIntakeStore,
  type GroupIntakeOutcome,
  type GroupLink,
} from './group-intake-store';
import { groupReplyText, type GroupReply } from './group-intake-text';
import { mergeCaption } from './intake-form';
import {
  DeskRefusedError,
  DeskStore,
  DeskStoreError,
  type ItemResult,
  type ItemTags,
} from './store';
import { prepareIntakeFile, storeIntakeFile } from './upload';

type Admin = Pick<SupabaseClient, 'from' | 'rpc'> & {
  storage: CaseFilesStorage;
};

export interface GroupFileDeps {
  /** Service role. */
  admin: Admin;
  /** The number the message arrived on. */
  channel: { id: string; accountId: string };
  /** The same number, ready to send; a thunk because it decrypts. */
  loadChannel: () => WhatsAppChannel;
  groupStore?: DeskGroupIntakeStore;
  desk?: DeskStore;
}

/** The message as the gateway named it: persist answers counts only. */
export interface GroupFileRef {
  id: string;
  waGroupId: string;
}

/** Every type the media copy handles: a video is a file, and refused. */
const FILE_TYPES: readonly string[] = [
  'image',
  'sticker',
  'video',
  'audio',
  'document',
];

const EMPTY_TAGS: ItemTags = {
  kind: null,
  bankCode: null,
  caseRef: null,
  companyName: null,
  tradeLicence: null,
  product: null,
  contactId: null,
  docKey: null,
  note: null,
};

const DETAIL = /^[A-Za-z0-9_]{1,64}$/;

interface GroupRow {
  id: string;
  wa_group_id: string;
}

interface MessageRow {
  id: string;
  direction: string;
  sender_wa_id: string | null;
  type: string;
  body: string | null;
  media: Record<string, unknown> | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The intake item id (a UUID in the v5 layout, from a sha256) and the
 * idempotency key of one group message: the same for every delivery and
 * every number of the account that sees it.
 */
export function groupItemKeys(
  accountId: string,
  waMessageId: string
): { itemId: string; idemKey: string } {
  const hex = createHash('sha256')
    .update(`desk-group:${accountId}:${waMessageId}`)
    .digest('hex');
  const b = hex.slice(0, 32).split('');
  b[12] = '5';
  b[16] = ((parseInt(b[16], 16) & 0x3) | 0x8).toString(16);
  const u = b.join('');
  return {
    itemId: `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`,
    idemKey: `grp:${hex.slice(0, 40)}`,
  };
}

/** The sender's phone digits; a hidden number (`…@lid`) has none. */
export function senderDigits(senderWaId: string | null): string {
  if (!senderWaId || /@lid$/i.test(senderWaId)) return '';
  return senderWaId.replace(/@.*$/, '').replace(/\D/g, '');
}

function errorCode(err: unknown): string {
  if (err instanceof DeskRefusedError) return `${err.name} ${err.reason}`;
  if (err instanceof DeskStoreError)
    return `${err.name} ${err.fn} ${err.code ?? ''}`.trim();
  const e = err as { code?: unknown; name?: unknown } | null;
  return text(e?.code) ?? text(e?.name) ?? typeof err;
}

/**
 * The group's link. `desk_group_link_list` answers for an actor, and this
 * runs for nobody: it asks as one live owner or admin of the account (who
 * sees every group but a submission group's mirror). A read, nothing more.
 */
async function linkFor(
  admin: Admin,
  store: DeskGroupIntakeStore,
  accountId: string,
  groupId: string
): Promise<GroupLink | null> {
  const { data, error } = await admin
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin'])
    .is('deactivated_at', null)
    .limit(1);
  if (error) throw error;
  const actor = text((data as { user_id?: unknown }[] | null)?.[0]?.user_id);
  if (!actor) return null;
  const links = await store.listLinks(actor, accountId);
  return links.find((l) => l.groupId === groupId) ?? null;
}

function outcomeOf(
  result: ItemResult,
  tags: ItemTags
): { outcome: GroupIntakeOutcome; detail: string | null } {
  switch (result.state) {
    case 'filed':
      return {
        outcome: tags.kind === 'new_case' ? 'new_case' : 'filed',
        detail: null,
      };
    case 'untagged':
      return {
        outcome: 'queued',
        detail:
          result.queueReason && DETAIL.test(result.queueReason)
            ? result.queueReason
            : 'OTHER',
      };
    case 'duplicate':
      return { outcome: 'duplicate', detail: null };
    case 'rejected':
      return { outcome: 'refused', detail: 'REJECTED' };
    default: {
      const unknown: never = result.state;
      throw new Error(`Unknown item state: ${String(unknown)}`);
    }
  }
}

function replyFor(
  outcome: GroupIntakeOutcome,
  detail: string | null,
  result: ItemResult | null,
  tags: ItemTags,
  link: GroupLink
): GroupReply | null {
  switch (outcome) {
    case 'filed':
      return {
        kind: 'filed',
        caseNumber: result?.caseNumber ?? null,
        docKey: tags.docKey,
      };
    case 'new_case':
      return {
        kind: 'new_case',
        caseNumber: result?.caseNumber ?? null,
        captionCode: result?.captionCode ?? null,
      };
    case 'queued': {
      const bank = result?.queueBankCode ?? null;
      return {
        kind: 'queued',
        queueName:
          bank === null
            ? 'no-bank'
            : bank === link.bankCode
              ? link.bankName || bank
              : bank,
        reason: result?.queueReason ?? null,
      };
    }
    case 'duplicate':
      return { kind: 'duplicate' };
    case 'refused':
      return { kind: 'refused', code: detail };
    default:
      return null;
  }
}

/** Runs one group message through the desk. Never throws. */
export async function processGroupFile(
  deps: GroupFileDeps,
  ref: GroupFileRef
): Promise<void> {
  const seen: { rowId: string | null } = { rowId: null };
  try {
    await run(deps, ref, seen);
  } catch (err) {
    console.error(
      `[desk-group] intake failed for ${seen.rowId ?? 'unread'}: ${errorCode(err)}`
    );
  }
}

async function run(
  deps: GroupFileDeps,
  ref: GroupFileRef,
  seen: { rowId: string | null }
): Promise<void> {
  const { admin, channel } = deps;
  const accountId = channel.accountId;
  const store =
    deps.groupStore ??
    new DeskGroupIntakeStore(admin as unknown as SupabaseClient);
  const desk = deps.desk ?? new DeskStore(admin as unknown as SupabaseClient);

  // Under this number's group row, as the media copy reads it. A
  // submission group has no such row (persistGroupMessages skips it), and
  // its hidden mirror is never linked.
  const group = await admin
    .from('whatsapp_groups')
    .select('id, wa_group_id')
    .eq('account_id', accountId)
    .eq('channel_id', channel.id)
    .eq('wa_group_id', ref.waGroupId)
    .maybeSingle();
  if (group.error) throw group.error;
  const g = group.data as GroupRow | null;
  if (!g) return;
  const found = await admin
    .from('whatsapp_group_messages')
    .select('id, direction, sender_wa_id, type, body, media')
    .eq('account_id', accountId)
    .eq('group_id', g.id)
    .eq('wa_message_id', ref.id)
    .maybeSingle();
  if (found.error) throw found.error;
  const row = found.data as MessageRow | null;
  if (!row || row.direction !== 'in') return;
  seen.rowId = row.id;
  if (!FILE_TYPES.includes(row.type) || !row.media) return;

  const link = await linkFor(admin, store, accountId, g.id);
  if (!link || !link.intakeEnabled) return;

  const record = (
    outcome: GroupIntakeOutcome,
    intakeItemId: string | null,
    detail: string | null
  ) =>
    store.record(accountId, {
      groupMessageId: row.id,
      outcome,
      intakeItemId,
      detail,
    });

  const digits = senderDigits(row.sender_wa_id);
  const staff = digits ? await store.staffForPhone(accountId, digits) : null;
  if (!staff) {
    await record('unknown_sender', null, null);
    return;
  }

  // Ours only: a Whapi number without mirroring keeps Whapi's link, which
  // the server never fetches.
  const mediaUrl = text(row.media.link);
  if (
    !mediaUrl ||
    !(chatMediaPathOf(mediaUrl)?.startsWith(`account-${accountId}/`) ?? false)
  ) {
    await record('no_copy', null, null);
    return;
  }
  // Refused before the download: a video is never read only to be refused.
  const mime = normalizeMime(text(row.media.mime_type) ?? '');
  if (!(CASE_FILE_MIME as readonly string[]).includes(mime)) {
    await record('file_type', null, 'FILE_INVALID');
    return;
  }
  const bytes = await readDocumentBytes(
    { mediaUrl, storageBucket: null, storagePath: null },
    { storage: admin.storage }
  );
  if (!bytes) {
    await record('no_copy', null, 'READ_FAILED');
    return;
  }

  const { itemId, idemKey } = groupItemKeys(accountId, ref.id);
  let file;
  try {
    file = prepareIntakeFile(itemId, {
      bytes,
      mime,
      originalName: text(row.media.filename) ?? 'whatsapp-group-document',
    });
  } catch (err) {
    if (!(err instanceof DeskRefusedError)) throw err;
    await record('file_type', null, err.reason);
    return;
  }
  await storeIntakeFile(admin.storage, file, bytes);

  const merged = mergeCaption(EMPTY_TAGS, row.body);
  const tags = { ...merged.tags };
  if (merged.deskCode && tags.bankCode === null)
    tags.bankCode = await desk.bankByShortCode(accountId, merged.deskCode);
  if (tags.bankCode === null) tags.bankCode = link.bankCode;

  let result: ItemResult | null = null;
  let outcome: GroupIntakeOutcome;
  let detail: string | null;
  try {
    result = await desk.whatsappIntake(staff, accountId, {
      itemId,
      idemKey,
      tags,
      file,
    });
    ({ outcome, detail } = outcomeOf(result, tags));
  } catch (err) {
    if (!(err instanceof DeskRefusedError)) throw err;
    outcome = 'refused';
    detail = err.reason;
  }
  const stored = await record(outcome, result?.itemId ?? null, detail);
  // Another run's outcome won, or this is a replay: that run answers.
  if (stored !== outcome || result?.replayed) return;

  const reply = replyFor(outcome, detail, result, tags, link);
  if (!reply) return;
  if (!(await store.claimReply(accountId, row.id))) return;
  await sendReply(deps, store, g, row.id, ref.id, groupReplyText(reply));
}

/** After a won claim: budget, send, record our row, settle. */
async function sendReply(
  deps: GroupFileDeps,
  store: DeskGroupIntakeStore,
  group: GroupRow,
  rowId: string,
  quotedMessageId: string,
  body: string
): Promise<void> {
  const { admin, channel } = deps;
  const accountId = channel.accountId;
  const settleFailed = () => store.settleReply(accountId, rowId, false, null);

  const since = new Date(Date.now() - GROUP_SEND_LIMIT.windowMs).toISOString();
  const { count, error } = await admin
    .from('whatsapp_group_messages')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('group_id', group.id)
    .eq('direction', 'out')
    .gte('created_at', since);
  if (error) {
    await settleFailed();
    return;
  }
  // The same key as the staff send route: one budget per group.
  const attempts = checkRateLimit(`group-send:${group.id}`, {
    limit: GROUP_SEND_LIMIT.perWindow,
    windowMs: GROUP_SEND_LIMIT.windowMs,
  });
  if ((count ?? 0) >= GROUP_SEND_LIMIT.perWindow || !attempts.success) {
    await settleFailed();
    return;
  }

  let sent: { messageId: string };
  try {
    sent = await sendGroupText({
      channel: deps.loadChannel(),
      groupId: group.wa_group_id,
      text: body,
      quotedMessageId,
    });
  } catch (err) {
    console.warn(`[desk-group] reply failed for ${rowId}: ${errorCode(err)}`);
    await settleFailed();
    return;
  }

  const { error: insertError } = await admin
    .from('whatsapp_group_messages')
    .upsert(
      {
        account_id: accountId,
        group_id: group.id,
        wa_message_id: sent.messageId,
        direction: 'out',
        sender_user_id: null,
        sender_name: null,
        type: 'text',
        body,
        status: 'sent',
      },
      { onConflict: 'group_id,wa_message_id', ignoreDuplicates: true }
    );
  // The reply went out; failing here would invite a resend.
  if (insertError)
    console.error(`[desk-group] reply not recorded for ${rowId}`);
  await store.settleReply(accountId, rowId, true, sent.messageId);
}
