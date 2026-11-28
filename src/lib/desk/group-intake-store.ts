/**
 * Desk group intake (migration 334): WhatsApp groups linked to a bank,
 * the one staff member behind a sender's number, what became of each file
 * posted in a linked group, the reply claim, and the group wall's per-group
 * bank figures. One SECURITY DEFINER RPC per call on the service role, with
 * the caller's auth user id as the actor and their ACTIVE account; the SQL
 * decides every permission and who sees which group (299's rule), and a
 * refusal is thrown as DeskRefusedError (`deskRpc`).
 *
 * TENANCY: the routes pass `ctx.accountId` (the caller's active account).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { deskRpc, type ItemState } from './store';

/** 334's `desk_group_intake_outcome_check`, in order. */
export const GROUP_INTAKE_OUTCOMES = [
  'filed',
  'new_case',
  'queued',
  'duplicate',
  'refused',
  'unknown_sender',
  'no_copy',
  'file_type',
  'chat',
] as const;
export type GroupIntakeOutcome = (typeof GROUP_INTAKE_OUTCOMES)[number];

/** 334's `desk_group_intake_reply_state_check`. */
export const GROUP_REPLY_STATES = ['off', 'pending', 'sent', 'failed'] as const;
export type GroupReplyState = (typeof GROUP_REPLY_STATES)[number];

/** `desk_group_outcomes` and `desk_group_wall` refuse more ids (INVALID). */
export const GROUP_IDS_MAX = 500;

export type GroupWallAlert = 'none' | 'second' | 'lead' | 'no_coordinator';

export interface GroupLink {
  groupId: string;
  groupName: string;
  bankCode: string;
  bankName: string;
  intakeEnabled: boolean;
  repliesEnabled: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

/** `desk_group_link_for_group`: what the inbound hook needs of a link. */
export type GroupIntakeLink = Pick<
  GroupLink,
  'bankCode' | 'bankName' | 'intakeEnabled' | 'repliesEnabled'
>;

/** What `setLink` stores; null removes the link. */
export interface GroupLinkInput {
  bankCode: string;
  intakeEnabled: boolean;
  /** Only with intake on (INVALID otherwise). */
  repliesEnabled: boolean;
}

export interface GroupWallRow {
  groupId: string;
  bankCode: string;
  bankName: string;
  shortCode: string | null;
  primaryName: string | null;
  secondName: string | null;
  /** Intake items of the bank filed today (Asia/Dubai), any channel. */
  filedToday: number;
  /** Untagged items queued to the bank. */
  toSort: number;
  oldestAgeSeconds: number | null;
  alert: GroupWallAlert;
}

export interface GroupOutcome {
  groupMessageId: string;
  outcome: GroupIntakeOutcome;
  /** A reason code, never free text. */
  detail: string | null;
  replyState: GroupReplyState;
  /** The intake item's state now (a queued file filed later reads filed). */
  itemState: ItemState | null;
  caseNumber: string | null;
  captionCode: string | null;
  docKey: string | null;
  queueReason: string | null;
}

export interface GroupIntakeRecord {
  groupMessageId: string;
  outcome: GroupIntakeOutcome;
  intakeItemId: string | null;
  /** A reason code (`^[A-Za-z0-9_]{1,64}$`), never free text. */
  detail: string | null;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : v === null || v === undefined ? null : String(v);
const count = (v: unknown): number => (v == null ? 0 : Number(v));

/** A scalar RPC answers the value itself, or a one-key object. */
function scalar(v: unknown): unknown {
  if (v && typeof v === 'object') return Object.values(v)[0] ?? null;
  return v ?? null;
}

export function parseGroupLink(r: Row): GroupLink {
  return {
    groupId: String(r.group_id),
    groupName: String(r.group_name ?? ''),
    bankCode: String(r.bank_code),
    bankName: String(r.bank_name ?? ''),
    intakeEnabled: r.intake_enabled === true,
    repliesEnabled: r.replies_enabled === true,
    updatedBy: str(r.updated_by),
    updatedAt: String(r.updated_at),
  };
}

export function parseGroupWallRow(r: Row): GroupWallRow {
  return {
    groupId: String(r.group_id),
    bankCode: String(r.bank_code),
    bankName: String(r.bank_name ?? ''),
    shortCode: str(r.short_code),
    primaryName: str(r.primary_name),
    secondName: str(r.second_name),
    filedToday: count(r.filed_today),
    toSort: count(r.to_sort),
    oldestAgeSeconds:
      r.oldest_age_seconds == null ? null : Number(r.oldest_age_seconds),
    alert: String(r.alert) as GroupWallAlert,
  };
}

export function parseGroupOutcome(r: Row): GroupOutcome {
  return {
    groupMessageId: String(r.group_message_id),
    outcome: String(r.outcome) as GroupIntakeOutcome,
    detail: str(r.detail),
    replyState: String(r.reply_state) as GroupReplyState,
    itemState: str(r.item_state) as ItemState | null,
    caseNumber: str(r.case_number),
    captionCode: str(r.caption_code),
    docKey: str(r.doc_key),
    queueReason: str(r.queue_reason),
  };
}

export class DeskGroupIntakeStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private now() {
    return this.clock().toISOString();
  }

