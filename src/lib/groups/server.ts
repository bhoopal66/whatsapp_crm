// ============================================================
// WhatsApp groups — server-side helpers shared by the route handlers
// (migration 114). The meetings pattern: access is judged through the
// caller's RLS client (`whatsapp_groups` SELECT is
// `whatsapp_group_can_view`, managing is the `whatsapp_group_can_manage`
// RPC); the service role writes, and only after that check and after
// the Whapi call succeeded. Tokens come from `channels.ts` only.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { serverSupabaseUrl } from '@/lib/supabase/urls';
import {
  ChannelError,
  loadChannels,
  type WhatsAppChannel,
} from '@/lib/whatsapp/channels';
import {
  describeGroupFailure,
  GroupsUnsupportedError,
  isGroupId,
  ourRoleIn,
  type Group,
  type GroupFailureKey,
} from '@/lib/whatsapp/groups';
import { normalizePhone, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { WhapiError } from '@/lib/whatsapp/whapi-api';

import { parseGroupSettings, type WhatsappGroupRow } from './types';

export const GROUP_COLUMNS =
  'id, account_id, channel_id, wa_group_id, name, description, icon_url, participants_count, settings, our_role, created_by, created_at, synced_at, last_message_at, left_at';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);

let _admin: SupabaseClient | null = null;
/** Lazy service-role client (same shape as lib/meetings/server.ts). */
export function supabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      serverSupabaseUrl(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _admin;
}

/** A refusal a route answers as `{ error, code }` with `status`. */
export class GroupHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'GroupHttpError';
  }
}

const FAILURES: Record<GroupFailureKey, [number, string]> = {
  not_whapi: [400, 'WhatsApp groups need a Whapi number'],
  not_admin: [403, "Your number isn't an admin of this group"],
  group_not_found: [404, "This group isn't on the number any more"],
  already_member: [409, 'That person is already in the group'],
  rate_limited: [429, 'WhatsApp is rate limiting this number; try later'],
  channel_disconnected: [503, "The group's number is disconnected"],
  billing: [402, "The number's Whapi plan has run out"],
  invalid_request: [400, 'WhatsApp refused the request as invalid'],
  gateway_unavailable: [502, 'WhatsApp did not respond; try again'],
  unknown: [502, 'WhatsApp refused the request'],
};

/** The status and wording for a failed group call, by its stable key. */
export function groupFailure(key: GroupFailureKey): {
  status: number;
  error: string;
} {
  const [status, error] = FAILURES[key];
  return { status, error };
}

/**
 * The one catch of every group route: our own refusals, a Whapi or
 * channel failure as `{ error, code }`, anything else through
 * `toErrorResponse` (auth errors keep their status; the rest is 500).
 */
export function groupErrorResponse(err: unknown): NextResponse {
  if (err instanceof GroupHttpError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status }
    );
  }
  if (err instanceof WhapiError || err instanceof GroupsUnsupportedError) {
    const code = describeGroupFailure(err);
    const { status, error } = groupFailure(code);
    if (code === 'unknown' || code === 'gateway_unavailable') {
      console.error('[groups] whapi call failed', err);
    }
    return NextResponse.json({ error, code }, { status });
  }
  if (err instanceof ChannelError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status }
    );
  }
  return toErrorResponse(err);
}

type Caller = { supabase: SupabaseClient; accountId: string };

/**
 * The group, read through the caller's RLS (invisible → 404); with
 * `manage`, also `whatsapp_group_can_manage` (→ 403). A failed read is
 * 503, never a 404/403 on a blip.
 */
export async function loadGroupForCaller(
  ctx: Caller,
  id: string,
  opts: { manage?: boolean } = {}
): Promise<WhatsappGroupRow> {
  if (!isUuid(id))
    throw new GroupHttpError(404, 'not_found', 'Group not found');
  const { data, error } = await ctx.supabase
    .from('whatsapp_groups')
    .select(GROUP_COLUMNS)
    .eq('account_id', ctx.accountId)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[groups] group read failed', error);
    throw new GroupHttpError(503, 'unavailable', 'Could not load the group');
  }
  if (!data) throw new GroupHttpError(404, 'not_found', 'Group not found');
  const group = data as WhatsappGroupRow;
  if (opts.manage && !(await callerCanManage(ctx.supabase, id))) {
    throw new GroupHttpError(403, 'not_allowed', "You can't manage this group");
  }
  return group;
}

/** `whatsapp_group_can_manage` for the caller; a failed call is 503. */
export async function callerCanManage(
  supabase: SupabaseClient,
  groupId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc('whatsapp_group_can_manage', {
    p_group: groupId,
  });
  if (error) {
    console.error('[groups] can_manage failed', error);
    throw new GroupHttpError(503, 'unavailable', 'Could not check access');
  }
  return data === true;
}

/** The account's Whapi number by id, token decrypted. */
export async function loadWhapiChannel(
  accountId: string,
  channelId: string | null
): Promise<WhatsAppChannel> {
  const channels = channelId
    ? await loadChannels(supabaseAdmin(), accountId)
    : [];
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) {
    throw new GroupHttpError(
      409,
      'number_removed',
      "The group's number is no longer connected"
    );
  }
  if (channel.provider !== 'whapi') {
    throw new GroupsUnsupportedError(channel.provider);
  }
  return channel;
}

