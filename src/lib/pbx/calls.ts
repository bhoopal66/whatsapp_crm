import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canViewUnroutedCalls, type AccountRole } from '@/lib/auth/roles';
import { PbxConnectionError } from './connection';
import { contactPhoneCandidates, normalizeRemoteNumber } from './phone';
import { YeastarError, type CallInfo, type CallMember } from './yeastar';
import {
  isMissedCall,
  type CallDirection,
  type CallStatus,
} from './call-status';

// The call screens' helpers (module 015, migration 089): pure rules
// first, then the few lookups the /api/pbx/calls routes share.

// The pure call-status rules live in ./call-status, which the browser
// can import; this file pulls in next/server.
export {
  CALL_STATUSES,
  MISSED_STATUSES,
  isMissedCall,
  type CallDirection,
  type CallStatus,
} from './call-status';

/** The calls.disposition CHECK; pbx_set_disposition checks the same. */
export const DISPOSITIONS = [
  'interested',
  'docs_requested',
  'call_back',
  'not_eligible',
  'wrong_number',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const NOTES_MAX = 4000;

/** Ranks from lib/auth/roles.ts: team leader and admin. */
export const RANK_LEADER = 3;
export const RANK_ADMIN = 4;

const STATUS_LABELS: Record<CallStatus, string> = {
  ringing: 'Ringing',
  in_progress: 'In progress',
  answered: 'Answered',
  no_answer: 'No answer',
  busy: 'Busy',
  voicemail: 'Voicemail',
  abandoned: 'Abandoned',
  failed: 'Failed',
};
const DIRECTION_LABELS: Record<CallDirection, string> = {
  inbound: 'Incoming',
  outbound: 'Outgoing',
  internal: 'Internal',
};

export function callStatusLabel(status: string): string {
  return STATUS_LABELS[status as CallStatus] ?? status;
}

export function callDirectionLabel(direction: string): string {
  return DIRECTION_LABELS[direction as CallDirection] ?? direction;
}

// ---------- Presence ----------

// The pure presence rules live in ./presence (client-safe); re-exported
// here for the server code that already imports them from calls.
export {
  PRESENCE_STALE_MS,
  presenceByUser,
  presenceView,
  type PresenceRow,
  type PresenceView,
  type UserPresence,
} from './presence';

// ---------- "Calls this month" ----------

/** The workspace's zone when the client names none (the UAE's). */
export const DEFAULT_TIME_ZONE = 'Asia/Dubai';

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wallClock(at: number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, Number(x.value)])
  ) as Record<string, number>;
  return p;
}

