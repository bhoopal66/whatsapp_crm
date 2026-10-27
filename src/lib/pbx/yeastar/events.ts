import { zoneOffsetMs } from '@/lib/team-activity/range';
import { parseMembers, type CallMember } from './api';

/**
 * Yeastar P-Series events, as they arrive over the WebSocket or a
 * webhook: `{ "type": <event id>, "sn": "<PBX serial>", "msg": ... }`.
 *
 * The docs contradict themselves on `msg`: every parameter table types
 * it as an object, 30012 prints an object, and the other samples print a
 * quoted string. Both are accepted, and `type` may be a number or a
 * numeric string. Nothing here throws: a frame that cannot be read is
 * `{ ok: false, error }`, so one bad delivery never takes down a socket
 * loop or turns a webhook into a redelivery storm.
 */

export const YEASTAR_EVENT = {
  REGISTRATION: 30007,
  EXTENSION_CALL_STATE: 30008,
  PRESENCE: 30009,
  CALL_STATE: 30011,
  CALL_END: 30012,
} as const;

/** 30007 `kind`; `pad` is "Linkus Pad Client (SDK)", i.e. an SDK softphone. */
export type RegistrationClient =
  'sip' | 'mobile' | 'desktop' | 'web' | 'pad' | 'other';

export type PresenceStatus =
  | 'available'
  | 'away'
  | 'business_trip'
  | 'do_not_disturb'
  | 'lunch'
  | 'off_work';

export type CallDirection = 'inbound' | 'outbound' | 'internal';

export interface RegistrationEvent {
  kind: 'registration';
  type: 30007;
  sn?: string;
  extension: string;
  status: 'registered' | 'unregistered';
  /** An undocumented kind is `other` rather than a dropped event. */
  client: RegistrationClient;
  registeredIp?: string;
}

export interface ExtensionCallStateEvent {
  kind: 'extension_call_state';
  type: 30008;
  sn?: string;
  extension: string;
  status: 'ringing' | 'busy' | 'idle';
}

export interface PresenceEvent {
  kind: 'presence';
  type: 30009;
  sn?: string;
  extension: string;
  presence: PresenceStatus;
}

/**
 * 30011. Whether `members` is a snapshot or a delta is undocumented;
 * treat it as a snapshot and merge by `channelId`. `internal` legs are
 * dropped, as `call/query` drops them.
 */
export interface CallStateEvent {
  kind: 'call_state';
  type: 30011;
  sn?: string;
  callId: string;
  members: CallMember[];
}

/**
 * 30012, and a `cdr/search` row mapped by `cdrRecordToCallEnd`: the live
 * and backfill paths produce this one shape, keyed by `uid`.
 */
export interface CallEndEvent {
  kind: 'call_end';
  type: 30012;
  sn?: string;
  callId: string;
  /** The CDR's unique id: the dedupe key across live events and backfill. */
  uid: string;
  /** Null when the PBX's `type` is none of the three (kept in `raw`). */
  direction: CallDirection | null;
  from: string;
  to: string;
  /** UTC ISO 8601, or null when the time could not be read. */
  startedAt: string | null;
  /** Exactly what the PBX sent, so a misread zone or format can be redone. */
  startedAtRaw: string | number | null;
  /** Assumed seconds: the event docs give no unit. */
  callSeconds: number;
  talkSeconds: number;
  /** Upper-cased: ANSWERED, NO ANSWER, BUSY, VOICEMAIL, ABANDONED (FAILED in CDR); others pass through. */
  status: string;
  /** A file name for `recording/download?file=`, not a URL. */
  recordingFile?: string;
  didNumber?: string;
  didName?: string;
  raw: Record<string, unknown>;
}

/** The documented webhook connectivity test (`webhook/test`, the UI's Test button). */
export interface WebhookTestEvent {
  kind: 'webhook_test';
  message: string;
}

export interface UnknownEvent {
  kind: 'unknown';
  type: number;
  sn?: string;
  raw: Record<string, unknown>;
}

export type YeastarEvent =
  | RegistrationEvent
  | ExtensionCallStateEvent
  | PresenceEvent
  | CallStateEvent
  | CallEndEvent
  | WebhookTestEvent
  | UnknownEvent;

export type ParseResult<T> =
  { ok: true; event: T } | { ok: false; error: string };

export interface PbxTimeOptions {
  /** IANA zone of the PBX's display times; defaults to `Asia/Dubai`. */
  pbxTimeZone?: string;
  /**
   * How to read an `NN/NN/YYYY` date. The docs only show MM/DD/YYYY; an
   * install whose display format is day-first must say so here.
   */
  dateOrder?: 'MDY' | 'DMY';
}

