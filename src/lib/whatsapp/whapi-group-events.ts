/**
 * Whapi group webhook events → neutral, typed events.
 *
 * Pure and defensive: a malformed item is skipped, nothing throws.
 * Shapes are from https://support.whapi.cloud/help-desk/receiving/webhooks/incoming-webhooks-format/groups
 *
 *   groups.post   { groups[] }               a group the number joined/created
 *   groups.put    { groups_participants[] }  add | remove | promote | demote | request
 *   groups.patch  { groups_updates[] }       before_update / after_update snapshots
 *
 * Group traffic never enters the inbox pipeline; the route hands these
 * to the group handler. A member changing phone number arrives as an
 * `add`, indistinguishable from a new member (Whapi's own note).
 */
import { toParticipantWaId } from './groups';
import {
  WHAPI_GROUP_SETTINGS,
  isWhapiGroupId,
  parseWhapiGroup,
  type WhapiGroup,
  type WhapiGroupPolicy,
  type WhapiGroupSetting,
} from './whapi-api';

export type GroupParticipantAction =
  'add' | 'remove' | 'promote' | 'demote' | 'request';

const ACTIONS: readonly GroupParticipantAction[] = [
  'add',
  'remove',
  'promote',
  'demote',
  'request',
];

export interface GroupUpsertEvent {
  kind: 'group_upsert';
  group: WhapiGroup;
}

export interface GroupParticipantsEvent {
  kind: 'participants';
  groupId: string;
  action: GroupParticipantAction;
  /** Phone digits; ids with no phone (privacy ids) are counted, not listed. */
  waIds: string[];
  /** Participants the payload named but whose phone is unknown. */
  unresolved: number;
  /** `link` when someone joined through the invite link. */
  performedBy: string | null;
}

export interface GroupChanges {
  name?: string;
  description?: string | null;
  settings?: Partial<Record<WhapiGroupSetting, WhapiGroupPolicy>>;
}

export interface GroupUpdateEvent {
  kind: 'group_update';
  groupId: string;
  changes: GroupChanges;
}

export type WhapiGroupEvent =
  GroupUpsertEvent | GroupParticipantsEvent | GroupUpdateEvent;

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Whether a callback body is one of Whapi's `groups` events. */
export function isGroupsWebhook(body: unknown): boolean {
  return record(record(body)?.event)?.type === 'groups';
}

function parseParticipantsItem(item: unknown): GroupParticipantsEvent | null {
  const i = record(item);
  if (!i) return null;
  const groupId = i.group_id;
  if (typeof groupId !== 'string' || !isWhapiGroupId(groupId)) return null;
  const action = ACTIONS.find((a) => a === i.action);
  if (!action || !Array.isArray(i.participants)) return null;
  const waIds: string[] = [];
  let unresolved = 0;
  for (const p of i.participants) {
    const raw = typeof p === 'string' ? p : record(p)?.id;
    const waId = typeof raw === 'string' ? toParticipantWaId(raw) : null;
    if (!waId) unresolved++;
    else if (!waIds.includes(waId)) waIds.push(waId);
  }
  if (waIds.length === 0 && unresolved === 0) return null;
  return {
    kind: 'participants',
    groupId,
    action,
    waIds,
    unresolved,
    performedBy:
      typeof i.performed_by === 'string' && i.performed_by
        ? i.performed_by
        : null,
  };
}

function parseUpdateItem(item: unknown): GroupUpdateEvent | null {
  const i = record(item);
  if (!i) return null;
  const after = parseWhapiGroup(i.after_update);
  if (!after) return null;
  const before = parseWhapiGroup(i.before_update);
  const changes: GroupChanges = {};
  if (before) {
    if (before.name !== after.name) changes.name = after.name;
    if (before.description !== after.description) {
      changes.description = after.description;
    }
    const settings: NonNullable<GroupChanges['settings']> = {};
    for (const key of WHAPI_GROUP_SETTINGS) {
      const next = after.settings[key];
      if (next !== null && next !== before.settings[key]) settings[key] = next;
    }
    if (Object.keys(settings).length > 0) changes.settings = settings;
  }
  if (Object.keys(changes).length === 0) return null;
  return { kind: 'group_update', groupId: after.id, changes };
}

/**
 * Every group event in a callback body, in order. Anything that is not
 * a groups event, or has no usable items, yields an empty list.
 */
export function parseWhapiGroupEvents(body: unknown): WhapiGroupEvent[] {
  const b = record(body);
  if (!b || !isGroupsWebhook(b)) return [];
  const out: WhapiGroupEvent[] = [];
  const each = (v: unknown, fn: (item: unknown) => WhapiGroupEvent | null) => {
    if (!Array.isArray(v)) return;
    for (const item of v) {
      try {
        const e = fn(item);
        if (e) out.push(e);
      } catch {
        // A malformed item is skipped, never fatal.
      }
    }
  };
  each(b.groups, (item) => {
    const group = parseWhapiGroup(item);
    return group ? { kind: 'group_upsert', group } : null;
  });
  each(b.groups_participants, parseParticipantsItem);
  each(b.groups_updates, parseUpdateItem);
  return out;
}
