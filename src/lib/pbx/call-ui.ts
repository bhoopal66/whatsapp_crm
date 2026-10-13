// ============================================================
// The call screens' pure rules (module 015): the incoming-call card,
// the in-call panel and the Call buttons. Client-safe: no I/O, and
// nothing from ./calls at runtime (it imports next/server), so the
// outcome list is restated here and call-ui.test.ts keeps it equal to
// DISPOSITIONS.
//
// The card and the panel are internal: nothing here is ever sent to a
// customer. The shared call card goes to a team chat channel, and it
// names the customer by name or by a masked number, never the number.
// ============================================================

import { isBankGuest, type AccountRole } from '@/lib/auth/roles';
import type { CallDirection, Disposition } from './calls';

/** calls.disposition, in the order the panel offers them. */
export const OUTCOMES = [
  'interested',
  'docs_requested',
  'call_back',
  'not_eligible',
  'wrong_number',
] as const satisfies readonly Disposition[];
export type Outcome = (typeof OUTCOMES)[number];

/** As the PATCH route and pbx_set_disposition limit them. */
export const NOTES_MAX = 4000;
/** As the dial route limits a do-not-contact override's reason. */
export const OVERRIDE_REASON_MAX = 500;
/** How much of the notes a shared call card carries. */
export const CARD_NOTES_MAX = 600;

/** A call_live row as the screen pop reads it (RLS-filtered). */
export interface CallLiveRow {
  connection_id: string;
  pbx_call_id: string;
  account_id: string;
  contact_id: string | null;
  remote_number: string | null;
  did_number: string | null;
  ringing_user_ids: string[] | null;
  answered_by: string | null;
  members: unknown;
  state: string | null;
  updated_at: string;
}

interface LiveMember {
  kind?: unknown;
  contactCandidates?: unknown;
}

export const liveKey = (
  r: Pick<CallLiveRow, 'connection_id' | 'pbx_call_id'>
): string => `${r.connection_id}:${r.pbx_call_id}`;

function membersOf(r: CallLiveRow): LiveMember[] {
  return Array.isArray(r.members)
    ? (r.members as unknown[]).filter(
        (m): m is LiveMember => typeof m === 'object' && m !== null
      )
    : [];
}

/** An outside line is on it; an extension-to-extension call gets no screen. */
export const isCustomerCall = (r: CallLiveRow): boolean =>
  membersOf(r).some((m) => m.kind === 'inbound' || m.kind === 'outbound');

/** The customer called in (a click-to-call rings our own phone first). */
export const isInboundCall = (r: CallLiveRow): boolean =>
  membersOf(r).some((m) => m.kind === 'inbound');

const byUpdated = (a: CallLiveRow, b: CallLiveRow) =>
  a.updated_at.localeCompare(b.updated_at);

/**
 * The customer call ringing this person: inbound, unanswered, and their
 * extension among the ringing ones. A team leader sees every live row
 * (RLS), so visibility alone never means "ringing for me". Oldest first.
 */
export function myRingingCall(
  rows: CallLiveRow[],
  userId: string | null
): CallLiveRow | null {
  if (!userId) return null;
  return (
    rows
      .filter(
        (r) =>
          !r.answered_by &&
          (r.ringing_user_ids ?? []).includes(userId) &&
          isInboundCall(r)
      )
      .sort(byUpdated)[0] ?? null
  );
}

/** The customer call this person answered (either direction). */
export function myActiveCall(
  rows: CallLiveRow[],
  userId: string | null
): CallLiveRow | null {
  if (!userId) return null;
  return (
    rows
      .filter((r) => r.answered_by === userId && isCustomerCall(r))
      .sort(byUpdated)[0] ?? null
  );
}

/** The contacts a number matched more than once, for a person to pick. */
export function contactCandidates(r: CallLiveRow): string[] {
  const out = new Set<string>();
  for (const m of membersOf(r))
    if (Array.isArray(m.contactCandidates))
      for (const id of m.contactCandidates)
        if (typeof id === 'string' && id) out.add(id);
  return [...out];
}

/**
 * A phone number for an internal screen that still should not show it
 * whole: the first three digits of a long number (country or area code)
 * and the last four; a short one keeps its last two.
 */
export function maskPhone(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '');
  const n = d.length;
  if (n === 0) return '';
  if (n <= 2) return '•'.repeat(n);
  if (n <= 6) return `${'•'.repeat(n - 2)} ${d.slice(-2)}`;
  if (n < 10) return `${'•'.repeat(n - 4)} ${d.slice(-4)}`;
  const head = d.startsWith('0') ? d.slice(0, 3) : `+${d.slice(0, 3)}`;
  return `${head} ${'•'.repeat(n - 7)} ${d.slice(-4)}`;
}