export const DEFAULT_PBX_TIME_ZONE = 'Asia/Dubai';

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const YEAR_FIRST =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;
const YEAR_LAST =
  /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

/**
 * A PBX time to UTC ISO, or null. Unix seconds (number or digit string)
 * need no zone. A display string ("2026-06-05 10:19:57",
 * "2025/12/19 10:40:07 PM", "05/30/2022 14:53:41") is wall-clock time in
 * `pbxTimeZone`; the zone and the full set of display formats are
 * undocumented, hence the options and the raw value kept beside it.
 */
export function parsePbxTime(
  value: unknown,
  opts: PbxTimeOptions = {}
): string | null {
  if (
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d{9,11}$/.test(value.trim()))
  ) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(seconds * 1000).toISOString();
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let y: number, mo: number, d: number;
  let m = YEAR_FIRST.exec(text);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = YEAR_LAST.exec(text))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    [mo, d] = opts.dateOrder === 'DMY' ? [b, a] : [a, b];
    y = Number(m[3]);
  } else {
    return null;
  }
  let h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6] ?? 0);
  const ampm = m[7]?.toUpperCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === 'PM' ? 12 : 0);
  }
  if (h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  // Date.UTC rolls 02/30 over to March; a date that rolled is not a date.
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  try {
    const tz = opts.pbxTimeZone ?? DEFAULT_PBX_TIME_ZONE;
    // Second pass settles a wall time near a DST change.
    const utc = wall - zoneOffsetMs(wall - zoneOffsetMs(wall, tz), tz);
    return new Date(utc).toISOString();
  } catch {
    return null; // an invalid time zone name
  }
}

/** "Phillip Huff<1001>" (CDR style) or "1001": the number alone. */
export function numberOf(v: unknown): string {
  const text =
    typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  const tagged = /<([^<>]*)>\s*$/.exec(text);
  return (tagged ? tagged[1] : text).trim();
}

const seconds = (v: unknown): number => {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string' && v.trim() !== ''
        ? Number(v)
        : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const DIRECTIONS: readonly CallDirection[] = [
  'inbound',
  'outbound',
  'internal',
];

/** The fields both a 30012 `msg` and a CDR row reduce to. */
export interface CallEndFields {
  callId: unknown;
  uid: unknown;
  type: unknown;
  from: unknown;
  to: unknown;
  time: unknown;
  callSeconds: unknown;
  talkSeconds: unknown;
  status: unknown;
  recording: unknown;
  didNumber: unknown;
  didName: unknown;
}

export function buildCallEnd(
  f: CallEndFields,
  raw: Json,
  opts: PbxTimeOptions,
  sn?: string
): ParseResult<CallEndEvent> {
  const callId = str(f.callId);
  const uid = str(f.uid);
  if (!callId) return fail('call end: call_id missing');
  if (!uid) return fail('call end: uid missing');
  const type = typeof f.type === 'string' ? f.type.trim().toLowerCase() : '';
  const direction = (DIRECTIONS as readonly string[]).includes(type)
    ? (type as CallDirection)
    : null;
  const time =
    typeof f.time === 'number' || typeof f.time === 'string' ? f.time : null;
  const recordingFile = str(f.recording);
  const didNumber = str(f.didNumber);
  const didName = str(f.didName);
  return {
    ok: true,
    event: {
      kind: 'call_end',
      type: 30012,
      ...(sn ? { sn } : {}),
      callId,
      uid,
      direction,
      from: numberOf(f.from),
      to: numberOf(f.to),
      startedAt: parsePbxTime(time, opts),
      startedAtRaw: time,
      callSeconds: seconds(f.callSeconds),
      talkSeconds: seconds(f.talkSeconds),
      status: typeof f.status === 'string' ? f.status.trim().toUpperCase() : '',
      ...(recordingFile ? { recordingFile } : {}),
      ...(didNumber ? { didNumber } : {}),
      ...(didName ? { didName } : {}),
      raw,
    },
  };
}

function oneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[]
): T | { error: string } {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(v)
    ? (v as T)
    : { error: `${field} ${JSON.stringify(value)} is not a documented value` };
}

/** 30009's statuses, and what `extension/update` takes as `presence_status`. */
export const PRESENCE_STATUSES: readonly PresenceStatus[] = [
  'available',
  'away',
  'business_trip',
  'do_not_disturb',
  'lunch',
  'off_work',
];
const CLIENTS: readonly RegistrationClient[] = [
  'sip',
  'mobile',
  'desktop',
  'web',
  'pad',
];

