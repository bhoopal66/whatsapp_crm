/**
 * Deal rooms — the stuck-room reconcile (module 014c, migration 088).
 *
 * Creating a group is asynchronous: Meta answers the create call at
 * once, and the group id arrives only in the `group_create` webhook,
 * matched to the room by `create_request_id`. So a room can stay
 * `creating` for good: the webhook is lost or never sent, it carries a
 * request id no room recorded, or the create call answered without one
 * (Meta documents no response body, and `create.ts` then has nothing to
 * record). This runs from the cron on rooms still `creating` after 2
 * minutes and looks for their group on WhatsApp by subject instead.
 *
 * A group is the room's only when exactly one active group of the number
 * has the room's exact subject, was created no earlier than the room (a
 * minute of clock skew allowed) and belongs to no other room, and no
 * other room is being created on the number under the same subject.
 * Anything else is ambiguous, and an ambiguous room is never matched:
 * opening the wrong group would invite these people into another
 * customer's group. It waits for its webhook and fails after 10 minutes.
 *
 * A room with no group at all is asked for once more; the claim on
 * `last_error` makes that once, however many ticks overlap. The retry's
 * request id is deliberately not recorded: `deal_room_mark_requested`
 * clears `last_error`, which would allow a second retry, so the next
 * tick matches the new group by subject like any other. A room still
 * without its group 10 minutes in fails, and its creator is told.
 *
 * It also frees invites stuck mid-send (a claim older than 30 minutes,
 * see `releaseStaleInviteClaims`) and runs the invites of each such room
 * that is open again; `sendRoomInvites` re-checks every invitee itself.
 * That step comes first, never throws, and does not hold up the rest.
 *
 * Never throws for one room: each failure is counted and logged, the
 * room is left as it was for the next tick, and the rest go on. Only the
 * first read of the stuck rooms can fail the run.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { ChannelError, type WhatsAppChannel } from '@/lib/whatsapp/channels';
import {
  createGroup,
  listGroups,
  type GroupSummary,
} from '@/lib/whatsapp/meta-groups';

import { releaseStaleInviteClaims, sendRoomInvites } from './invites';
import { metaChannel, notifyRoomCreator } from './shared';

/** A room still `creating` this long after it was created is stuck. */
const STUCK_AFTER_MS = 2 * 60_000;
/** A stuck room with no group to open gives up at this age. */
const GIVE_UP_AFTER_MS = 10 * 60_000;
/** Meta's clock and ours may disagree by this much (seconds). */
const CLOCK_SKEW_S = 60;
const BATCH = 50;
const MAX_GROUP_PAGES = 5;

const RETRY_NOTE =
  'WhatsApp had not confirmed the group after 2 minutes; asked again.';
const RETRY_FAILED = 'Retry failed: ';
const NO_NUMBER = "The room's Meta number is not connected.";
const NO_CREDENTIALS = "The Meta number's credentials could not be read.";
const NOT_CONFIRMED = 'WhatsApp had not confirmed the group after 10 minutes.';
const AMBIGUOUS =
  'WhatsApp had not confirmed the group after 10 minutes, and more than ' +
  'one group or room has this subject, so it could not be matched safely.';

export interface ReconcileSummary {
  /** Rooms looked at: `creating` for 2 minutes or more, at most 50. */
  checked: number;
  /** Matched to their group and opened; their people were invited. */
  opened: number;
  /** No group found: Meta was asked once more. */
  retried: number;
  /** Given up: marked failed, and the creator was told. */
  failed: number;
  /** Not yet: ambiguous, already retried, or another tick got there first. */
  waiting: number;
  /** Failed with an error, and left as they were for the next tick. */
  errors: number;
}

interface StuckRoom {
  id: string;
  account_id: string;
  channel_id: string;
  created_by: string | null;
  subject: string;
  description: string | null;
  whatsapp_config_id: string | null;
  create_request_id: string | null;
  created_at: string;
  last_error: string | null;
}

type Outcome = 'opened' | 'retried' | 'failed' | 'waiting';
type GroupsOf = (channel: WhatsAppChannel) => Promise<GroupSummary[]>;

