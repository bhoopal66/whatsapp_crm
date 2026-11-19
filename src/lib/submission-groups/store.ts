/**
 * Submission Groups store (migration 115): thin wrappers over the `sg_*`
 * RPCs on a service-role client. Every permission is decided in Postgres
 * (the RPCs and the table triggers); this file only maps rows to camelCase.
 * Every method throws on a database error.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { GroupStatus, StaffLabel } from './rules';

/** 136: whether a WhatsApp group exists (or will) for a submission. */
export type WaMode = 'group' | 'none';

/** 174: whether the customer is in the WhatsApp group; 'unknown' = we can't tell yet. */
export type CustomerMembership = 'unknown' | 'joined' | 'absent';
/**
 * What may be reported to `sg_note_customer_membership`. 'unsure' is never
 * stored: the list was read and holds a hidden number, so a stored 'absent'
 * falls back to 'unknown'. 'unknown' only stamps the check.
 */
export type CustomerMembershipNote = CustomerMembership | 'unsure';

export interface SubmissionGroup {
  id: string;
  accountId: string;
  submissionRef: string;
  /** NULL once the contact is deleted (115's ON DELETE SET NULL). */
  contactId: string | null;
  /** The Whapi `whatsapp_config` row hosting the group; frozen, NULL once the number is removed (always NULL for `waMode: 'none'`). */
  channelId: string | null;
  /** 'none': the CRM record of a submission with no WhatsApp group, ever (136). Frozen. */
  waMode: WaMode;
  subject: string;
  /** 141: the company the submission tracker sent as customer.name; display only, NULL = not sent. Optional so fixtures predating 141 still type-check; toGroup always sets it. */
  customerName?: string | null;
  coordinatorPhone: string | null;
  /** 142: the bank's coordinators' WhatsApp numbers (digits) added at creation, with the request's coordinator_phone. Optional so older fixtures still type-check; toGroup always sets it. */
  coordinatorPhones?: string[];
  status: GroupStatus;
  waGroupId: string | null;
  inviteLink: string | null;
  submissionStatus: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  waCreateError: string | null;
  waClosedAt: Date | null;
  waCloseError: string | null;
  /** When the invite link last went out 1:1 to a customer WhatsApp refused to add (118). */
  inviteSentAt: Date | null;
  /** Why the last 1:1 invite send failed; cleared by a later success. */
  inviteSendError: string | null;
  /** 174. Optional so older fixtures still type-check; toGroup always sets it. */
  customerMembership?: CustomerMembership;
  /** 174: when membership was last checked; NULL = never. Optional like customerMembership. */
  customerCheckedAt?: Date | null;
}

/** 'out' rows only (null for 'in'). Only "sent" reached the customer. */
export type SendStatus = 'pending' | 'sent' | 'blocked' | 'failed';
export type SenderKind = 'customer' | 'coordinator' | 'other';

export interface GroupMessage {
  id: string;
  direction: 'in' | 'out';
  senderUserId: string | null;
  senderWaId: string | null;
  senderKind: SenderKind | null;
  type: string;
  body: string | null;
  prefixedBody: string | null;
  media: unknown;
  waMessageId: string | null;
  sendStatus: SendStatus | null;
  /** 'in' only: arrived after the group ended (hidden live, shown in the archive). */
  postEnd: boolean;
  createdAt: Date;
  waTimestamp: Date | null;
  /** 170: an automatic message (no sender_user_id); null = a person's or the customer's. Optional so fixtures predating 170 still type-check; toMessage always sets it. sg_read_archive does not return it. */
  systemKind?: SystemKind | null;
}

/** 210: the stored type of a staff attachment (sg_send_begin_media's allowed list). */
export type SgMediaType = 'image' | 'video' | 'document' | 'audio';

/** 210: `submission_group_messages.media` of a staff attachment; `path` is the chat-media object. */
export interface SgOutMedia {
  link: string;
  mime_type: string | null;
  filename: string | null;
  path: string;
}

/** 170: the kinds of automatic message sg_send_begin_system writes. */
export type SystemKind = 'welcome' | 'status_update';