export function parseYeastarEvent(
  input: string | object,
  opts: PbxTimeOptions = {}
): ParseResult<YeastarEvent> {
  let frame: unknown = input;
  if (typeof input === 'string') {
    const parsed = parseJson(input);
    if (!parsed.ok) return fail('frame is not JSON');
    frame = parsed.value;
  }
  if (!isRecord(frame)) return fail('frame is not a JSON object');

  if (frame.type === undefined && frame.event === 'test') {
    return {
      ok: true,
      event: { kind: 'webhook_test', message: str(frame.message) ?? '' },
    };
  }
  const type =
    typeof frame.type === 'string' && /^\d+$/.test(frame.type.trim())
      ? Number(frame.type)
      : frame.type;
  if (typeof type !== 'number' || !Number.isInteger(type))
    return fail('frame has no event type');
  const sn = str(frame.sn);
  const base = sn ? { sn } : {};

  const known = (Object.values(YEASTAR_EVENT) as number[]).includes(type);
  if (!known)
    return { ok: true, event: { kind: 'unknown', type, ...base, raw: frame } };

  let msg: unknown = frame.msg;
  if (typeof msg === 'string') {
    const parsed = parseJson(msg);
    if (!parsed.ok) return fail(`event ${type}: msg is not JSON`);
    msg = parsed.value;
  }
  if (!isRecord(msg)) return fail(`event ${type}: msg is not an object`);

  if (type === YEASTAR_EVENT.CALL_END) {
    return buildCallEnd(
      {
        callId: msg.call_id,
        uid: msg.uid,
        type: msg.type,
        from: msg.call_from,
        to: msg.call_to,
        time: msg.time_start,
        callSeconds: msg.call_duration,
        talkSeconds: msg.talk_duration,
        status: msg.status,
        recording: msg.recording,
        didNumber: msg.did_number,
        didName: msg.did_name,
      },
      msg,
      opts,
      sn
    );
  }
  if (type === YEASTAR_EVENT.CALL_STATE) {
    const callId = str(msg.call_id);
    if (!callId) return fail('event 30011: call_id missing');
    return {
      ok: true,
      event: {
        kind: 'call_state',
        type,
        ...base,
        callId,
        members: parseMembers(msg.members),
      },
    };
  }

  const extension = str(msg.extension);
  if (!extension) return fail(`event ${type}: extension missing`);
  if (type === YEASTAR_EVENT.REGISTRATION) {
    const status = oneOf('status', msg.status, [
      'registered',
      'unregistered',
    ] as const);
    if (typeof status === 'object') return fail(`event 30007: ${status.error}`);
    const client = oneOf('kind', msg.kind, CLIENTS);
    const registeredIp = str(msg.registered_ip);
    return {
      ok: true,
      event: {
        kind: 'registration',
        type,
        ...base,
        extension,
        status,
        client: typeof client === 'object' ? 'other' : client,
        ...(registeredIp ? { registeredIp } : {}),
      },
    };
  }
  if (type === YEASTAR_EVENT.EXTENSION_CALL_STATE) {
    const status = oneOf('status', msg.status, [
      'ringing',
      'busy',
      'idle',
    ] as const);
    if (typeof status === 'object') return fail(`event 30008: ${status.error}`);
    return {
      ok: true,
      event: { kind: 'extension_call_state', type, ...base, extension, status },
    };
  }
  const presence = oneOf('status', msg.status, PRESENCE_STATUSES);
  if (typeof presence === 'object')
    return fail(`event 30009: ${presence.error}`);
  return {
    ok: true,
    event: { kind: 'presence', type: 30009, ...base, extension, presence },
  };
}

const RINGING = new Set(['ALERT', 'RING']);

/** Extensions whose member is ringing (RING) or in ringback (ALERT), de-duplicated. */
export function ringingExtensions(call: CallStateEvent): string[] {
  const out = new Set<string>();
  for (const m of call.members) {
    if (
      m.kind === 'extension' &&
      m.number &&
      RINGING.has(m.status.toUpperCase())
    )
      out.add(m.number);
  }
  return [...out];
}

/**
 * The outside party: an inbound leg's caller, else an outbound leg's
 * callee. Inbound wins so a customer's call forwarded out to a mobile
 * still names the customer.
 */
export function remoteParty(call: CallStateEvent): string | null {
  const inbound = call.members.find((m) => m.kind === 'inbound' && m.from);
  if (inbound?.from) return inbound.from;
  const outbound = call.members.find((m) => m.kind === 'outbound' && m.to);
  return outbound?.to ?? null;
}

const MISSED = new Set(['NO ANSWER', 'BUSY', 'ABANDONED', 'VOICEMAIL']);

export function isMissedCallEnd(event: CallEndEvent): boolean {
  return isMissedCall(event.direction, event.status);
}

/** The same test over a call merged from its legs (call-legs.ts). */
export function isMissedCall(
  direction: CallDirection | null,
  status: string
): boolean {
  return direction === 'inbound' && MISSED.has(status);
}