function zoneOffsetMs(at: number, timeZone: string): number {
  const p = wallClock(at, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Midnight on the 1st of `now`'s month, in `timeZone`, as an instant. */
export function monthStart(now: Date, timeZone = 'UTC'): Date {
  const p = wallClock(now.getTime(), timeZone);
  const guess = Date.UTC(p.year, p.month - 1, 1);
  const first = guess - zoneOffsetMs(guess, timeZone);
  // Again from the first estimate, for a DST change between the two.
  return new Date(guess - zoneOffsetMs(first, timeZone));
}

export interface MonthSummary {
  total: number;
  answered: number;
  missed: number;
  talkSeconds: number;
}

export function summarizeMonth(
  rows: {
    direction: string;
    status: string;
    answered_at?: string | null;
    talk_seconds?: number | null;
  }[]
): MonthSummary {
  const out: MonthSummary = {
    total: 0,
    answered: 0,
    missed: 0,
    talkSeconds: 0,
  };
  for (const r of rows) {
    out.total += 1;
    if (r.status === 'answered' || r.answered_at) out.answered += 1;
    else if (isMissedCall(r)) out.missed += 1;
    out.talkSeconds += r.talk_seconds ?? 0;
  }
  return out;
}

// ---------- Do-not-contact ----------

export const OVERRIDE_REASON_MAX = 500;

export type DncDecision =
  { kind: 'allow' } | { kind: 'refuse' } | { kind: 'override'; reason: string };

/**
 * A do-not-contact customer is never called, except by an owner or
 * admin who gives a reason (the route logs it in pbx_audit first).
 */
export function dncDecision(input: {
  doNotContact: boolean;
  rank: number;
  overrideReason?: string | null;
}): DncDecision {
  if (!input.doNotContact) return { kind: 'allow' };
  const reason = (input.overrideReason ?? '').trim();
  if (input.rank >= RANK_ADMIN && reason) return { kind: 'override', reason };
  return { kind: 'refuse' };
}

// ---------- Recordings ----------

/** The private bucket (089): no client storage policy names it. */
export const RECORDINGS_BUCKET = 'call-recordings';
/** How long a signed play / download link lives. */
export const RECORDING_LINK_SECONDS = 300;
export type RecordingAccess = 'play' | 'download' | 'attach';

/**
 * A deal file's name for an attached recording, "Call recording
 * 2026-10-12 Ahmed Ali": the call's day in `timeZone`, then who was
 * called, within deal_files.name's 255 characters.
 */
export function recordingFileName(
  startedAt: string,
  who: string | null,
  timeZone = DEFAULT_TIME_ZONE
): string {
  const at = new Date(startedAt);
  const day = Number.isFinite(at.getTime())
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(at)
    : '';
  const name = ['Call recording', day, who?.trim()].filter(Boolean).join(' ');
  return Array.from(name).slice(0, 255).join('');
}

/** What a refused recording is, for the player (timeline.ts refusalView). */
export type RecordingRefusalCode =
  'expired' | 'erased' | 'not_stored' | 'held' | 'none';

/**
 * A refused recording, by the call's state; `expired` when the retention
 * period deleted the audio (the recording row's erased_at, migration
 * 093), which leaves the call itself 'fetched'.
 */
export function recordingRefusalCode(
  state: string,
  expired = false
): RecordingRefusalCode {
  if (expired) return 'expired';
  switch (state) {
    case 'erased':
      return 'erased';
    case 'not_stored':
      return 'not_stored';
    case 'fetched':
    case 'held':
      return 'held';
    default:
      return 'none';
  }
}

/** Why the access log refused a recording: {@link recordingRefusalCode}. */
export function recordingRefusal(state: string, expired = false): string {
  switch (recordingRefusalCode(state, expired)) {
    case 'expired':
      return 'This recording was deleted under the retention period';
    case 'erased':
      return 'This recording was erased';
    case 'not_stored':
      return 'This recording was not stored in the CRM';
    case 'held':
      return 'Recording held until the notice is confirmed';
    default:
      return 'This call has no recording yet';
  }
}

/** The 409 for a refused recording: its wording, and `code` for the player. */
export const recordingRefused = (state: string, expired = false) =>
  fail(recordingRefusal(state, expired), 409, {
    code: recordingRefusalCode(state, expired),
  });

// ---------- Call control ----------

export const CALL_ACTIONS = [
  'hangup',
  'hold',
  'unhold',
  'mute',
  'unmute',
  'transfer',
] as const;
export type CallAction = (typeof CALL_ACTIONS)[number];

export function isCallAction(value: string): value is CallAction {
  return (CALL_ACTIONS as readonly string[]).includes(value);
}

/**
 * The caller's own leg of a live call, from `queryCalls({ extension })`,
 * and the legs still connected beside it. Null unless the PBX lists the
 * caller's extension as a member of exactly that call.
 */
export function myLeg(
  calls: CallInfo[],
  pbxCallId: string,
  extension: string
): { mine: CallMember; others: CallMember[] } | null {
  const call = calls.find((c) => c.callId === pbxCallId);
  const mine = call?.members.find(
    (m) => m.kind === 'extension' && m.number === extension
  );
  if (!call || !mine) return null;
  return {
    mine,
    others: call.members.filter(
      (m) => m.channelId !== mine.channelId && m.status.toUpperCase() !== 'BYE'
    ),
  };
}

const isGone = (m: CallMember) => m.status.toUpperCase() === 'BYE';

/**
 * {@link myLeg}, counting only legs still on the call: a leg that left
 * (BYE, e.g. after the caller transferred the customer away) controls
 * nothing, and the call's remaining parties are no longer theirs.
 */
export function myLiveLeg(
  calls: CallInfo[],
  pbxCallId: string,
  extension: string
): { mine: CallMember; others: CallMember[] } | null {
  const call = calls.find((c) => c.callId === pbxCallId);
  if (!call) return null;
  const live = { ...call, members: call.members.filter((m) => !isGone(m)) };
  return myLeg([live], pbxCallId, extension);
}

/**
 * The channel a blind transfer moves. The PBX moves the member whose
 * channel it is given (api.ts), so it is the party at the other end of
 * the caller's leg: the one outside line (the customer) if there is one,
 * else the one other extension. Null when nobody else is on the call or
 * it is ambiguous (a conference, a ring group still ringing).
 */
export function blindTransferChannel(others: CallMember[]): string | null {
  const trunks = others.filter((m) => m.kind !== 'extension');
  if (trunks.length === 1) return trunks[0].channelId;
  if (!trunks.length && others.length === 1) return others[0].channelId;
  return null;
}

// ---------- Call outcome ----------

export interface OutcomePatch {
  disposition?: Disposition | null;
  notes?: string | null;
}

/**
 * `{ disposition?, notes? }` as pbx_set_disposition will judge it: a
 * known disposition or null, notes as text or null, at most NOTES_MAX
 * characters once btrim'd (spaces only, as SQL's btrim). An omitted
 * field is absent from the result, for the route to keep its value.
 */
export function parseOutcome(
  b: Record<string, unknown>
): OutcomePatch | string {
  const out: OutcomePatch = {};
  if (b.disposition !== undefined) {
    if (
      b.disposition !== null &&
      !(DISPOSITIONS as readonly unknown[]).includes(b.disposition)
    )
      return `disposition must be one of ${DISPOSITIONS.join(', ')}, or null`;
    out.disposition = b.disposition as Disposition | null;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== 'string')
      return 'notes must be text or null';
    if (
      typeof b.notes === 'string' &&
      Array.from(b.notes.replace(/^ +| +$/g, '')).length > NOTES_MAX
    )
      return `Notes are limited to ${NOTES_MAX} characters`;
    out.notes = b.notes;
  }
  return Object.keys(out).length ? out : 'Nothing to change';
}

// ---------- Call lists ----------

export const CALL_SCOPES = ['mine', 'missed', 'all', 'unrouted'] as const;
export type CallScope = (typeof CALL_SCOPES)[number];
export const CALL_LIST_LIMIT = 50;
export const CALL_LIST_MAX = 200;

/**
 * Whether `role` may list `scope`. unrouted (inbound calls to a dialled
 * number with no route, calls.meta.unrouted) is owner/admin only, as
 * canViewUnroutedCalls; every other scope is every reader's, RLS
 * choosing the rows.
 */
export function canListCallScope(role: AccountRole, scope: CallScope): boolean {
  return scope !== 'unrouted' || canViewUnroutedCalls(role);
}

/** A dialled number with no route, as the Unrouted view sums it up. */
export interface UnroutedNumber {
  /** As the calls kept it (calls.did_number). */
  didNumber: string;
  calls: number;
  /** The latest of those calls' started_at. */
  lastAt: string;
}

/**
 * The distinct dialled numbers among unrouted calls, with how many
 * calls each took and the latest: most calls first, then the most
 * recent. A call that kept no dialled number has nothing to route and
 * is left out.
 */
export function unroutedNumbers(
  rows: readonly { did_number: string | null; started_at: string }[]
): UnroutedNumber[] {
  const by = new Map<string, UnroutedNumber>();
  for (const r of rows) {
    if (!r.did_number) continue;
    const n = by.get(r.did_number);
    if (!n)
      by.set(r.did_number, {
        didNumber: r.did_number,
        calls: 1,
        lastAt: r.started_at,
      });
    else {
      n.calls += 1;
      if (Date.parse(r.started_at) > Date.parse(n.lastAt))
        n.lastAt = r.started_at;
    }
  }
  return [...by.values()].sort(
    (a, b) =>
      b.calls - a.calls ||
      Date.parse(b.lastAt) - Date.parse(a.lastAt) ||
      a.didNumber.localeCompare(b.didNumber)
  );
}

export interface CallListQuery {
  contactId: string | null;
  scope: CallScope;
  /** ISO instants: started_at >= from, < to. */
  from: string | null;
  to: string | null;
  limit: number;
}

/** `?contactId=&scope=&from=&to=&limit=`, checked; a string is the 400. */
export function parseCallListQuery(q: URLSearchParams): CallListQuery | string {
  const contactId = q.get('contactId') || null;
  if (contactId && !UUID.test(contactId)) return 'contactId must be an id';
  const scope = q.get('scope') || 'all';
  if (!(CALL_SCOPES as readonly string[]).includes(scope))
    return `scope must be one of ${CALL_SCOPES.join(', ')}`;
  const instant = (key: 'from' | 'to') => {
    const v = q.get(key);
    if (!v) return null;
    const at = Date.parse(v);
    return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
  };
  const from = instant('from');
  const to = instant('to');
  if (from === undefined || to === undefined)
    return 'from and to must be dates';
  const limit = q.get('limit') ? Number(q.get('limit')) : CALL_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > CALL_LIST_MAX)
    return `limit must be a whole number from 1 to ${CALL_LIST_MAX}`;
  return { contactId, scope: scope as CallScope, from, to, limit };
}