  /** Owner / admin / team leader who sees the group; null unlinks. */
  async setLink(
    actor: string,
    account: string,
    groupId: string,
    link: GroupLinkInput | null
  ): Promise<void> {
    await deskRpc(this.db, 'desk_group_link_set', {
      p_actor: actor,
      p_account: account,
      p_group: groupId,
      p_bank_code: link?.bankCode ?? null,
      p_intake: link?.intakeEnabled ?? null,
      p_replies: link?.repliesEnabled ?? null,
      p_now: this.now(),
    });
  }

  async listLinks(actor: string, account: string): Promise<GroupLink[]> {
    const rows = await deskRpc(this.db, 'desk_group_link_list', {
      p_actor: actor,
      p_account: account,
    });
    return rows.map(parseGroupLink);
  }

  /**
   * The inbound hook's read, with no actor: one group's link, or null for
   * an unlinked group or a submission group's mirror.
   */
  async linkForGroup(
    account: string,
    groupId: string
  ): Promise<GroupIntakeLink | null> {
    const rows = await deskRpc(this.db, 'desk_group_link_for_group', {
      p_account: account,
      p_group: groupId,
    });
    const r = rows[0];
    if (!r) return null;
    return {
      bankCode: String(r.bank_code),
      bankName: String(r.bank_name ?? ''),
      intakeEnabled: r.intake_enabled === true,
      repliesEnabled: r.replies_enabled === true,
    };
  }

  /** The one live staff member with this number (digits), else null. */
  async staffForPhone(account: string, digits: string): Promise<string | null> {
    const rows = await deskRpc(this.db, 'desk_group_staff_for_phone', {
      p_account: account,
      p_digits: digits,
    });
    const v = scalar(rows[0]);
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /** First write wins: answers the outcome stored for the message. */
  async record(
    account: string,
    input: GroupIntakeRecord
  ): Promise<GroupIntakeOutcome> {
    const rows = await deskRpc(this.db, 'desk_group_intake_record', {
      p_account: account,
      p_group_message_id: input.groupMessageId,
      p_outcome: input.outcome,
      p_intake_item_id: input.intakeItemId,
      p_detail: input.detail,
      p_now: this.now(),
    });
    return String(scalar(rows[0])) as GroupIntakeOutcome;
  }

  /** True at most once per message: the caller then sends the reply. */
  async claimReply(account: string, groupMessageId: string): Promise<boolean> {
    const rows = await deskRpc(this.db, 'desk_group_reply_claim', {
      p_account: account,
      p_group_message_id: groupMessageId,
      p_now: this.now(),
    });
    return scalar(rows[0]) === true;
  }

  async settleReply(
    account: string,
    groupMessageId: string,
    ok: boolean,
    replyMessageId: string | null
  ): Promise<boolean> {
    const rows = await deskRpc(this.db, 'desk_group_reply_settle', {
      p_account: account,
      p_group_message_id: groupMessageId,
      p_ok: ok,
      p_reply_message_id: ok ? replyMessageId : null,
      p_now: this.now(),
    });
    return scalar(rows[0]) === true;
  }

  /** Linked groups among `groupIds` the actor sees, in the given order. */
  async wall(
    actor: string,
    account: string,
    groupIds: readonly string[]
  ): Promise<GroupWallRow[]> {
    if (groupIds.length === 0) return [];
    const rows = await deskRpc(this.db, 'desk_group_wall', {
      p_actor: actor,
      p_account: account,
      p_group_ids: groupIds,
      p_now: this.now(),
    });
    return rows.map(parseGroupWallRow);
  }

  /** Outcomes of messages in groups the actor sees; at most 500 ids. */
  async outcomes(
    actor: string,
    account: string,
    messageIds: readonly string[]
  ): Promise<GroupOutcome[]> {
    if (messageIds.length === 0) return [];
    const rows = await deskRpc(this.db, 'desk_group_outcomes', {
      p_actor: actor,
      p_account: account,
      p_message_ids: messageIds,
    });
    return rows.map(parseGroupOutcome);
  }
}
