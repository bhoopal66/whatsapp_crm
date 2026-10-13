import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSystemTask, resolveTaskOwner } from '@/lib/tasks/system';
import { phonesMatch } from '@/lib/whatsapp/phone-utils';

import { settleCallbackCall } from './callbacks';
import { digitsOnly } from './extensions';
import {
  contactPhoneCandidates,
  normalizeRemoteNumber,
  type RemoteNumber,
} from './phone';
import type { CallMember } from './yeastar/api';
import {
  isMissedCallEnd,
  parseYeastarEvent,
  remoteParty,
  ringingExtensions,
  type CallDirection,
  type CallEndEvent,
  type CallStateEvent,
  type YeastarEvent,
} from './yeastar/events';

/**
 * The phone system's event processor: one Yeastar event (webhook or
 * WebSocket gateway) into the call, screen-pop, presence and task rows.
 * `db` is the service role, so every read and write names its account.
 *
 * Idempotency is the pbx_events_raw insert: a payload already stored
 * (same connection, same stable-JSON hash) is a duplicate and nothing
 * runs. Below it, writes are keyed on the PBX's call id and the task on
 * `call:<calls.id>`, so a re-sent event under another hash still lands
 * once. Never throws for a bad event: the error is stamped on its raw
 * row, which is where an admin looks.
 *
 * Tenancy: an inbound call belongs to the workspace its dialled number
 * (DID) routes to, else (no route: "unrouted", logged and kept on the
 * row) to the connection's own; any other call to its extension's
 * workspace, else the connection's. A call keeps the workspace of its
 * first event (calls.account_id cannot change). Customers are matched
 * only among that workspace's contacts.
 */

type Row = Record<string, unknown>;
type CallStatus =
  | 'ringing'
  | 'in_progress'
  | 'answered'
  | 'no_answer'
  | 'busy'
  | 'voicemail'
  | 'abandoned'
  | 'failed';

const LIVE: CallStatus[] = ['ringing', 'in_progress'];
const ANSWERED = new Set(['ANSWERED', 'ANSWER']);
const END_STATUS: Record<string, CallStatus> = {
  ANSWERED: 'answered',
  'NO ANSWER': 'no_answer',
  BUSY: 'busy',
  VOICEMAIL: 'voicemail',
  ABANDONED: 'abandoned',
  FAILED: 'failed',
};
const TASK_HOLDERS = ['owner', 'admin', 'team_leader', 'agent'];
const CALL_COLUMNS =
  'id, account_id, direction, status, extension, user_id, peer_user_id, contact_id, conversation_id, did_number, started_at, answered_at, recording_state, meta';

export interface IngestInput {
  db: SupabaseClient;
  connectionId: string;
  /** One event frame: an object, or the JSON text of one. */
  payload: unknown;
  receivedAt?: Date | string;
}

export interface IngestResult {
  duplicate: boolean;
  kind?: YeastarEvent['kind'];
  error?: string;
}

const isRecord = (v: unknown): v is Row =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The frame as stored: parsed when it is JSON text. */
function frameOf(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  const parsed = tryJson(payload);
  return parsed.ok ? parsed.value : payload;
}

/**
 * The dedupe key: sha256 over the connection and the frame's stable
 * JSON, a string `msg` read as JSON, so key order and the docs' two
 * `msg` forms hash alike.
 */