/** sg_send_begin_system's answer: a new pending row, the row an earlier call with the same key wrote, or a refusal (nothing stored). */
export type SystemSendBegin =
  | { id: string }
  | { refused: 'DUPLICATE'; id: string; sendStatus: SendStatus | null }
  | { refused: SystemSendRefusal };

export type SystemSendRefusal =
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'NO_WHATSAPP_GROUP'
  | 'GROUP_NOT_READY'
  | 'NUMBER_REMOVED'
  | 'CONTACT_REMOVED'
  | 'WA_CLOSED'
  | 'ENDED';

export type ArchiveResult =
  { allowed: false } | { allowed: true; messages: GroupMessage[] };

export interface ConsentAnswer {
  allowed: boolean;
  phone: string | null;
  reason?: 'opted_out' | 'do_not_contact';
}

export const GROUP_COLUMNS =
  'id, account_id, submission_ref, contact_id, channel_id, subject, coordinator_phone, status, wa_group_id, invite_link, submission_status, created_at, last_activity_at, ended_at, end_reason, wa_create_error, wa_closed_at, wa_close_error, invite_sent_at, invite_send_error, wa_mode, customer_name, coordinator_phones, customer_membership, customer_checked_at';

type Row = Record<string, unknown>;

/** Pending 'out' rows an echo reconcile scans; a full page is treated as ambiguous. */
export const PENDING_OUT_SCAN = 50;
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(String(v));

export function toGroup(r: Row): SubmissionGroup {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    submissionRef: String(r.submission_ref),
    contactId: str(r.contact_id),
    channelId: str(r.channel_id),
    // Anything but 'none' is a 'group' row. GROUP_COLUMNS selects wa_mode, so
    // this code needs migration 136 applied first (PostgREST refuses the column).
    waMode: r.wa_mode === 'none' ? 'none' : 'group',
    subject: String(r.subject ?? ''),
    customerName: str(r.customer_name)?.trim() || null,
    coordinatorPhone: str(r.coordinator_phone),
    coordinatorPhones: Array.isArray(r.coordinator_phones)
      ? r.coordinator_phones.map(String)
      : [],
    status: r.status as GroupStatus,
    waGroupId: str(r.wa_group_id),
    inviteLink: str(r.invite_link),
    submissionStatus: str(r.submission_status),
    createdAt: date(r.created_at)!,
    lastActivityAt: date(r.last_activity_at)!,
    endedAt: date(r.ended_at),
    endReason: str(r.end_reason),
    waCreateError: str(r.wa_create_error),
    waClosedAt: date(r.wa_closed_at),
    waCloseError: str(r.wa_close_error),
    inviteSentAt: date(r.invite_sent_at),
    inviteSendError: str(r.invite_send_error),
    customerMembership:
      r.customer_membership === 'joined' || r.customer_membership === 'absent'
        ? r.customer_membership
        : 'unknown',
    customerCheckedAt: date(r.customer_checked_at),
  };
}

export function toMessage(m: Row): GroupMessage {
  return {
    id: String(m.id),
    direction: m.direction as 'in' | 'out',
    senderUserId: str(m.sender_user_id),
    senderWaId: str(m.sender_wa_id),
    senderKind: (m.sender_kind as SenderKind | null) ?? null,
    type: String(m.type ?? 'text'),
    body: str(m.body),
    prefixedBody: str(m.prefixed_body),
    media: m.media ?? null,
    waMessageId: str(m.wa_message_id),
    sendStatus: (m.send_status as SendStatus | null) ?? null,
    postEnd: m.post_end === true,
    createdAt: date(m.created_at)!,
    waTimestamp: date(m.wa_timestamp),
    systemKind:
      m.system_kind === 'welcome' || m.system_kind === 'status_update'
        ? m.system_kind
        : null,
  };
}

/** A `setof bigint` comes back as numbers or as one-key objects. */
const scalarIds = (data: unknown): string[] =>
  Array.isArray(data)
    ? data.map((x) =>
        String(x !== null && typeof x === 'object' ? Object.values(x)[0] : x)
      )
    : [];

/** A failed `sg_*` RPC; `code` is the Postgres SQLSTATE (e.g. 55000: group not ACTIVE). */
export class SubmissionGroupDbError extends Error {
  override readonly name = 'SubmissionGroupDbError';
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
  }
}

