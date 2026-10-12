// ============================================================
// Pure helpers for the browser softphone (module 015): matching the
// Linkus SDK's call sessions to the call screens' calls, reading the
// SDK's loosely documented event payloads, and deciding what a failure
// means. No DOM and no SDK import, so all of it is unit-tested.
//
// The call screens know a call by the PBX's call id and the outside
// number (`SoftphoneCallRef`, from call_live). The SDK knows its own
// SIP session ids. Nothing links the two, so a session is matched by
// the remote number, and by elimination when only one session could be
// meant (a withheld or rewritten caller id).
// ============================================================

import type { SoftphoneCallRef } from './softphone';

/** What the call provider exposes for a status line ("Softphone ready"). */
export interface SoftphoneState {
  status: 'off' | 'loading' | 'connecting' | 'ready' | 'reconnecting' | 'error';
  /** The extension the softphone is (or will be) registered as. */
  extension: string | null;
  /** Why it is not ready, in plain words; null when nothing is wrong. */
  error: string | null;
}

export const SOFTPHONE_OFF: SoftphoneState = {
  status: 'off',
  extension: null,
  error: null,
};

/** One SDK session, reduced to what matching needs. */
export interface SdkCallView {
  callId: string;
  number: string | null;
  inbound: boolean;
  state: 'ringing' | 'calling' | 'connecting' | 'talking' | 'unknown';
  /** When this tab first saw the session (ms). */
  seenAt: number;
}

const STATES = new Set(['ringing', 'calling', 'connecting', 'talking']);

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** A session's `status` (CallStatus in the SDK's types), read defensively. */
export function viewOf(
  callId: string,
  status: unknown,
  seenAt: number
): SdkCallView {
  const s = obj(status);
  const state = typeof s?.callStatus === 'string' ? s.callStatus : '';
  return {
    callId,
    number: typeof s?.number === 'string' && s.number ? s.number : null,
    inbound: s?.communicationType === 'inbound',
    state: STATES.has(state) ? (state as SdkCallView['state']) : 'unknown',
    seenAt,
  };
}

/**
 * The same phone number? Exact on digits for short numbers (extensions),
 * else the last 7–9 digits, so +971 50…, 00971 50… and 050… agree.
 */
export function numbersMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const da = (a ?? '').replace(/\D/g, '');
  const db = (b ?? '').replace(/\D/g, '');
  if (!da || !db) return false;
  if (da === db) return true;
  const n = Math.min(da.length, db.length, 9);
  if (n < 7) return false;
  return da.slice(-n) === db.slice(-n);
}

/**
 * Which SDK session a call-screen action means, or null.
 * - `answer` (Answer / Decline): only inbound sessions still ringing.
 * - `live` (Hang up, Mute, Hold, keypad): any session, a talking one
 *   first.
 * A session already bound to this PBX call wins; then the remote number
 * (latest first); then, if exactly one session qualifies, that one.
 */
export function matchSession(
  sessions: SdkCallView[],
  ref: SoftphoneCallRef,
  purpose: 'answer' | 'live',
  boundId: string | null = null
): string | null {
  const pool = sessions.filter((s) =>
    purpose === 'answer' ? s.inbound && s.state === 'ringing' : true
  );
  if (boundId && pool.some((s) => s.callId === boundId)) return boundId;
  const rank = (s: SdkCallView) =>
    (purpose === 'live' && s.state === 'talking' ? 1e15 : 0) + s.seenAt;
  const byNumber = pool
    .filter((s) => numbersMatch(s.number, ref.remoteNumber))
    .sort((x, y) => rank(y) - rank(x));
  if (byNumber.length) return byNumber[0].callId;
  return pool.length === 1 ? pool[0].callId : null;
}

/**
 * `{ callId, session }` from a session event. The SDK's guide shows both
 * `(payload)` and `(callId, session)` callbacks; either is accepted.
 */
export function sessionEventArgs(
  args: unknown[]
): { callId: string; session: Record<string, unknown> } | null {
  const [a, b] = args;
  if (typeof a === 'string' && obj(b))
    return { callId: a, session: obj(b) as Record<string, unknown> };
  const o = obj(a);
  const session = obj(o?.session);
  if (!o || !session) return null;
  const id =
    typeof o.callId === 'string' ? o.callId : obj(session.status)?.callId;
  return typeof id === 'string' && id ? { callId: id, session } : null;
}

/** The call id of a `deleteSession` / `ended` event, either shape. */
export function eventCallId(args: unknown[]): string | null {
  const [a] = args;
  if (typeof a === 'string') return a || null;
  const id = obj(a)?.callId;
  return typeof id === 'string' && id ? id : null;
}

/** An SDK `{ code, message|msg }` result or error, if it is one. */
export function sdkCode(v: unknown): { code: number; message: string } | null {
  const o = obj(v);
  if (!o || typeof o.code !== 'number') return null;
  const m = o.message ?? o.msg;
  return { code: o.code, message: typeof m === 'string' ? m : '' };
}

/** SDK results are 0 / 100 / 200 on success and negative on failure. */
export function sdkFailed(result: unknown): boolean {
  const r = sdkCode(result);
  return r !== null && r.code < 0;
}

const SDK_MESSAGES: Record<number, string> = {
  [-2]: 'The PBX address is not valid for the softphone',
  [-3]: 'The softphone needs the PBX on HTTPS',
  [-106]: 'Linkus is switched off for this extension on the PBX',
  [-107]: 'This extension signed in to the softphone elsewhere',
  [-108]: 'This extension was deleted on the PBX',
  [-109]: 'The softphone needs to sign in again',
  [-110]: 'The PBX plan does not include the Linkus SDK (Ultimate Plan)',
  [-202]: 'Microphone access was not allowed in this browser',
  [-203]: 'The microphone could not be started',
  [-205]: 'Too many calls at once in the softphone',
  [-206]: 'The microphone could not be opened',
  [-209]: 'The number is not valid',
  [-211]: 'The softphone no longer has this call',
  [-290]: 'No microphone was found',
};

/** Plain words for an SDK code, falling back to the SDK's own text. */
export function describeSdkCode(code: number, message = ''): string {
  return (
    SDK_MESSAGES[code] ??
    (message
      ? `Softphone error ${code}: ${message}`
      : `Softphone error ${code}`)
  );
}

/**
 * Codes a fresh signature and init cannot fix: a bad PBX address, an
 * extension or plan problem, or another tab holding the login (taking it
 * back would only make the two tabs evict each other forever).
 */
const FATAL_CODES = new Set([-2, -3, -106, -107, -108, -110]);

export function sdkCodeRetryable(code: number): boolean {
  return !FATAL_CODES.has(code);
}

/** Never sooner than 30 s apart, doubling up to five minutes. */
export const MIN_REINIT_MS = 30_000;
export function retryDelayMs(attempt: number): number {
  return Math.min(MIN_REINIT_MS * 2 ** Math.max(0, attempt), 300_000);
}

/**
 * A refused POST /api/pbx/softphone/signature. The 409s are settings
 * (softphone off, no SDK credentials, no extension, no email) and are not
 * retried; a 5xx or a network failure is.
 */
export function signatureFailure(
  status: number,
  body: unknown
): { message: string; retry: boolean } {
  const o = obj(body);
  const msg = typeof o?.error === 'string' ? o.error : `HTTP ${status}`;
  const retry = status >= 500 || status === 429 || status === 0;
  return { message: msg, retry };
}