// ---------- Shared lookups (route side) ----------

/** The request's JSON object body, or null for anything else. */
export async function jsonObject(
  request: Request
): Promise<Record<string, unknown> | null> {
  const b: unknown = await request.json().catch(() => null);
  return typeof b === 'object' && b !== null && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : null;
}

/** The PBX's address for the Linkus SDK, without a trailing slash. */
export const pbxUrl = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '');

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const fail = (error: string, status = 400, extra?: object) =>
  NextResponse.json({ error, ...extra }, { status });

export interface MyExtension {
  connectionId: string;
  extension: string;
  softphoneEnabled: boolean;
}

/** The caller's own mapping in the active workspace (agent and up). */
export async function myExtension(
  rls: SupabaseClient
): Promise<MyExtension | null> {
  const { data, error } = await rls.rpc('pbx_my_extension');
  if (error) throw new Error(`pbx_my_extension failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        connection_id?: string;
        extension?: string;
        softphone_enabled?: boolean;
      }
    | null
    | undefined;
  if (!row?.connection_id || !row.extension) return null;
  return {
    connectionId: row.connection_id,
    extension: row.extension,
    softphoneEnabled: row.softphone_enabled === true,
  };
}

export interface VisibleCall {
  id: string;
  account_id: string;
  recording_state: string;
  started_at: string;
  /** When the CRM first recorded the call: retention's other clock (093). */
  created_at?: string;
  contact_id: string | null;
  remote_number: string | null;
}

/** The call as the caller's client shows it (pbx_can_view_call), or null. */
export async function visibleCall(
  rls: SupabaseClient,
  id: string
): Promise<VisibleCall | null> {
  const { data, error } = await rls
    .from('calls')
    .select(
      'id, account_id, recording_state, started_at, created_at, contact_id, remote_number'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`calls read failed: ${error.message}`);
  return data as VisibleCall | null;
}

/**
 * Writes a recording access to call_access_log on the service role
 * (`authenticated` has no INSERT), before anything about the audio is
 * read or signed. The log's guard refuses the row unless
 * pbx_recording_playable() (fetched, not erased, the notice confirmed):
 * that refusal is a 409 worded by the call's state, or, when the
 * recording row's erased_at is set, as deleted under the retention
 * period (093 marks the row and leaves the call 'fetched'). Null when
 * written.
 */
export async function logRecordingAccess(
  service: SupabaseClient,
  call: VisibleCall,
  userId: string,
  action: RecordingAccess
): Promise<NextResponse | null> {
  const { error } = await service.from('call_access_log').insert({
    call_id: call.id,
    account_id: call.account_id,
    user_id: userId,
    action,
  });
  if (!error) return null;
  if (error.code !== '55000')
    throw new Error(`call_access_log insert failed: ${error.message}`);
  // Only the wording depends on this read: unread, the state words it.
  const rec = await service
    .from('call_recordings')
    .select('erased_at')
    .eq('call_id', call.id)
    .eq('account_id', call.account_id)
    .maybeSingle();
  const expired = !!(rec.data as { erased_at?: string | null } | null)
    ?.erased_at;
  return recordingRefused(call.recording_state, expired);
}

export const noExtension = () =>
  fail('You have no phone extension in this workspace', 409, {
    code: 'no_extension',
  });

/** The PBX side of a failure, worded without anything stored. */
export function pbxFailure(err: unknown): NextResponse | null {
  if (err instanceof PbxConnectionError) {
    switch (err.code) {
      case 'no_sdk_credentials':
        return fail('The softphone is not set up on this phone system', 409, {
          code: 'no_sdk_credentials',
        });
      case 'auth_backoff':
        return fail(
          'The phone system refused its credentials; try again in a few minutes',
          503
        );
      default:
        return fail('The phone system is not connected', 503);
    }
  }
  if (err instanceof YeastarError) {
    return fail(`The phone system refused the request (${err.errmsg})`, 502);
  }
  return null;
}

/** The SQLSTATEs 089's functions and guards raise, as HTTP. */
export function dbFailure(
  error: { code?: string; message: string } | null
): NextResponse | null {
  if (!error) return null;
  const status = (
    { P0002: 404, '42501': 403, '22023': 400, '55000': 409 } as Record<
      string,
      number
    >
  )[error.code ?? ''];
  return status ? fail(error.message, status) : null;
}

export interface CallLink {
  contactId: string;
  conversationId: string | null;
  dealId: string | null;
}

/**
 * Links a call to a contact through pbx_link_call_contact on the
 * caller's client, which decides who may (its refusal comes back as a
 * response), then reads the chat and deal the call was left with: both
 * link routes make this one link.
 */
export async function linkCallContact(
  rls: SupabaseClient,
  callId: string,
  contactId: string
): Promise<CallLink | NextResponse> {
  const { error } = await rls.rpc('pbx_link_call_contact', {
    p_call_id: callId,
    p_contact_id: contactId,
  });
  if (error) {
    const refused = dbFailure(error);
    if (refused) return refused;
    throw new Error(`pbx_link_call_contact failed: ${error.message}`);
  }
  const { data, error: readError } = await rls
    .from('calls')
    .select('contact_id, conversation_id, deal_id')
    .eq('id', callId)
    .maybeSingle();
  if (readError) throw new Error(`calls read failed: ${readError.message}`);
  const row = data as {
    contact_id: string | null;
    conversation_id: string | null;
    deal_id: string | null;
  } | null;
  return {
    contactId: row?.contact_id ?? contactId,
    conversationId: row?.conversation_id ?? null,
    dealId: row?.deal_id ?? null,
  };
}

interface ContactRow {
  id: string;
  phone: string | null;
  do_not_contact_at: string | null;
  do_not_contact_reason: string | null;
}

export type Callee =
  | {
      ok: true;
      number: string;
      internal: boolean;
      contactId: string | null;
      /** Do-not-contact customers with this number (any in the workspace). */
      dnc: { contactIds: string[]; reason: string | null } | null;
    }
  | { ok: false; response: NextResponse };

/**
 * The workspace's do-not-contact contacts holding this number, on the
 * service role: a customer the caller cannot see is protected too. Each
 * of `alsoContactIds` (e.g. a deal-room participant's linked contact)
 * counts as well when it carries the stamp. Ids only: the reason of a
 * contact the caller cannot see is not theirs to read.
 */
export async function dncContactIds(
  service: SupabaseClient,
  accountId: string,
  number: string,
  alsoContactIds: string[] = []
): Promise<string[]> {
  const { data, error } = await service
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('phone', contactPhoneCandidates(number))
    .not('do_not_contact_at', 'is', null);
  if (error) throw new Error(`contacts read failed: ${error.message}`);
  const ids = new Set(((data ?? []) as { id: string }[]).map((c) => c.id));
  if (alsoContactIds.length) {
    const { data: linked, error: linkedErr } = await service
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .in('id', alsoContactIds)
      .not('do_not_contact_at', 'is', null);
    if (linkedErr)
      throw new Error(`contacts read failed: ${linkedErr.message}`);
    for (const c of (linked ?? []) as { id: string }[]) ids.add(c.id);
  }
  return [...ids];
}

/**
 * The number to call and who it is. A contact is read with the caller's
 * client, so it must be one they can see. A typed number must belong to
 * a contact they can see unless they rank team leader or above, or it
 * is internal (an extension) and `allowInternal`. Do-not-contact is
 * checked across the whole workspace on the service role, by every
 * stored form of the number: a customer who asked not to be called is
 * not called through a duplicate contact or a typed number either. The
 * reason is shown only for a contact the caller can see.
 */
export async function resolveCallee(input: {
  rls: SupabaseClient;
  service: SupabaseClient;
  accountId: string;
  rank: number;
  contactId?: string;
  number?: string;
  allowInternal?: boolean;
}): Promise<Callee> {
  const { rls, service, accountId, rank } = input;
  const refuse = (error: string, status: number) =>
    ({ ok: false, response: fail(error, status) }) as const;
  const cols = 'id, phone, do_not_contact_at, do_not_contact_reason';
  let visible: ContactRow[] = [];
  let number: string;
  if (input.contactId) {
    const { data, error } = await rls
      .from('contacts')
      .select(cols)
      .eq('id', input.contactId)
      .maybeSingle();
    if (error) throw new Error(`contacts read failed: ${error.message}`);
    if (!data) return refuse('Contact not found', 404);
    const n = normalizeRemoteNumber((data as ContactRow).phone);
    if (!n || n.internal)
      return refuse('This contact has no phone number to call', 422);
    visible = [data as ContactRow];
    number = n.number;
  } else {
    const n = normalizeRemoteNumber(input.number);
    if (!n) return refuse('Enter a phone number', 400);
    if (n.internal) {
      if (!input.allowInternal && rank < RANK_LEADER)
        return refuse('Only a team leader or above can dial this number', 403);
      return {
        ok: true,
        number: n.number,
        internal: true,
        contactId: null,
        dnc: null,
      };
    }
    number = n.number;
    const { data, error } = await rls
      .from('contacts')
      .select(cols)
      .in('phone', contactPhoneCandidates(number));
    if (error) throw new Error(`contacts read failed: ${error.message}`);
    visible = (data ?? []) as ContactRow[];
    if (!visible.length && rank < RANK_LEADER)
      return refuse(
        'You can only call a number that belongs to a customer you can see',
        403
      );
  }

  const dncIds = new Set(await dncContactIds(service, accountId, number));
  for (const c of visible) if (c.do_not_contact_at) dncIds.add(c.id);
  const shown = visible.find((c) => c.do_not_contact_at);
  return {
    ok: true,
    number,
    internal: false,
    contactId: visible[0]?.id ?? null,
    dnc: dncIds.size
      ? {
          contactIds: [...dncIds],
          reason: shown?.do_not_contact_reason ?? null,
        }
      : null,
  };
}

export const dncRefused = (reason: string | null) =>
  fail('This customer asked not to be contacted', 409, {
    code: 'do_not_contact',
    reason,
  });