/** The number a group lives on, ready to call Whapi with. */
export function channelForGroup(
  group: Pick<WhatsappGroupRow, 'account_id' | 'channel_id'>
): Promise<WhatsAppChannel> {
  return loadWhapiChannel(group.account_id, group.channel_id);
}

const MAX_IN = 300;

/**
 * Each wa_id's contact in the account, by `contacts.phone_normalized`
 * over `phoneVariants` (exact form first, then trunk-0 forms), as the
 * deal-room webhook matches a group member.
 */
async function matchContacts(
  admin: SupabaseClient,
  accountId: string,
  waIds: string[]
): Promise<Map<string, string>> {
  const variantsOf = new Map(waIds.map((w) => [w, phoneVariants(w)]));
  const all = [...new Set([...variantsOf.values()].flat())];
  const byPhone = new Map<string, string>();
  for (let i = 0; i < all.length; i += MAX_IN) {
    const { data, error } = await admin
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', accountId)
      .in('phone_normalized', all.slice(i, i + MAX_IN));
    if (error) {
      console.error('[groups] contact match failed', error);
      return new Map();
    }
    for (const r of (data ?? []) as Array<{
      id: string;
      phone_normalized: string | null;
    }>) {
      if (r.phone_normalized && !byPhone.has(r.phone_normalized)) {
        byPhone.set(r.phone_normalized, r.id);
      }
    }
  }
  const out = new Map<string, string>();
  for (const [waId, variants] of variantsOf) {
    const hit = variants.find((v) => byPhone.has(v));
    if (hit) out.set(waId, byPhone.get(hit)!);
  }
  return out;
}

/**
 * Write what Whapi says a group is: upsert `whatsapp_groups` on
 * (channel_id, wa_group_id), then upsert its participants and drop
 * whoever is no longer listed. `createdBy`
 * is sent only for a group we just created: the guard freezes it, so a
 * sync must leave an existing row's creator alone. `our_role` is left
 * out when our number is not in the list, so an existing row keeps it
 * (a left group stays left) and a new one takes the default `member`.
 * The icon URL is an expiring CDN link and is not stored.
 */
export async function persistGroupSnapshot(
  admin: SupabaseClient,
  channel: Pick<WhatsAppChannel, 'id' | 'accountId' | 'wabaId'>,
  group: Group,
  opts: { createdBy?: string } = {}
): Promise<WhatsappGroupRow> {
  if (!isGroupId(group.id)) throw new Error(`Not a group id: ${group.id}`);
  const row: Record<string, unknown> = {
    account_id: channel.accountId,
    channel_id: channel.id,
    wa_group_id: group.id,
    name: group.name.slice(0, 200),
    description: group.description?.slice(0, 2048) ?? null,
    participants_count: Math.max(
      group.participantsCount,
      group.participants.length
    ),
    settings: parseGroupSettings(group.settings),
    synced_at: new Date().toISOString(),
  };
  const role = ourRoleIn(group, normalizePhone(channel.wabaId ?? '') || null);
  if (role) row.our_role = role === 'member' ? 'member' : 'admin';
  if (opts.createdBy) row.created_by = opts.createdBy;

  const { data, error } = await admin
    .from('whatsapp_groups')
    .upsert(row, { onConflict: 'channel_id,wa_group_id' })
    .select(GROUP_COLUMNS)
    .single();
  if (error || !data) throw error ?? new Error('group upsert returned nothing');
  const saved = data as WhatsappGroupRow;

  const people = new Map<string, Group['participants'][number]>();
  for (const p of group.participants) if (p.waId) people.set(p.waId, p);
  const contacts = await matchContacts(admin, channel.accountId, [
    ...people.keys(),
  ]);
  // Upsert, then drop only who is no longer listed. Delete-all-then-
  // insert left the list empty between the two calls, and two saves of
  // one group (the create route and its `groups.post` webhook) collided
  // on the primary key, failing the create after WhatsApp had made it.
  if (people.size > 0) {
    const up = await admin.from('whatsapp_group_participants').upsert(
      [...people.values()].map((p) => ({
        group_id: saved.id,
        account_id: channel.accountId,
        wa_id: p.waId,
        contact_id: contacts.get(p.waId!) ?? null,
        role: p.role,
      })),
      { onConflict: 'group_id,wa_id' }
    );
    if (up.error) throw up.error;
  }
  const cur = await admin
    .from('whatsapp_group_participants')
    .select('wa_id')
    .eq('group_id', saved.id);
  if (cur.error) throw cur.error;
  const gone = ((cur.data ?? []) as Array<{ wa_id: string }>)
    .map((r) => r.wa_id)
    .filter((w) => !people.has(w));
  for (let i = 0; i < gone.length; i += MAX_IN) {
    const del = await admin
      .from('whatsapp_group_participants')
      .delete()
      .eq('group_id', saved.id)
      .in('wa_id', gone.slice(i, i + MAX_IN));
    if (del.error) throw del.error;
  }
  return saved;
}