/** m:ss, or h:mm:ss from an hour. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export interface ConsentFields {
  do_not_contact_at?: string | null;
  do_not_contact_reason?: string | null;
  marketing_opt_in_at?: string | null;
  opted_out_at?: string | null;
}

export interface ConsentState {
  /** False once the customer is do-not-contact (migration 086). */
  callsOk: boolean;
  dncReason: string | null;
  /** Opted in to marketing, and neither opted out (076) nor do-not-contact. */
  marketing: boolean;
}

export function consentState(c: ConsentFields): ConsentState {
  const dnc = Boolean(c.do_not_contact_at);
  return {
    callsOk: !dnc,
    dncReason: dnc ? c.do_not_contact_reason?.trim() || null : null,
    marketing: Boolean(c.marketing_opt_in_at) && !c.opted_out_at && !dnc,
  };
}

export interface ConsentLabels {
  callsOk: string;
  doNotContact: string;
  marketingOn: string;
  marketingOff: string;
}

/** "Calls OK · marketing off". */
export function consentText(c: ConsentFields, l: ConsentLabels): string {
  const s = consentState(c);
  return `${s.callsOk ? l.callsOk : l.doNotContact} · ${
    s.marketing ? l.marketingOn : l.marketingOff
  }`;
}

/**
 * The others a call is ringing for, by name: people with no known name
 * and those past `max` are counted in `more`.
 */
export function alsoRinging(
  r: CallLiveRow,
  me: string | null,
  names: Record<string, string>,
  max = 3
): { names: string[]; more: number } {
  const others = [...new Set(r.ringing_user_ids ?? [])].filter(
    (id) => id !== me
  );
  const named = others.map((id) => names[id]?.trim()).filter(Boolean);
  const shown = named.slice(0, max) as string[];
  return { names: shown, more: others.length - shown.length };
}

/** Clips text to `max` characters (code points), with an ellipsis. */
export function clip(text: string | null | undefined, max: number): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

export interface CallCardInput {
  direction: CallDirection;
  contactName?: string | null;
  remoteNumber?: string | null;
  talkSeconds: number | null;
  outcome: Outcome | null;
  notes?: string | null;
}

export interface CallCardLabels {
  /** "{direction} call with {who}". */
  heading: (direction: string, who: string) => string;
  direction: Record<CallDirection, string>;
  outcome: Record<Outcome, string>;
  noOutcome: string;
  unknownCaller: string;
}

/**
 * The internal message the panel shares to a team chat channel:
 * "📞 Inbound call with Acme · 3:12 · Interested — notes". The customer
 * is named, else shown by masked number: the card is posted for
 * colleagues, and a full number has no business in a chat log.
 */
export function callCardText(i: CallCardInput, l: CallCardLabels): string {
  const who =
    i.contactName?.trim() || maskPhone(i.remoteNumber) || l.unknownCaller;
  const parts = [
    `📞 ${l.heading(l.direction[i.direction], who)}`,
    formatTimer((i.talkSeconds ?? 0) * 1000),
    i.outcome ? l.outcome[i.outcome] : l.noOutcome,
  ];
  const notes = clip(i.notes, CARD_NOTES_MAX);
  return parts.join(' · ') + (notes ? ` — ${notes}` : '');
}

export type DialResult =
  | { kind: 'ok'; pbxCallId: string }
  | { kind: 'do_not_contact'; reason: string | null }
  | { kind: 'no_extension' }
  | { kind: 'error'; message: string | null };

/** POST /api/pbx/calls/dial's answer, by what the button does next. */
export function dialResult(status: number, body: unknown): DialResult {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  if (status >= 200 && status < 300 && text(b.pbxCallId))
    return { kind: 'ok', pbxCallId: b.pbxCallId as string };
  if (b.code === 'do_not_contact')
    return { kind: 'do_not_contact', reason: text(b.reason) };
  if (b.code === 'no_extension') return { kind: 'no_extension' };
  return { kind: 'error', message: text(b.error) };
}

/** Closing the panel needs an outcome when the workspace says so. */
export const needsOutcome = (mandatory: boolean, outcome: Outcome | null) =>
  mandatory && outcome === null;

/**
 * Whether the call layer asks GET /api/pbx/me for the caller's phone:
 * once the session and the workspace are known, and never for a bank
 * guest. The route is viewer and up, and the provider is mounted on
 * every dashboard page, so asking for a guest drew a 403 on each one.
 * The call_live subscription, the poll and the softphone all wait for
 * that answer, so this one gate keeps a guest out of all of them.
 */
export const loadsPbxMe = (
  userId: string | null | undefined,
  accountId: string | null | undefined,
  role: AccountRole | null | undefined
): boolean => Boolean(userId && accountId) && !isBankGuest(role);
