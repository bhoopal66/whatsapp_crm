/**
 * Row types for migration 114 (whatsapp_groups and its satellites).
 * Column names and nullability mirror the migration — change both.
 */

export const GROUP_SETTINGS = [
  'send_messages',
  'edit_group_info',
  'approve_participants',
  'add_participants',
] as const;
export type GroupSetting = (typeof GROUP_SETTINGS)[number];

export type GroupPolicy = 'anyone' | 'admins';
export type GroupSettings = Partial<Record<GroupSetting, GroupPolicy>>;

export type GroupOurRole = 'admin' | 'member' | 'left';
export type GroupParticipantRole = 'member' | 'admin' | 'superadmin';
export type GroupMessageStatus =
  'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsappGroupRow {
  id: string;
  account_id: string;
  channel_id: string | null;
  wa_group_id: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  participants_count: number;
  settings: GroupSettings;
  our_role: GroupOurRole;
  created_by: string | null;
  created_at: string;
  synced_at: string | null;
  last_message_at: string | null;
  left_at: string | null;
}

export interface WhatsappGroupParticipantRow {
  group_id: string;
  account_id: string;
  wa_id: string;
  contact_id: string | null;
  role: GroupParticipantRole;
  added_at: string;
}

export interface WhatsappGroupManagerRow {
  group_id: string;
  account_id: string;
  user_id: string;
  created_at: string;
}

export interface WhatsappGroupInviteRow {
  group_id: string;
  account_id: string;
  invite_code: string;
  invite_link: string;
  fetched_at: string;
}

export interface WhatsappGroupMessageRow {
  id: string;
  account_id: string;
  group_id: string;
  wa_message_id: string;
  direction: 'in' | 'out';
  sender_wa_id: string | null;
  sender_name: string | null;
  sender_user_id: string | null;
  type: string;
  body: string | null;
  media: Record<string, unknown> | null;
  status: GroupMessageStatus | null;
  created_at: string;
}

function isPolicy(v: unknown): v is GroupPolicy {
  return v === 'anyone' || v === 'admins';
}

/** Tolerant read of `whatsapp_groups.settings`: unknown keys and values drop. */
export function parseGroupSettings(raw: unknown): GroupSettings {
  const out: GroupSettings = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const key of GROUP_SETTINGS) {
    if (isPolicy(obj[key])) out[key] = obj[key];
  }
  return out;
}

/**
 * Whapi's participant rank to ours: `creator` is the group's
 * superadmin, `admin` stays, anything else is a member.
 */
export function normalizeParticipantRole(
  whapiRole: unknown
): GroupParticipantRole {
  const r = typeof whapiRole === 'string' ? whapiRole.toLowerCase() : '';
  if (r === 'creator') return 'superadmin';
  if (r === 'admin') return 'admin';
  return 'member';
}