export class SubmissionGroupStore {
  constructor(private readonly db: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error)
      throw new SubmissionGroupDbError(
        `${fn}: ${error.message}`,
        error.code ?? null
      );
    return data as T;
  }

  /**
   * Idempotent per (account, ref); an existing group is returned unchanged (its mode included). `waMode: 'none'`
   * takes `channelId: null` (136's guard refuses a number on such a row).
   */
  async open(input: {
    accountId: string;
    submissionRef: string;
    contactId: string;
    channelId: string | null;
    waMode?: WaMode;
    subject: string;
    coordinatorPhone: string | null;
    /** 142: every coordinator number (digits) to add to the WhatsApp group; default none. */
    coordinatorPhones?: readonly string[];
    access: readonly { userId: string; label: StaffLabel }[];
    keyId: string | null;
    /** 141: the request's customer.name, kept on the group for display; the contact is not renamed. */
    customerName: string | null;
  }): Promise<{ groupId: string; created: boolean }> {
    const data = await this.rpc<Row[] | Row>('sg_open', {
      p_account: input.accountId,
      p_submission_ref: input.submissionRef,
      p_contact: input.contactId,
      p_channel: input.channelId,
      p_subject: input.subject,
      p_coordinator_phone: input.coordinatorPhone,
      p_access: input.access.map((a) => ({
        user_id: a.userId,
        label: a.label,
      })),
      p_key: input.keyId,
      p_wa_mode: input.waMode ?? 'group',
      p_customer_name: input.customerName,
      p_coordinator_phones: [...(input.coordinatorPhones ?? [])],
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('sg_open returned no row');
    return { groupId: String(row.group_id), created: row.created === true };
  }

  async get(groupId: string): Promise<SubmissionGroup | null> {
    const { data, error } = await this.db
      .from('submission_groups')
      .select(GROUP_COLUMNS)
      .eq('id', groupId)
      .maybeSingle();
    if (error) throw new Error(`submission_groups: ${error.message}`);
    return data ? toGroup(data as Row) : null;
  }

  async findByRef(
    accountId: string,
    submissionRef: string
  ): Promise<SubmissionGroup | null> {
    const { data, error } = await this.db
      .from('submission_groups')
      .select(GROUP_COLUMNS)
      .eq('account_id', accountId)
      .eq('submission_ref', submissionRef)
      .maybeSingle();
    if (error) throw new Error(`submission_groups: ${error.message}`);
    return data ? toGroup(data as Row) : null;
  }

  /** Inbound routing: the group a `@g.us` id belongs to on this account's number. */
  async findByWaGroupId(
    accountId: string,
    channelId: string,
    waGroupId: string
  ): Promise<SubmissionGroup | null> {
    const { data, error } = await this.db
      .from('submission_groups')
      .select(GROUP_COLUMNS)
      .eq('account_id', accountId)
      .eq('channel_id', channelId)
      .eq('wa_group_id', waGroupId)
      .maybeSingle();
    if (error) throw new Error(`submission_groups: ${error.message}`);
    return data ? toGroup(data as Row) : null;
  }

  /**
   * ACTIVE groups still without a WhatsApp group, created before `before` (the cron's retry list). Pass
   * `accountId` whenever a per-account Whapi adapter will act on the rows; without it every account's are listed.
   */
  async listPendingCreates(
    before: Date,
    opts: { accountId?: string; limit?: number } = {}
  ): Promise<SubmissionGroup[]> {
    let q = this.db
      .from('submission_groups')
      .select(GROUP_COLUMNS)
      .eq('status', 'ACTIVE')
      .is('wa_group_id', null)
      .not('channel_id', 'is', null)
      .eq('wa_mode', 'group')
      .lt('created_at', before.toISOString());
    if (opts.accountId) q = q.eq('account_id', opts.accountId);
    const { data, error } = await q
      .order('created_at', { ascending: true })
      .limit(opts.limit ?? 50);
    if (error) throw new Error(`submission_groups: ${error.message}`);
    return ((data ?? []) as Row[]).map(toGroup);
  }

  /** ENDED groups with a WhatsApp group whose close is not recorded yet (the cron's close retry list). */
  async listUnclosedEnded(
    opts: { accountId?: string; limit?: number } = {}
  ): Promise<SubmissionGroup[]> {
    let q = this.db
      .from('submission_groups')
      .select(GROUP_COLUMNS)
      .eq('status', 'ENDED')
      .not('wa_group_id', 'is', null)
      .not('channel_id', 'is', null)
      .eq('wa_mode', 'group')
      .is('wa_closed_at', null);
    if (opts.accountId) q = q.eq('account_id', opts.accountId);
    const { data, error } = await q
      .order('ended_at', { ascending: true })
      .limit(opts.limit ?? 50);
    if (error) throw new Error(`submission_groups: ${error.message}`);
    return ((data ?? []) as Row[]).map(toGroup);
  }

  /** The access list as it stands: the open rows, or on an ENDED group the rows closed at the end. */
  async listAccess(
    group: Pick<SubmissionGroup, 'id' | 'status' | 'endedAt'>
  ): Promise<{ userId: string; label: StaffLabel; addedAt: Date }[]> {
    const { data, error } = await this.db
      .from('submission_group_access')
      .select('user_id, label, removed_at, added_at')
      .eq('group_id', group.id)
      .order('added_at', { ascending: true });
    if (error) throw new Error(`submission_group_access: ${error.message}`);
    const endedAt = group.endedAt?.getTime() ?? null;
    return ((data ?? []) as Row[])
      .filter((r) =>
        group.status === 'ACTIVE' || endedAt === null
          ? r.removed_at === null
          : r.removed_at !== null &&
            new Date(String(r.removed_at)).getTime() === endedAt
      )
      .map((r) => ({
        userId: String(r.user_id),
        label: r.label as StaffLabel,
        addedAt: date(r.added_at)!,
      }));
  }

  /**
   * The caller's open access label (the prefix label), or null when not on
   * the list. With no open row, on an ACTIVE group a leader of the case's
   * agent is 'team_lead' (173) and a holder of its bank 'coordinator' (163).
   * sg_resolve_role decides both: it answers owner/admin first, so calling
   * sg_leads_group_agent here would label an admin who leads a team.
   */
  async openAccessLabel(
    groupId: string,
    userId: string
  ): Promise<StaffLabel | null> {
    const { data, error } = await this.db
      .from('submission_group_access')
      .select('label')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .is('removed_at', null)
      .maybeSingle();
    if (error) throw new Error(`submission_group_access: ${error.message}`);
    const label = (data as Row | null)?.label as StaffLabel | undefined;
    if (label) return label;
    const role = await this.resolveRole(groupId, userId);
    return role === 'team_lead' || role === 'coordinator' ? role : null;
  }

  async resolveRole(groupId: string, userId: string): Promise<string | null> {
    return str(
      await this.rpc('sg_resolve_role', { p_group: groupId, p_user: userId })
    );
  }

  async canRead(
    groupId: string,
    userId: string,
    opts: { now?: Date; windowDays?: number } = {}
  ): Promise<boolean> {
    return (
      (await this.rpc('sg_can_read', {
        p_group: groupId,
        p_user: userId,
        p_now: opts.now?.toISOString() ?? null,
        ...(opts.windowDays !== undefined
          ? { p_window_days: opts.windowDays }
          : {}),
      })) === true
    );
  }

  async canSend(groupId: string, userId: string): Promise<boolean> {
    return (
      (await this.rpc('sg_can_send', { p_group: groupId, p_user: userId })) ===
      true
    );
  }

  /** Claim token, or null (held by another caller, complete, or not ACTIVE). */
  async claimCreate(
    groupId: string,
    leaseMs: number,
    now?: Date
  ): Promise<string | null> {
    return str(
      await this.rpc('sg_claim_create', {
        p_group: groupId,
        p_lease_ms: leaseMs,
        p_now: now?.toISOString() ?? null,
      })
    );
  }

  async releaseCreateClaim(
    groupId: string,
    token: string,
    error: string | null = null
  ): Promise<boolean> {
    return (
      (await this.rpc('sg_release_create_claim', {
        p_group: groupId,
        p_token: token,
        p_error: error,
      })) === true
    );
  }

  async attachWaGroup(
    groupId: string,
    waGroupId: string,
    inviteLink: string | null,
    token: string
  ): Promise<boolean> {
    return (
      (await this.rpc('sg_attach_wa_group', {
        p_group: groupId,
        p_wa_group_id: waGroupId,
        p_invite_link: inviteLink,
        p_token: token,
      })) === true
    );
  }

  /** Writes the 'out' row as pending; null = refused (nothing may be sent). */
  async beginSend(
    groupId: string,
    userId: string,
    body: string,
    prefixed: string
  ): Promise<string | null> {
    return str(
      await this.rpc('sg_send_begin', {
        p_group: groupId,
        p_user: userId,
        p_body: body,
        p_prefixed: prefixed,
      })
    );
  }

  /**
   * 210: a staff attachment's 'out' row, pending; null = refused exactly like
   * beginSend. `type` is the stored message type (a voice note is 'audio');
   * a bad type or a media object without an https `link` raises 22023.
   */
  async beginMediaSend(
    groupId: string,
    userId: string,
    type: SgMediaType,
    body: string,
    prefixed: string,
    media: SgOutMedia
  ): Promise<string | null> {
    return str(
      await this.rpc('sg_send_begin_media', {
        p_group: groupId,
        p_user: userId,
        p_type: type,
        p_body: body,
        p_prefixed: prefixed,
        p_media: media,
      })
    );
  }

  /** 170: writes an automatic 'out' row as pending, at most once per (group, key). Only an `{ id }` answer may be sent. */
  async beginSystemSend(
    groupId: string,
    kind: SystemKind,
    key: string,
    body: string
  ): Promise<SystemSendBegin> {
    const r = (await this.rpc('sg_send_begin_system', {
      p_group: groupId,
      p_kind: kind,
      p_key: key,
      p_body: body,
    })) as Row | null;
    if (!r || typeof r !== 'object')
      throw new SubmissionGroupDbError('sg_send_begin_system: no answer', null);
    if (r.refused === undefined || r.refused === null)
      return { id: String(r.id) };
    if (r.refused === 'DUPLICATE')
      return {
        refused: 'DUPLICATE',
        id: String(r.id),
        sendStatus: (r.send_status as SendStatus | null) ?? null,
      };
    return { refused: String(r.refused) as SystemSendRefusal };
  }

  /** 170: when the WhatsApp close of an ENDED group may happen (ended_at + 2 days after a final status); null = no hold. */
  async closeHoldUntil(groupId: string): Promise<Date | null> {
    return date(await this.rpc('sg_close_hold_until', { p_group: groupId }));
  }

  /** Settles a pending 'out' row once; false if it was not pending. */
  async settleSend(
    messageId: string,
    status: Exclude<SendStatus, 'pending'>,
    waMessageId: string | null = null
  ): Promise<boolean> {
    return (
      (await this.rpc('sg_settle_send', {
        p_message: messageId,
        p_status: status,
        p_wa_message_id: waMessageId,
      })) === true
    );
  }

  /** Echo reconcile: does any row of the group already carry this WhatsApp message id? */
  async hasWaMessage(groupId: string, waMessageId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('submission_group_messages')
      .select('id')
      .eq('group_id', groupId)
      .eq('wa_message_id', waMessageId)
      .limit(1);
    if (error) throw new Error(`submission_group_messages: ${error.message}`);
    return ((data ?? []) as Row[]).length > 0;
  }

  /**
   * Echo reconcile: up to two ids of the group's pending 'out' rows created
   * in [`since`, `until`] whose prefixed body is exactly `prefixedBody`
   * (`until` null = no upper bound). The caller settles only a sole match:
   * the same sender resending the same text makes identical candidates,
   * and the echo cannot say which send it is. The body is compared here,
   * not in the query string, so a long text never lengthens the URL; a
   * group has only a handful of pending rows, and a full page answers no
   * match because a twin past it cannot be ruled out.
   */
  async pendingOutMatching(
    groupId: string,
    prefixedBody: string,
    since: Date,
    until: Date | null
  ): Promise<string[]> {
    let q = this.db
      .from('submission_group_messages')
      .select('id, prefixed_body')
      .eq('group_id', groupId)
      .eq('direction', 'out')
      .eq('send_status', 'pending')
      .gte('created_at', since.toISOString());
    if (until) q = q.lte('created_at', until.toISOString());
    const { data, error } = await q
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PENDING_OUT_SCAN);
    if (error) throw new Error(`submission_group_messages: ${error.message}`);
    const rows = (data ?? []) as Row[];
    if (rows.length >= PENDING_OUT_SCAN) return [];
    return rows
      .filter((r) => r.prefixed_body === prefixedBody)
      .slice(0, 2)
      .map((r) => String(r.id));
  }

  /** A message's send state; null if there is no such row. */
  async sendState(messageId: string): Promise<{
    sendStatus: SendStatus | null;
    waMessageId: string | null;
  } | null> {
    const { data, error } = await this.db
      .from('submission_group_messages')
      .select('send_status, wa_message_id')
      .eq('id', messageId)
      .maybeSingle();
    if (error) throw new Error(`submission_group_messages: ${error.message}`);
    const row = data as Row | null;
    if (!row) return null;
    return {
      sendStatus: (row.send_status as SendStatus | null) ?? null,
      waMessageId: str(row.wa_message_id),
    };
  }

  /** False = duplicate (already recorded). */
  async recordInbound(input: {
    groupId: string;
    waMessageId: string;
    senderWaId: string | null;
    senderKind: SenderKind;
    type: string;
    body: string | null;
    media: unknown;
    waTimestamp: Date | null;
  }): Promise<boolean> {
    return (
      (await this.rpc('sg_record_inbound', {
        p_group: input.groupId,
        p_wa_message_id: input.waMessageId,
        p_sender_wa_id: input.senderWaId,
        p_sender_kind: input.senderKind,
        p_type: input.type,
        p_body: input.body,
        p_media: input.media ?? null,
        p_wa_timestamp: input.waTimestamp?.toISOString() ?? null,
      })) === true
    );
  }

  /**
   * The bigint id of an inbound row, read after `recordInbound` (whose
   * RPC answers only true/false). A read, never a write: the service
   * role only reads this RLS-forced table. Null if there is no such row.
   */
  async inboundMessageId(
    groupId: string,
    waMessageId: string
  ): Promise<number | null> {
    const { data, error } = await this.db
      .from('submission_group_messages')
      .select('id')
      .eq('group_id', groupId)
      .eq('wa_message_id', waMessageId)
      .eq('direction', 'in')
      .maybeSingle();
    if (error) throw new Error(`submission_group_messages: ${error.message}`);
    const id = Number((data as Row | null)?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  /** True if this call ended the group. */
  async end(groupId: string, reason: string): Promise<boolean> {
    return (
      (await this.rpc('sg_end', { p_group: groupId, p_reason: reason })) ===
      true
    );
  }

  async markWaClosed(groupId: string): Promise<boolean> {
    return (await this.rpc('sg_mark_wa_closed', { p_group: groupId })) === true;
  }

  async recordWaCloseError(groupId: string, error: string): Promise<boolean> {
    return (
      (await this.rpc('sg_record_wa_close_error', {
        p_group: groupId,
        p_error: error,
      })) === true
    );
  }

  /**
   * Spends the 1:1 invite's send window atomically: false when an invite was claimed or sent within the cooldown.
   * Every attempt spends it, a failed one included.
   */
  async claimInvite(
    groupId: string,
    cooldownSeconds: number
  ): Promise<boolean> {
    return (
      (await this.rpc('sg_invite_claim', {
        p_group: groupId,
        p_cooldown_seconds: cooldownSeconds,
      })) === true
    );
  }

  /** Records the 1:1 invite send's outcome; false when the group is not ACTIVE. */
  async noteInvite(
    groupId: string,
    sent: boolean,
    error: string | null
  ): Promise<boolean> {
    return (
      (await this.rpc('sg_note_invite', {
        p_group: groupId,
        p_sent: sent,
        p_error: error,
      })) === true
    );
  }

  /**
   * Records what we learned about the customer and stamps the check; 'unknown'
   * stamps only, 'unsure' also lifts 'absent'. False when the group is not ACTIVE.
   */
  async noteCustomerMembership(
    groupId: string,
    state: CustomerMembershipNote
  ): Promise<boolean> {
    return (
      (await this.rpc('sg_note_customer_membership', {
        p_group: groupId,
        p_state: state,
      })) === true
    );
  }

  /** The account's groups due a membership check, oldest first. */
  async membershipDue(accountId: string, limit: number): Promise<string[]> {
    return scalarIds(
      await this.rpc('sg_membership_due', {
        p_account: accountId,
        p_limit: limit,
      })
    );
  }

  /**
   * Accounts that may have a membership check due. `sg_membership_due` needs an
   * account, and most accounts have no retry work to find them by. Longest
   * unchecked first, so one large account cannot fill the window.
   */
  async membershipAccounts(limit = 500): Promise<string[]> {
    const { data, error } = await this.db
      .from('submission_groups')
      .select('account_id')
      .eq('status', 'ACTIVE')
      .eq('wa_mode', 'group')
      .not('wa_group_id', 'is', null)
      .not('channel_id', 'is', null)
      .neq('customer_membership', 'joined')
      .order('customer_checked_at', { ascending: true, nullsFirst: true })
      .limit(limit);
    if (error) throw new Error(`submission_groups: ${error.message}`);
    return [
      ...new Set(((data ?? []) as Row[]).map((r) => String(r.account_id))),
    ];
  }

  async countPendingOut(groupId: string): Promise<number> {
    return Number(
      (await this.rpc('sg_count_pending_out', { p_group: groupId })) ?? 0
    );
  }

  async failStalePending(olderThanMs: number, now?: Date): Promise<string[]> {
    return scalarIds(
      await this.rpc('sg_fail_stale_pending', {
        p_older_than_ms: olderThanMs,
        p_now: now?.toISOString() ?? null,
      })
    );
  }

  /** The only archive read: audit row and messages in one statement. */
  async readArchive(
    groupId: string,
    userId: string,
    opts: { now?: Date; windowDays: number }
  ): Promise<ArchiveResult> {
    const data = await this.rpc<{ allowed?: boolean; messages?: Row[] } | null>(
      'sg_read_archive',
      {
        p_group: groupId,
        p_user: userId,
        p_now: opts.now?.toISOString() ?? null,
        p_window_days: opts.windowDays,
      }
    );
    if (!data || data.allowed !== true) return { allowed: false };
    return { allowed: true, messages: (data.messages ?? []).map(toMessage) };
  }

  async accessSet(
    groupId: string,
    userId: string,
    label: StaffLabel,
    by: string | null
  ): Promise<void> {
    await this.rpc('sg_access_set', {
      p_group: groupId,
      p_user: userId,
      p_label: label,
      p_by: by,
    });
  }

  async accessRemove(groupId: string, userId: string): Promise<boolean> {
    return (
      (await this.rpc('sg_access_remove', {
        p_group: groupId,
        p_user: userId,
      })) === true
    );
  }

  /** Consent dep for the service: opt-out / do-not-contact stamps and the phone on record. */
  async contactConsent(contactId: string): Promise<ConsentAnswer> {
    const { data, error } = await this.db
      .from('contacts')
      .select('phone, opted_out_at, do_not_contact_at')
      .eq('id', contactId)
      .maybeSingle();
    if (error) throw new Error(`contacts: ${error.message}`);
    const row = data as Row | null;
    if (!row) return { allowed: false, phone: null };
    const phone = str(row.phone)?.trim() || null;
    if (row.opted_out_at) return { allowed: false, phone, reason: 'opted_out' };
    if (row.do_not_contact_at)
      return { allowed: false, phone, reason: 'do_not_contact' };
    return { allowed: phone !== null, phone };
  }

  /** Display-name dep: the person's profile in this account (one row per workspace). */
  async displayName(userId: string, accountId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from('profiles')
      .select('full_name')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(`profiles: ${error.message}`);
    return str((data as Row | null)?.full_name)?.trim() || null;
  }
}