export function pbxEventHash(connectionId: string, payload: unknown): string {
  let frame = frameOf(payload);
  if (isRecord(frame) && typeof frame.msg === 'string') {
    const msg = tryJson(frame.msg);
    if (msg.ok) frame = { ...frame, msg: msg.value };
  }
  return crypto
    .createHash('sha256')
    .update(`${connectionId}\n${stableJson(frame)}`)
    .digest('hex');
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function fail(op: string, error: { message: string }): never {
  throw new Error(`${op} failed: ${error.message}`);
}

const unique = <T>(xs: (T | null | undefined)[]): T[] => [
  ...new Set(xs.filter((x): x is T => x !== null && x !== undefined)),
];

export async function ingestPbxEvent(
  input: IngestInput
): Promise<IngestResult> {
  const { db, connectionId } = input;
  const receivedAt = new Date(input.receivedAt ?? Date.now()).toISOString();
  const frame = frameOf(input.payload);
  const rawType = isRecord(frame) ? Number(frame.type) : NaN;
  const { data, error } = await db
    .from('pbx_events_raw')
    .upsert(
      {
        connection_id: connectionId,
        event_type:
          Number.isInteger(rawType) && rawType >= 0 && rawType < 2 ** 31
            ? rawType
            : null,
        payload: frame ?? null,
        hash: pbxEventHash(connectionId, input.payload),
        received_at: receivedAt,
      },
      { onConflict: 'hash', ignoreDuplicates: true }
    )
    .select('id');
  if (error) {
    console.error(`[pbx] ${connectionId}: event not stored: ${error.message}`);
    return { duplicate: false, error: `event not stored: ${error.message}` };
  }
  const rawId = (data as { id: unknown }[] | null)?.[0]?.id;
  if (rawId === undefined) return { duplicate: true };
  return processStoredPbxEvent({ db, connectionId, rawId, frame, receivedAt });
}

export interface StoredEventInput {
  db: SupabaseClient;
  connectionId: string;
  /** pbx_events_raw.id of the stored frame. */
  rawId: unknown;
  /** The frame as stored (pbx_events_raw.payload). */
  frame: unknown;
  receivedAt: string;
}

/**
 * Runs a frame already stored in pbx_events_raw and stamps the outcome
 * on its row. `ingestPbxEvent` calls it after the insert; the retry
 * sweep (housekeeping.ts) calls it for a row that failed, because a
 * second ingest of the same frame would be skipped as a duplicate.
 */
export async function processStoredPbxEvent(
  input: StoredEventInput
): Promise<IngestResult> {
  const { db, connectionId, rawId, frame, receivedAt } = input;
  let kind: YeastarEvent['kind'] | undefined;
  let failure: string | null = null;
  let conn: { account_id: string; status: string } | null = null;
  try {
    const read = await db
      .from('pbx_connections')
      .select('account_id, status')
      .eq('id', connectionId)
      .maybeSingle();
    if (read.error) fail('pbx_connections read', read.error);
    conn = read.data as { account_id: string; status: string } | null;
    if (!conn) throw new Error('connection not found');
    const parsed =
      typeof frame === 'string' || isRecord(frame)
        ? parseYeastarEvent(frame as string | object)
        : ({ ok: false, error: 'frame is not a JSON object' } as const);
    if (!parsed.ok) failure = parsed.error;
    else {
      kind = parsed.event.kind;
      const ctx: Ctx = {
        db,
        connectionId,
        connectionAccountId: conn.account_id,
        receivedAt,
      };
      await dispatch(ctx, parsed.event);
    }
  } catch (err) {
    failure = message(err);
  }

  const stamp = await db
    .from('pbx_events_raw')
    .update(
      failure
        ? { error: failure.slice(0, 2000) }
        : { processed_at: new Date().toISOString(), error: null }
    )
    .eq('id', rawId);
  if (stamp.error) {
    console.error(`[pbx] event ${rawId}: stamp failed: ${stamp.error.message}`);
  }
  if (failure)
    console.warn(`[pbx] event ${rawId} on ${connectionId}: ${failure}`);
  if (conn) {
    // A delivery proves the push works; a refused API login stays shown.
    const touch = await db
      .from('pbx_connections')
      .update({
        last_event_at: receivedAt,
        ...(conn.status === 'auth_failed' ? {} : { status: 'connected' }),
      })
      .eq('id', connectionId);
    if (touch.error) {
      console.error(
        `[pbx] ${connectionId}: last_event_at: ${touch.error.message}`
      );
    }
  }
  return { duplicate: false, kind, ...(failure ? { error: failure } : {}) };
}

interface Ctx {
  db: SupabaseClient;
  connectionId: string;
  connectionAccountId: string;
  receivedAt: string;
}

async function dispatch(ctx: Ctx, event: YeastarEvent): Promise<void> {
  switch (event.kind) {
    case 'call_state':
      return onCallState(ctx, event);
    case 'call_end':
      return onCallEnd(ctx, event);
    case 'presence':
      return writePresence(ctx, event.extension, { presence: event.presence });
    case 'extension_call_state':
      return writePresence(ctx, event.extension, { call_state: event.status });
    case 'registration': {
      const { error } = await ctx.db
        .from('pbx_extensions')
        .update({
          registration_state: event.status,
          client_kind: event.status === 'registered' ? event.client : null,
        })
        .eq('connection_id', ctx.connectionId)
        .eq('extension', event.extension);
      if (error) fail('pbx_extensions update', error);
      return;
    }
    default:
      return; // webhook_test, unknown: stored, nothing to do
  }
}

interface ExtensionRow {
  extension: string;
  account_id: string;
  user_id: string | null;
  presence_monitor: boolean;
}

async function extensionsOf(
  ctx: Ctx,
  numbers: (string | null | undefined)[]
): Promise<Map<string, ExtensionRow>> {
  const wanted = unique(numbers);
  if (wanted.length === 0) return new Map();
  const { data, error } = await ctx.db
    .from('pbx_extensions')
    .select('extension, account_id, user_id, presence_monitor')
    .eq('connection_id', ctx.connectionId)
    .in('extension', wanted);
  if (error) fail('pbx_extensions read', error);
  return new Map(((data ?? []) as ExtensionRow[]).map((e) => [e.extension, e]));
}

async function writePresence(
  ctx: Ctx,
  extension: string,
  patch: { presence?: string; call_state?: string }
): Promise<void> {
  const ext = (await extensionsOf(ctx, [extension])).get(extension);
  const key = { connection_id: ctx.connectionId, extension };
  if (ext?.presence_monitor === false) {
    // The team should not see this person's status: keep none.
    const { error } = await ctx.db
      .from('pbx_presence')
      .delete()
      .eq('connection_id', ctx.connectionId)
      .eq('extension', extension);
    if (error) fail('pbx_presence delete', error);
    return;
  }
  const { error } = await ctx.db.from('pbx_presence').upsert(
    {
      ...key,
      account_id: ext?.account_id ?? ctx.connectionAccountId,
      user_id: ext?.user_id ?? null,
      ...patch,
    },
    { onConflict: 'connection_id,extension' }
  );
  if (error) fail('pbx_presence upsert', error);
}

interface Workspace {
  accountId: string;
  didNumber: string | null;
  unrouted: boolean;
}

async function resolveWorkspace(
  ctx: Ctx,
  direction: CallDirection,
  didRaw: string | null | undefined,
  extensionAccounts: (string | undefined)[]
): Promise<Workspace> {
  const did = didRaw ? digitsOnly(didRaw) || null : null;
  if (direction === 'inbound' && did) {
    const { data, error } = await ctx.db
      .from('pbx_did_routes')
      .select('did_number, account_id')
      .eq('connection_id', ctx.connectionId);
    if (error) fail('pbx_did_routes read', error);
    const routes = (data ?? []) as { did_number: string; account_id: string }[];
    const intl = normalizeRemoteNumber(did)?.number;
    const route =
      routes.find((r) => r.did_number === did) ??
      routes.find((r) => normalizeRemoteNumber(r.did_number)?.number === intl);
    if (route) {
      return {
        accountId: route.account_id,
        didNumber: route.did_number,
        unrouted: false,
      };
    }
    console.warn(
      `[pbx] ${ctx.connectionId}: inbound call to unrouted number ${did}; filed under the connection's own workspace`
    );
    return {
      accountId: ctx.connectionAccountId,
      didNumber: did,
      unrouted: true,
    };
  }
  return {
    accountId: extensionAccounts.find(Boolean) ?? ctx.connectionAccountId,
    didNumber: did,
    unrouted: false,
  };
}

interface ContactMatch {
  contactId: string | null;
  name: string | null;
  conversationId: string | null;
  candidates: string[];
}
const NO_MATCH: ContactMatch = {
  contactId: null,
  name: null,
  conversationId: null,
  candidates: [],
};

/** Contacts of `accountId` only: a number is never matched across workspaces. */
async function matchContact(
  ctx: Ctx,
  accountId: string,
  remote: RemoteNumber | null
): Promise<ContactMatch> {
  if (!remote || remote.internal) return NO_MATCH;
  const exact = await ctx.db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .in('phone_normalized', contactPhoneCandidates(remote.number))
    .limit(10);
  if (exact.error) fail('contacts read', exact.error);
  let found = (exact.data ?? []) as {
    id: string;
    name: string | null;
    phone: string;
  }[];
  if (found.length === 0 && remote.number.length >= 8) {
    const loose = await ctx.db
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', accountId)
      .like('phone_normalized', `%${remote.number.slice(-8)}`)
      .limit(10);
    if (loose.error) fail('contacts read', loose.error);
    found = ((loose.data ?? []) as typeof found).filter((c) =>
      phonesMatch(c.phone, remote.number)
    );
  }
  if (found.length !== 1) {
    return { ...NO_MATCH, candidates: found.map((c) => c.id) };
  }
  const conv = await ctx.db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', found[0].id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (conv.error) fail('conversations read', conv.error);
  return {
    contactId: found[0].id,
    name: found[0].name,
    conversationId: ((conv.data ?? []) as { id: string }[])[0]?.id ?? null,
    candidates: [],
  };
}

async function readCall(ctx: Ctx, callId: string): Promise<Row | null> {
  const { data, error } = await ctx.db
    .from('calls')
    .select(CALL_COLUMNS)
    .eq('connection_id', ctx.connectionId)
    .eq('pbx_call_id', callId)
    .maybeSingle();
  if (error) fail('calls read', error);
  return (data as Row | null) ?? null;
}

async function deleteLive(ctx: Ctx, callId: string): Promise<void> {
  const { error } = await ctx.db
    .from('call_live')
    .delete()
    .eq('connection_id', ctx.connectionId)
    .eq('pbx_call_id', callId);
  if (error) fail('call_live delete', error);
}

function directionOf(members: CallMember[]): CallDirection {
  if (members.some((m) => m.kind === 'inbound')) return 'inbound';
  if (members.some((m) => m.kind === 'outbound')) return 'outbound';
  return 'internal';
}

function callMeta(
  existing: Row | null,
  ws: Workspace,
  match: ContactMatch
): Row {
  const meta: Row = isRecord(existing?.meta) ? { ...existing.meta } : {};
  if (match.candidates.length > 1) meta.contact_candidates = match.candidates;
  else if (match.contactId) delete meta.contact_candidates;
  if (ws.unrouted) meta.unrouted = true;
  return meta;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Who an inbound call rang, first rung first (calls.meta.rang_user_ids):
 * the customer page's "rang Sara and Faisal". call_live holds only the
 * frame in hand and is gone once a frame says BYE, so each frame adds
 * to the row's list and the end keeps it.
 */
function rangOf(meta: unknown): string[] {
  return isRecord(meta) && Array.isArray(meta.rang_user_ids)
    ? meta.rang_user_ids.filter((u): u is string => typeof u === 'string')
    : [];
}
const withRang = (meta: Row, rang: string[]): Row =>
  rang.length ? { ...meta, rang_user_ids: rang } : meta;

/** 30011: the screen pop (call_live) and a non-final calls row. */
async function onCallState(ctx: Ctx, ev: CallStateEvent): Promise<void> {
  if (ev.members.length === 0) return;
  if (ev.members.every((m) => m.status.toUpperCase() === 'BYE')) {
    return deleteLive(ctx, ev.callId);
  }
  const existing = await readCall(ctx, ev.callId);
  // Ended already (a late or re-sent frame): never reopen it.
  if (existing && !LIVE.includes(existing.status as CallStatus)) return;

  const extNumbers = unique(
    ev.members.map((m) => (m.kind === 'extension' ? m.number : null))
  );
  const exts = await extensionsOf(ctx, extNumbers);
  const ringing = ringingExtensions(ev);
  const answered = ev.members
    .filter(
      (m) =>
        m.kind === 'extension' &&
        m.number &&
        ANSWERED.has(m.status.toUpperCase())
    )
    .map((m) => m.number as string);
  const direction =
    (str(existing?.direction) as CallDirection | null) ??
    directionOf(ev.members);
  const ourExt =
    answered[0] ?? (direction === 'inbound' ? undefined : extNumbers[0]);
  const peerExt =
    direction === 'internal' ? extNumbers.find((n) => n !== ourExt) : undefined;
  const didRaw = ev.members.find((m) => m.kind === 'inbound')?.to;
  const ws: Workspace = existing
    ? {
        accountId: String(existing.account_id),
        didNumber: str(existing.did_number),
        unrouted: false,
      }
    : await resolveWorkspace(
        ctx,
        direction,
        didRaw,
        [...answered, ...ringing, ...extNumbers].map(
          (n) => exts.get(n)?.account_id
        )
      );
  const rawRemote = direction === 'internal' ? null : remoteParty(ev);
  const remote = normalizeRemoteNumber(rawRemote);
  const match: ContactMatch =
    direction === 'internal'
      ? NO_MATCH
      : existing
        ? {
            ...NO_MATCH,
            contactId: str(existing.contact_id),
            conversationId: str(existing.conversation_id),
            candidates:
              isRecord(existing.meta) &&
              Array.isArray(existing.meta.contact_candidates)
                ? (existing.meta.contact_candidates as string[])
                : [],
          }
        : await matchContact(ctx, ws.accountId, remote);

  const answeredBy =
    unique(answered.map((n) => exts.get(n)?.user_id))[0] ?? null;
  const ringingUsers = unique(ringing.map((n) => exts.get(n)?.user_id));
  const live = {
    connection_id: ctx.connectionId,
    pbx_call_id: ev.callId,
    account_id: ws.accountId,
    contact_id: match.contactId,
    remote_number: remote?.number ?? null,
    did_number: ws.didNumber,
    ringing_user_ids: ringingUsers,
    answered_by: answeredBy,
    // Several matching contacts ride on the customer's leg for a person to pick.
    members: ev.members.map((m) =>
      match.candidates.length > 1 &&
      m.kind !== 'extension' &&
      (m.from === rawRemote || m.to === rawRemote)
        ? { ...m, contactCandidates: match.candidates }
        : m
    ),
    state: answered.length
      ? 'answered'
      : ringing.length
        ? 'ringing'
        : 'in_progress',
    updated_at: ctx.receivedAt,
  };
  const liveWrite = await ctx.db
    .from('call_live')
    .upsert(live, { onConflict: 'connection_id,pbx_call_id' });
  if (liveWrite.error) fail('call_live upsert', liveWrite.error);

  const status: CallStatus =
    answered.length || existing?.status === 'in_progress'
      ? 'in_progress'
      : 'ringing';
  const party = ourExt
    ? { extension: ourExt, user_id: exts.get(ourExt)?.user_id ?? null }
    : {};
  const peer = peerExt
    ? { peer_user_id: exts.get(peerExt)?.user_id ?? null }
    : {};
  const answeredAt =
    answered.length && !existing?.answered_at
      ? { answered_at: ctx.receivedAt }
      : {};
  if (!existing) {
    const ins = await ctx.db
      .from('calls')
      .upsert(
        {
          account_id: ws.accountId,
          connection_id: ctx.connectionId,
          pbx_call_id: ev.callId,
          direction,
          remote_number: remote?.number ?? null,
          contact_id: match.contactId,
          conversation_id: match.contactId ? match.conversationId : null,
          did_number: ws.didNumber,
          status,
          started_at: ctx.receivedAt,
          meta: withRang(
            callMeta(null, ws, match),
            direction === 'inbound' ? ringingUsers : []
          ),
          ...party,
          ...peer,
          ...answeredAt,
        },
        { onConflict: 'connection_id,pbx_call_id', ignoreDuplicates: true }
      )
      .select('id');
    if (ins.error) fail('calls insert', ins.error);
    if ((ins.data as unknown[] | null)?.length) return;
  }
  // Someone new rang: add them to the row's list. Only over a row read
  // here, so a lost insert race never overwrites that row's meta.
  const rangBefore = rangOf(existing?.meta);
  const rang =
    direction === 'inbound'
      ? unique([...rangBefore, ...ringingUsers])
      : rangBefore;
  const rangMeta =
    existing && rang.length > rangBefore.length
      ? { meta: withRang(isRecord(existing.meta) ? existing.meta : {}, rang) }
      : {};
  // Compare-and-set on a live status: a 30012 that landed first wins.
  const upd = await ctx.db
    .from('calls')
    .update({ status, ...party, ...peer, ...answeredAt, ...rangMeta })
    .eq('connection_id', ctx.connectionId)
    .eq('pbx_call_id', ev.callId)
    .in('status', LIVE);
  if (upd.error) fail('calls update', upd.error);
}

function bankCandidates(remote: RemoteNumber | null, raw: string): string[] {
  if (!remote || remote.internal) return [];
  const n = remote.number;
  return unique([
    n,
    ...contactPhoneCandidates(n),
    digitsOnly(raw) || null,
    n.startsWith('971') ? `0${n.slice(3)}` : null,
  ]);
}

interface Settings {
  exclude_bank_numbers: boolean;
  missed_call_due_minutes: number;
  store_recordings: boolean;
}

async function settingsOf(ctx: Ctx, accountId: string): Promise<Settings> {
  const { data, error } = await ctx.db
    .from('pbx_settings')
    .select('exclude_bank_numbers, missed_call_due_minutes, store_recordings')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) fail('pbx_settings read', error);
  const s = (data ?? {}) as Partial<Settings>;
  return {
    exclude_bank_numbers: s.exclude_bank_numbers ?? true,
    missed_call_due_minutes: s.missed_call_due_minutes ?? 30,
    // Migration 090: no row stores recordings.
    store_recordings: s.store_recordings ?? true,
  };
}

const plusSeconds = (iso: string, s: number) =>
  new Date(Date.parse(iso) + s * 1000).toISOString();

/** 30012: the final calls row, the screen pop gone, a missed-call task. */
async function onCallEnd(ctx: Ctx, ev: CallEndEvent): Promise<void> {
  const existing = await readCall(ctx, ev.callId);
  const liveRead = await ctx.db
    .from('call_live')
    .select('ringing_user_ids, did_number')
    .eq('connection_id', ctx.connectionId)
    .eq('pbx_call_id', ev.callId)
    .maybeSingle();
  if (liveRead.error) fail('call_live read', liveRead.error);
  const liveRow = liveRead.data as {
    ringing_user_ids?: string[];
    did_number?: string | null;
  } | null;

  const direction: CallDirection =
    ev.direction ??
    (str(existing?.direction) as CallDirection | null) ??
    'inbound';
  const ourRaw = direction === 'inbound' ? ev.to : ev.from;
  const otherRaw = direction === 'inbound' ? ev.from : ev.to;
  const exts = await extensionsOf(ctx, [
    ourRaw,
    direction === 'internal' ? otherRaw : null,
    str(existing?.extension),
  ]);
  // A ring group's number is no one's: keep the extension that answered.
  const extension = exts.has(ourRaw)
    ? ourRaw
    : (str(existing?.extension) ?? (ourRaw || null));
  const userId =
    (extension ? exts.get(extension)?.user_id : null) ?? str(existing?.user_id);
  const ws: Workspace = existing
    ? {
        accountId: String(existing.account_id),
        didNumber: str(existing.did_number),
        unrouted: false,
      }
    : await resolveWorkspace(
        ctx,
        direction,
        ev.didNumber ?? liveRow?.did_number,
        [extension ? exts.get(extension)?.account_id : undefined]
      );
  const remote =
    direction === 'internal' ? null : normalizeRemoteNumber(otherRaw);
  const match: ContactMatch =
    direction === 'internal'
      ? NO_MATCH
      : existing?.contact_id
        ? {
            ...NO_MATCH,
            contactId: str(existing.contact_id),
            conversationId: str(existing.conversation_id),
          }
        : await matchContact(ctx, ws.accountId, remote);

  const status = END_STATUS[ev.status] ?? 'failed';
  const talk = Math.round(ev.talkSeconds);
  const ring = Math.max(0, Math.round(ev.callSeconds) - talk);
  const startedAt =
    ev.startedAt ??
    str(existing?.started_at) ??
    plusSeconds(ctx.receivedAt, -ev.callSeconds);
  const settings = await settingsOf(ctx, ws.accountId);
  // Everyone it rang: the frames' list, the last frame's ringing (when
  // its live row is still here) and a direct-dialled extension's person.
  const rang =
    direction === 'inbound'
      ? unique([
          ...rangOf(existing?.meta),
          ...(liveRow?.ringing_user_ids ?? []),
          extension ? exts.get(extension)?.user_id : null,
        ])
      : [];

  let recording: Row = {};
  if (
    ev.recordingFile &&
    (!existing || (existing.recording_state ?? 'none') === 'none')
  ) {
    let held = false;
    const numbers = settings.exclude_bank_numbers
      ? bankCandidates(remote, otherRaw)
      : [];
    if (numbers.length) {
      const bank = await ctx.db
        .from('pbx_bank_numbers')
        .select('number')
        .eq('account_id', ws.accountId)
        .in('number', numbers)
        .limit(1);
      if (bank.error) fail('pbx_bank_numbers read', bank.error);
      held = ((bank.data ?? []) as unknown[]).length > 0;
    }
    recording = {
      // Bank-held first, then the workspace's pause on storing (090),
      // which changes nothing on the PBX: it keeps recording.
      recording_state: held
        ? 'held'
        : settings.store_recordings
          ? 'pending'
          : 'not_stored',
      recording_file: ev.recordingFile,
    };
  }

  const written = await ctx.db
    .from('calls')
    .upsert(
      {
        account_id: ws.accountId,
        connection_id: ctx.connectionId,
        pbx_call_id: ev.callId,
        pbx_uid: ev.uid,
        direction,
        remote_number:
          direction === 'internal' ? null : (remote?.number ?? null),
        extension,
        user_id: userId,
        peer_user_id:
          direction === 'internal'
            ? (exts.get(otherRaw)?.user_id ?? str(existing?.peer_user_id))
            : (str(existing?.peer_user_id) ?? null),
        contact_id: match.contactId,
        conversation_id: match.contactId ? match.conversationId : null,
        did_number: ws.didNumber,
        status,
        started_at: startedAt,
        answered_at:
          status === 'answered'
            ? (str(existing?.answered_at) ?? plusSeconds(startedAt, ring))
            : (str(existing?.answered_at) ?? null),
        ended_at: ev.startedAt
          ? plusSeconds(startedAt, ev.callSeconds)
          : ctx.receivedAt,
        ring_seconds: ring,
        talk_seconds: talk,
        meta: withRang(callMeta(existing, ws, match), rang),
        ...recording,
      },
      { onConflict: 'connection_id,pbx_call_id' }
    )
    .select('id');
  if (written.error) fail('calls upsert', written.error);
  const callRowId = String(
    ((written.data ?? []) as { id: unknown }[])[0]?.id ?? existing?.id
  );
  await deleteLive(ctx, ev.callId);
  // A call the cron placed for a call-back settles its request.
  await settleCallbackCall(ctx.db, {
    accountId: ws.accountId,
    pbxCallId: ev.callId,
    answered: ANSWERED.has(ev.status),
    status: ev.status,
  });

  // Only here: a ring-group call a colleague answered is not missed.
  if (!isMissedCallEnd(ev)) return;
  let owner =
    match.contactId || match.conversationId
      ? await resolveTaskOwner(ctx.db, ws.accountId, {
          contactId: match.contactId,
          conversationId: match.conversationId,
        })
      : null;
  if (!owner) {
    const rung = rang;
    if (rung.length) {
      const { data, error } = await ctx.db
        .from('profiles')
        .select('user_id, account_role')
        .eq('account_id', ws.accountId)
        .in('user_id', rung)
        .is('deactivated_at', null);
      if (error) fail('profiles read', error);
      const ok = new Set(
        ((data ?? []) as { user_id: string; account_role: string }[])
          .filter((p) => TASK_HOLDERS.includes(p.account_role))
          .map((p) => p.user_id)
      );
      owner = rung.find((u) => ok.has(u)) ?? null;
    }
  }
  let name = match.name;
  if (!name && match.contactId) {
    const c = await ctx.db
      .from('contacts')
      .select('name')
      .eq('account_id', ws.accountId)
      .eq('id', match.contactId)
      .maybeSingle();
    if (c.error) fail('contacts read', c.error);
    name = str((c.data as Row | null)?.name);
  }
  const who =
    name?.trim() ||
    (remote
      ? remote.internal
        ? remote.number
        : `+${remote.number}`
      : 'an unknown caller');
  const title = `Call back ${who}`;
  const task = await createSystemTask(ctx.db, {
    accountId: ws.accountId,
    kind: 'missed_call',
    title,
    note: `Missed call (${ev.status.toLowerCase()})${ws.didNumber ? ` on ${ws.didNumber}` : ''}.`,
    contactId: match.contactId,
    conversationId: match.contactId ? match.conversationId : null,
    assignedTo: owner,
    dueAt: plusSeconds(ctx.receivedAt, settings.missed_call_due_minutes * 60),
    source: 'pbx',
    sourceRef: `call:${callRowId}`,
    meta: { call_id: callRowId, did_number: ws.didNumber },
  });
  if (!task.created || !owner) return;
  const bell = await ctx.db.from('notifications').insert({
    account_id: ws.accountId,
    user_id: owner,
    type: 'call_missed',
    contact_id: match.contactId,
    conversation_id: match.contactId ? match.conversationId : null,
    actor_user_id: null,
    title: `Missed call: ${who}`,
    body: null,
    meta: { call_id: callRowId, contact_id: match.contactId, task_id: task.id },
  });
  // Best effort: the task is the record; a lost bell must not fail the event.
  if (bell.error)
    console.error(
      `[pbx] call ${callRowId}: bell not saved: ${bell.error.message}`
    );
}