export async function reconcileCreatingRooms(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    checked: 0,
    opened: 0,
    retried: 0,
    failed: 0,
    waiting: 0,
    errors: 0,
  };
  await resendStuckInvites(db, now);

  const { data, error } = await db
    .from('deal_rooms')
    .select(
      'id, account_id, channel_id, created_by, subject, description, whatsapp_config_id, create_request_id, created_at, last_error'
    )
    .eq('status', 'creating')
    .lte('created_at', new Date(now.getTime() - STUCK_AFTER_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`stuck room lookup failed: ${error.message}`);

  // One listing per number per run, shared by all of its rooms.
  const listings = new Map<string, Promise<GroupSummary[]>>();
  const groupsOf: GroupsOf = (channel) => {
    let listing = listings.get(channel.id);
    if (!listing) {
      listing = listAllGroups(channel);
      listings.set(channel.id, listing);
    }
    return listing;
  };

  for (const room of (data ?? []) as StuckRoom[]) {
    summary.checked += 1;
    try {
      summary[await reconcileRoom(db, room, now, groupsOf)] += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[deal-rooms] reconcile of room ${room.id} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return summary;
}

/** Releases the stale invite claims, then re-runs their open rooms once. */
async function resendStuckInvites(db: SupabaseClient, now: Date) {
  const said = (err: unknown) => (err instanceof Error ? err.message : err);
  try {
    const touched = await releaseStaleInviteClaims(db, now);
    if (touched.length === 0) return;
    const { data, error } = await db
      .from('deal_rooms')
      .select('id')
      .in('id', touched)
      .eq('status', 'open');
    if (error) throw new Error(`open room lookup failed: ${error.message}`);
    for (const { id } of (data ?? []) as { id: string }[]) {
      try {
        await sendRoomInvites(db, id);
      } catch (err) {
        // A manager's re-send reaches the rest.
        console.error(
          `[deal-rooms] invites for room ${id} not re-sent:`,
          said(err)
        );
      }
    }
  } catch (err) {
    console.error('[deal-rooms] stuck invites not handled:', said(err));
  }
}

async function reconcileRoom(
  db: SupabaseClient,
  room: StuckRoom,
  now: Date,
  groupsOf: GroupsOf
): Promise<Outcome> {
  const overdue =
    now.getTime() - Date.parse(room.created_at) >= GIVE_UP_AFTER_MS;

  let channel: WhatsAppChannel | null = null;
  if (room.whatsapp_config_id) {
    try {
      channel = await metaChannel(db, room.account_id, room.whatsapp_config_id);
    } catch (err) {
      // No token of the account decrypts. A failed lookup is only an
      // error: the next tick tries again.
      if (
        err instanceof ChannelError &&
        err.code === 'channel_credentials_unreadable'
      ) {
        return giveUp(db, room, NO_CREDENTIALS);
      }
      throw err;
    }
  }
  if (!channel) return giveUp(db, room, NO_NUMBER);

  // Another room waiting for a group with this subject on this number:
  // a group found could be either's, and a retry would only add one.
  const { data: twins, error: twinErr } = await db
    .from('deal_rooms')
    .select('id')
    .eq('status', 'creating')
    .eq('whatsapp_config_id', channel.id)
    .eq('subject', room.subject)
    .neq('id', room.id)
    .limit(1);
  if (twinErr) throw new Error(`twin room lookup failed: ${twinErr.message}`);
  if (twins && twins.length > 0) {
    return overdue ? giveUp(db, room, AMBIGUOUS) : 'waiting';
  }

  const candidates = await candidatesFor(db, room, await groupsOf(channel));
  if (candidates.length > 1) {
    return overdue ? giveUp(db, room, AMBIGUOUS) : 'waiting';
  }
  if (candidates.length === 1) return open(db, room, candidates[0].id);
  if (room.last_error === null) return retry(db, room, channel);
  if (!overdue) return 'waiting';
  // A failed retry keeps its own words: they are the likelier cause.
  return giveUp(
    db,
    room,
    room.last_error.startsWith(RETRY_FAILED)
      ? `${NOT_CONFIRMED} ${room.last_error}`
      : NOT_CONFIRMED
  );
}

/** The number's active groups, at most `MAX_GROUP_PAGES` pages. */
async function listAllGroups(
  channel: WhatsAppChannel
): Promise<GroupSummary[]> {
  // By id: a group that moves between pages is still one group.
  const byId = new Map<string, GroupSummary>();
  let after: string | null = null;
  for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
    const result = await listGroups({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      after,
    });
    for (const group of result.groups) byId.set(group.id, group);
    after = result.after;
    if (!after) break;
  }
  return [...byId.values()];
}

/** Groups that could be this room's: same subject, not older, unowned. */
async function candidatesFor(
  db: SupabaseClient,
  room: StuckRoom,
  groups: GroupSummary[]
): Promise<GroupSummary[]> {
  const since = Math.floor(Date.parse(room.created_at) / 1000) - CLOCK_SKEW_S;
  const matching = groups.filter(
    (g) =>
      g.subject === room.subject && g.createdAt !== null && g.createdAt >= since
  );
  if (matching.length === 0) return [];
  const { data, error } = await db
    .from('deal_rooms')
    .select('wa_group_id')
    .in(
      'wa_group_id',
      matching.map((g) => g.id)
    );
  if (error) throw new Error(`group owner lookup failed: ${error.message}`);
  const owned = new Set(
    ((data ?? []) as { wa_group_id: string }[]).map((r) => r.wa_group_id)
  );
  return matching.filter((g) => !owned.has(g.id));
}

async function open(
  db: SupabaseClient,
  room: StuckRoom,
  groupId: string
): Promise<Outcome> {
  let requestId = room.create_request_id;
  if (!requestId) {
    // `deal_room_group_created` finds the room by request id: give it one.
    requestId = `reconciled:${groupId}`;
    await rpc(db, 'deal_room_mark_requested', {
      p_room: room.id,
      p_request_id: requestId,
    });
  }
  await rpc(db, 'deal_room_group_created', {
    p_account: room.account_id,
    p_request_id: requestId,
    p_group_id: groupId,
    p_invite_link_hash: null,
  });
  await audit(db, room, 'create_reconciled', { group_id: groupId });
  try {
    await sendRoomInvites(db, room.id);
  } catch (err) {
    // The room is open either way; a manager's re-send reaches the rest.
    console.error(
      `[deal-rooms] invites for reconciled room ${room.id} failed:`,
      err instanceof Error ? err.message : err
    );
  }
  return 'opened';
}

async function retry(
  db: SupabaseClient,
  room: StuckRoom,
  channel: WhatsAppChannel
): Promise<Outcome> {
  // The one retry is claimed where `last_error` is still NULL, so of two
  // overlapping ticks only one asks Meta.
  const { data: claimed, error } = await db
    .from('deal_rooms')
    .update({ last_error: RETRY_NOTE })
    .eq('id', room.id)
    .eq('status', 'creating')
    .is('last_error', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`retry claim failed: ${error.message}`);
  if (!claimed) return 'waiting';
  await audit(db, room, 'create_retried', {});
  try {
    await createGroup({
      phoneNumberId: channel.phoneNumberId,
      accessToken: channel.accessToken,
      subject: room.subject,
      description: room.description,
      joinApprovalMode: 'approval_required',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[deal-rooms] retry for room ${room.id} failed: ${message}`);
    const { error: noteErr } = await db
      .from('deal_rooms')
      .update({ last_error: RETRY_FAILED + message })
      .eq('id', room.id)
      .eq('status', 'creating');
    if (noteErr) {
      console.error(
        '[deal-rooms] retry failure not recorded:',
        noteErr.message
      );
    }
  }
  return 'retried';
}

async function giveUp(
  db: SupabaseClient,
  room: StuckRoom,
  reason: string
): Promise<Outcome> {
  // Claimed while still `creating`: `deal_room_set_status` would
  // otherwise overwrite a room the webhook has opened since it was read.
  const { data: claimed, error } = await db
    .from('deal_rooms')
    .update({ last_error: reason })
    .eq('id', room.id)
    .eq('status', 'creating')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`give-up claim failed: ${error.message}`);
  if (!claimed) return 'waiting';
  await rpc(db, 'deal_room_set_status', {
    p_room: room.id,
    p_status: 'failed',
    p_reason: reason,
  });
  await notifyRoomCreator(db, room, 'Deal room could not be created', {
    event: 'create_failed',
    reason,
  });
  return 'failed';
}

async function rpc(
  db: SupabaseClient,
  fn: string,
  params: Record<string, unknown>
): Promise<void> {
  const { error } = await db.rpc(fn, params);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
}

async function audit(
  db: SupabaseClient,
  room: StuckRoom,
  action: string,
  detail: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from('deal_room_audit').insert({
    room_id: room.id,
    account_id: room.account_id,
    actor_id: null,
    action,
    detail,
  });
  if (error) console.error('[deal-rooms] audit failed:', error.message);
}
