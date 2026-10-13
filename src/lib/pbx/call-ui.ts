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

import {
  canViewUnroutedCalls,
  hasMinRole,
  isBankGuest,
  type AccountRole,
} from '@/lib/auth/roles';
import type { Disposition } from './calls';

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
  /** When the call first rang (094); missing before that migration. */
  rang_at?: string | null;
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

/** The number "Create contact" starts with: the caller's, with its +. */
export const newContactPhone = (remote: string | null | undefined): string =>
  remote && /^\d+$/.test(remote) ? `+${remote}` : (remote ?? '');

/** m:ss, or h:mm:ss from an hour. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Longer than any call rings: a rang_at this old is a stale row or a wrong clock. */
export const RING_TIMER_MAX_MS = 60 * 60_000;

/**
 * When this browser first saw a call_live row's current frame (its
 * updated_at). `live`: it saw the frame arrive (realtime, or a poll
 * after the first load). A frame of the first load was written an
 * unknown time before the page opened.
 */
export interface FrameSeen {
  updatedAt: string;
  at: number;
  live: boolean;
}

/** The frames of `rows`, each kept from `prev` until its updated_at changes. */
export function noteFrames(
  prev: Record<string, FrameSeen>,
  rows: CallLiveRow[],
  now: number,
  live: boolean
): Record<string, FrameSeen> {
  const next: Record<string, FrameSeen> = {};
  for (const r of rows) {
    const k = liveKey(r);
    const seen = prev[k];
    next[k] =
      seen?.updatedAt === r.updated_at
        ? seen
        : { updatedAt: r.updated_at, at: now, live };
  }
  return next;
}

/**
 * Since when the card has shown `ringing` (browser time), the ring
 * timer's floor: started with the `now` of the update that first made
 * it my ringing call, and restarted when it stops ringing me (answered,
 * then transferred back), so an idle page or an earlier ring never
 * counts.
 */
export function ringFloor(
  prev: { key: string; at: number } | null,
  ringing: CallLiveRow | null,
  now: number
): { key: string; at: number } | null {
  if (!ringing) return null;
  const key = liveKey(ringing);
  return prev?.key === key ? prev : { key, at: now };
}

/**
 * How long the card's call has rung, from call_live.rang_at (094; the
 * database re-stamps it when an answered call rings again). Measured on
 * the server's clocks where it can be: rung at the frame (updated_at −
 * rang_at), plus the browser's time since it saw that frame arrive, so
 * a browser clock minutes out changes nothing. Only a frame it did not
 * see arrive (the first load: a reload mid-ring) falls back to this
 * clock's now − rang_at, which keeps the count across the reload.
 * Never less than since the card showed the call (`shownAt`), which is
 * the whole answer without a usable rang_at; never negative or absurd.
 */
export function ringElapsedMs(
  row: Pick<CallLiveRow, 'rang_at' | 'updated_at'>,
  seen: FrameSeen | null,
  shownAt: number,
  now: number
): number {
  const shown = Math.max(0, now - shownAt);
  const rang = typeof row.rang_at === 'string' ? Date.parse(row.rang_at) : NaN;
  // A frame received just before its own row's stamp started the ring.
  const atFrame = Math.max(0, Date.parse(row.updated_at) - rang);
  const byFrame =
    seen?.updatedAt === row.updated_at
      ? atFrame + Math.max(0, now - seen.at)
      : NaN;
  const byClock = seen?.live ? NaN : now - rang;
  const sane = [byFrame, byClock].filter(
    (ms) => Number.isFinite(ms) && ms >= 0 && ms <= RING_TIMER_MAX_MS
  );
  return Math.max(shown, ...sane);
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
  /** Opted out of messages (076): never "Calls OK" either. */
  optedOut: string;
  /** A customer whose consent this screen could not read. */
  unknown: string;
  marketingOn: string;
  marketingOff: string;
}

/**
 * "Calls OK · marketing off", "Do not contact: Asked · marketing off".
 * Only a customer known to be neither do-not-contact nor opted out reads
 * "Calls OK": consent that could not be read (`consentKnown: false`, a
 * contact the person's own read hides) says so instead, because an empty
 * row once read as "Calls OK" for a do-not-contact customer.
 */
export function consentText(
  c: ConsentFields & { consentKnown?: boolean },
  l: ConsentLabels
): string {
  if (c.consentKnown === false) return l.unknown;
  const s = consentState(c);
  const calls = !s.callsOk
    ? s.dncReason
      ? `${l.doNotContact}: ${s.dncReason}`
      : l.doNotContact
    : c.opted_out_at
      ? l.optedOut
      : l.callsOk;
  return `${calls} · ${s.marketing ? l.marketingOn : l.marketingOff}`;
}

/** A ringing or answering party of a live call (call_live holds auth user ids). */
export const isLiveParty = (
  r: Pick<CallLiveRow, 'ringing_user_ids' | 'answered_by'>,
  userId: string
): boolean =>
  r.answered_by === userId || (r.ringing_user_ids ?? []).includes(userId);

/** The contacts a live call is about: its match, else the numbers' candidates. */
export const callContactIds = (r: CallLiveRow): string[] =>
  r.contact_id ? [r.contact_id, ...contactCandidates(r)] : contactCandidates(r);

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

/** Why a deal-room participant cannot be called (lib/deal-rooms/call.ts). */
export const PARTICIPANT_BLOCKS = [
  'bank_guests_off',
  'not_callable',
  'room_closed',
  'no_number',
  'bank_calls_recorded',
] as const;
export type ParticipantBlockCode = (typeof PARTICIPANT_BLOCKS)[number];

export type DialResult =
  | { kind: 'ok'; pbxCallId: string }
  | { kind: 'do_not_contact'; reason: string | null }
  | { kind: 'no_extension' }
  /** A participant the route will not call: the button stays disabled. */
  | { kind: 'blocked'; code: ParticipantBlockCode }
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
  const block = PARTICIPANT_BLOCKS.find((c) => c === b.code);
  if (block) return { kind: 'blocked', code: block };
  return { kind: 'error', message: text(b.error) };
}

/** A row of GET /api/pbx/calls, as far as its Call back reads it. */
export interface CallBackRow {
  contactId: string | null;
  remoteNumber: string | null;
  /** The contact's do-not-contact stamp (086), when the caller can see it. */
  doNotContactAt?: string | null;
  doNotContactReason?: string | null;
}

export type CallBackTarget =
  | { kind: 'contact'; contact: ConsentFields & { id: string } }
  | { kind: 'number'; number: string };

/**
 * What a missed call's Call back dials, or null for no button: agent
 * and up, the dial route's floor. A known caller is called through
 * their contact, carrying the do-not-contact stamp the button disables
 * itself on. A caller with no contact is called by number, which the
 * dial route allows a team leader and up (an agent only a number of a
 * customer they can see) and checks for do-not-contact across the
 * workspace, by every stored form of the number: the button learns of
 * one from the route's 409, and an owner or admin may still call with a
 * logged reason.
 */
export function callBackFor(
  row: CallBackRow,
  role: AccountRole | null | undefined
): CallBackTarget | null {
  if (!role || !hasMinRole(role, 'agent')) return null;
  if (row.contactId)
    return {
      kind: 'contact',
      contact: {
        id: row.contactId,
        do_not_contact_at: row.doNotContactAt ?? null,
        do_not_contact_reason: row.doNotContactReason ?? null,
      },
    };
  const number = row.remoteNumber?.trim();
  return number && hasMinRole(role, 'team_leader')
    ? { kind: 'number', number }
    : null;
}

/** Closing the panel needs an outcome when the workspace says so. */
export const needsOutcome = (mandatory: boolean, outcome: Outcome | null) =>
  mandatory && outcome === null;

/**
 * The wrap-up after a call: how long the ended panel asks for the
 * outcome (§7.3). Migration 097's reminder sweep waits the same
 * `interval '2 minutes'`; __tests__/wrap-up.test.ts keeps the two equal.
 */
export const WRAPUP_MS = 2 * 60_000;

/**
 * How far back a reload still re-opens a wrap-up whose outcome is owed
 * (mandatory, none chosen): 097's sweep horizon, `interval '1 hour'`,
 * so a call too old to be reminded of is not resurrected either.
 */
export const WRAPUP_OWED_MS = 60 * 60_000;

/** The in-call panel's call: live, or ended and in its wrap-up. */
export interface PanelCall {
  key: string;
  connectionId: string;
  pbxCallId: string;
  contactId: string | null;
  remoteNumber: string | null;
  inbound: boolean;
  seenAt: number;
  endedAt: number | null;
  /** The panel has an outcome chosen for this call (noteOutcome). */
  outcomeSet?: boolean;
}

/** What is left of the wrap-up of a call that ended at `endedAt`. */
export const wrapUpLeftMs = (endedAt: number, now: number): number =>
  Math.min(WRAPUP_MS, Math.max(0, endedAt + WRAPUP_MS - now));

/**
 * Where an ended call's wrap-up stands: `counting` through its two
 * minutes, then `done` (it closes by itself) or, when an outcome is owed
 * as they run out (mandatory, none chosen), `held`: it stays until the
 * person chooses one and closes it, and the PBX cron rings once (097).
 * Past `counting` it stays put, so an outcome chosen late does not snap
 * the panel shut over the note still being written.
 */
export type WrapUpPhase = 'counting' | 'held' | 'done';

export function wrapUpPhase(
  prev: WrapUpPhase,
  endedAt: number,
  now: number,
  mandatory: boolean,
  outcome: Outcome | null
): WrapUpPhase {
  if (prev !== 'counting' || wrapUpLeftMs(endedAt, now) > 0) return prev;
  return needsOutcome(mandatory, outcome) ? 'held' : 'done';
}

/** One of the caller's own calls, as GET /api/pbx/calls/wrap-up reads it. */
export interface WrapUpRow {
  connection_id: string | null;
  pbx_call_id: string;
  direction: string;
  contact_id: string | null;
  remote_number: string | null;
  answered_at: string | null;
  ended_at: string | null;
  disposition: string | null;
  erased_at: string | null;
}

/**
 * The oldest end (exclusive) whose wrap-up a reload re-opens: any call
 * still in its two minutes and, where outcomes are mandatory, one whose
 * outcome is owed, up to WRAPUP_OWED_MS back but never from before they
 * were made mandatory (`mandatorySince`, 097's
 * pbx_settings.mandatory_disposition_since): the reminder sweep never
 * rings for that history, and a reload must not resurrect it either.
 * `mandatorySince` null: outcomes are not mandatory.
 */
export function wrapUpCutoff(
  now: number,
  mandatorySince: number | null
): number {
  const counting = now - WRAPUP_MS;
  if (mandatorySince === null || Number.isNaN(mandatorySince)) return counting;
  return Math.min(counting, Math.max(now - WRAPUP_OWED_MS, mandatorySince));
}

/**
 * The calls whose wrap-up a reload re-opens, newest end first: answered,
 * with a customer (not internal), not erased, no outcome, and ended
 * after wrapUpCutoff. One without a PBX (connection removed) has no
 * panel to open.
 */
export function pickWrapUps(
  rows: WrapUpRow[],
  now: number,
  mandatorySince: number | null
): WrapUpRow[] {
  const cutoff = wrapUpCutoff(now, mandatorySince);
  const out: { r: WrapUpRow; at: number }[] = [];
  for (const r of rows) {
    if (!r.connection_id || r.disposition !== null || r.erased_at) continue;
    if (!r.answered_at || r.direction === 'internal') continue;
    const at = Date.parse(r.ended_at ?? '');
    if (Number.isNaN(at) || at <= cutoff) continue;
    out.push({ r, at });
  }
  return out.sort((a, b) => b.at - a.at).map((x) => x.r);
}

/** The wrap-up the route hands back: the call and the server's count. */
export interface WrapUpCall {
  connectionId: string;
  pbxCallId: string;
  direction: string;
  contactId: string | null;
  remoteNumber: string | null;
  leftMs: number;
}

/**
 * The panel for a recovered wrap-up, timed on this browser's clock: the
 * server counted `leftMs`, so a skewed browser clock neither ends the
 * wrap-up early nor stretches it.
 */
export function wrapUpPanel(c: WrapUpCall, now: number): PanelCall {
  const endedAt =
    now - (WRAPUP_MS - Math.min(WRAPUP_MS, Math.max(0, c.leftMs)));
  return {
    key: liveKey({ connection_id: c.connectionId, pbx_call_id: c.pbxCallId }),
    connectionId: c.connectionId,
    pbxCallId: c.pbxCallId,
    contactId: c.contactId,
    remoteNumber: c.remoteNumber,
    inbound: c.direction === 'inbound',
    seenAt: endedAt,
    endedAt,
  };
}

/** The in-call panel and the wrap-ups waiting behind it (§7.3). */
export interface PanelState {
  panel: PanelCall | null;
  /** Ended calls whose wrap-up is unfinished, newest end first. */
  waiting: PanelCall[];
}

export const NO_PANEL: PanelState = { panel: null, waiting: [] };

const livePanel = (r: CallLiveRow, now: number): PanelCall => ({
  key: liveKey(r),
  connectionId: r.connection_id,
  pbxCallId: r.pbx_call_id,
  contactId: r.contact_id,
  remoteNumber: r.remote_number,
  inbound: isInboundCall(r),
  seenAt: now,
  endedAt: null,
});

/**
 * The waiting wrap-ups still unfinished at `now`, newest end first: in
 * their two minutes, or past them with an outcome owed (mandatory, none
 * chosen) and under WRAPUP_OWED_MS old. One that is not is dropped for
 * good, as the panel closes its own (wrapUpPhase `done`): making outcomes
 * mandatory later does not bring a finished wrap-up back.
 */
function unfinished(
  waiting: PanelCall[],
  skip: string | null,
  now: number,
  mandatory: boolean
): PanelCall[] {
  const seen = new Set(skip === null ? [] : [skip]);
  return waiting
    .filter((w) => {
      if (w.endedAt === null || seen.has(w.key)) return false;
      seen.add(w.key);
      return (
        wrapUpLeftMs(w.endedAt, now) > 0 ||
        (mandatory && !w.outcomeSet && now - w.endedAt < WRAPUP_OWED_MS)
      );
    })
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/**
 * Who has the in-call panel (§7.3). A live call of mine ALWAYS does: for
 * a browser softphone the panel holds the only hangup, hold, mute and
 * transfer controls. It takes the panel from an ended call's wrap-up,
 * which waits, and keeps it until it ends (then the panel is its own
 * wrap-up). With no live call an empty panel re-opens the newest waiting
 * wrap-up: the call freshest in mind, whose two minutes may still run,
 * before older ones that are only still owed. Run on every call_live
 * change, on close (closeWrapUp) and when a reload recovers wrap-ups
 * (recoverWrapUps), whichever of the last two lands first.
 */
export function selectPanel(
  s: PanelState,
  rows: CallLiveRow[],
  userId: string | null,
  now: number,
  mandatory: boolean
): PanelState {
  let panel = s.panel;
  let waiting = s.waiting;
  if (panel && panel.endedAt === null) {
    const key = panel.key;
    const still = rows.find(
      (r) => liveKey(r) === key && r.answered_by === userId
    );
    if (!still) panel = { ...panel, endedAt: now };
    else if (still.contact_id !== panel.contactId)
      panel = { ...panel, contactId: still.contact_id };
  }
  const active = myActiveCall(rows, userId);
  if (active && (!panel || panel.endedAt !== null)) {
    if (panel) waiting = [panel, ...waiting];
    panel = livePanel(active, now);
  }
  waiting = unfinished(waiting, panel?.key ?? null, now, mandatory);
  if (!panel && waiting.length > 0) [panel, ...waiting] = waiting;
  return panel === s.panel && sameItems(waiting, s.waiting)
    ? s
    : { panel, waiting };
}

const sameItems = (a: PanelCall[], b: PanelCall[]) =>
  a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * The panel of `key` was closed (Close, or its wrap-up's auto-close): it
 * leaves the panel and the queue for good, even when it lands after a
 * live call took the panel. A live call's panel is never closed.
 */
export function closeWrapUp(
  s: PanelState,
  key: string,
  rows: CallLiveRow[],
  userId: string | null,
  now: number,
  mandatory: boolean
): PanelState {
  const keep = s.panel && (s.panel.key !== key || s.panel.endedAt === null);
  return selectPanel(
    {
      panel: keep ? s.panel : null,
      waiting: s.waiting.filter((w) => w.key !== key),
    },
    rows,
    userId,
    now,
    mandatory
  );
}

/**
 * Wrap-ups a reload recovered (GET /api/pbx/calls/wrap-up) join the
 * queue, so whichever of them and the first call_live load lands first,
 * a live call still takes the panel.
 */
export function recoverWrapUps(
  s: PanelState,
  recovered: PanelCall[],
  rows: CallLiveRow[],
  userId: string | null,
  now: number,
  mandatory: boolean
): PanelState {
  const known = new Set(
    [s.panel, ...s.waiting].flatMap((c) => (c ? [c.key] : []))
  );
  return selectPanel(
    {
      panel: s.panel,
      waiting: [...s.waiting, ...recovered.filter((c) => !known.has(c.key))],
    },
    rows,
    userId,
    now,
    mandatory
  );
}

/** The panel reports whether an outcome is chosen for its call. */
export function noteOutcome(
  s: PanelState,
  key: string,
  chosen: boolean
): PanelState {
  if (!s.panel || s.panel.key !== key || !!s.panel.outcomeSet === chosen)
    return s;
  return { ...s, panel: { ...s.panel, outcomeSet: chosen } };
}

/**
 * How often the wrap-up's auto-close tries to share a ticked call card
 * before it closes anyway, with the error showing (a person's Close
 * tries once and stays open on failure, to try again).
 */
export const AUTO_SHARE_TRIES = 3;

/** Runs `fn` up to `tries` times, `waitMs` apart; whether one succeeded. */
export async function tryTimes(
  tries: number,
  fn: () => Promise<unknown>,
  waitMs = 2000,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms))
): Promise<boolean> {
  for (let i = 1; ; i++) {
    try {
      await fn();
      return true;
    } catch {
      if (i >= tries) return false;
      await sleep(waitMs);
    }
  }
}

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

/** Customer facts as loaded, with the contact and the call they were loaded for. */
export interface HeldFacts<T> {
  contactId: string;
  /** liveKey of the call, null when loaded for no live call. */
  callKey: string | null;
  facts: T;
}

/**
 * The facts to show for `contactId` on `callKey`: only ones loaded for
 * that contact on that call. The card and the panel outlive the contact
 * under them (the next call, a pick, a re-link), and until the new
 * load lands they show nothing rather than the previous customer's
 * owner, deal, last message and consent; nor a repeat caller's facts
 * from the last call, when they may have become do-not-contact since.
 */
export function factsFor<T>(
  held: HeldFacts<T> | null,
  contactId: string | null,
  callKey: string | null
): T | null {
  return contactId && held?.contactId === contactId && held.callKey === callKey
    ? held.facts
    : null;
}

/** The customer's owner, when that is someone other than `me`. */
export const otherOwner = (
  ownerId: string | null | undefined,
  me: string | null
): string | null => (ownerId && ownerId !== me ? ownerId : null);

/**
 * "Transfer to owner": an owner other than me, on an extension other than
 * mine (the transfer route answers 409 for a transfer to myself).
 */
export const canTransferToOwner = (
  ownerId: string | null | undefined,
  me: string | null,
  ownerExtension: string | null | undefined,
  myExtension: string
): boolean =>
  Boolean(
    otherOwner(ownerId, me) && ownerExtension && ownerExtension !== myExtension
  );

/**
 * When the last WhatsApp message was sent: the time alone today, else
 * the date too (and the year when not this year), so last week's message
 * never reads as this morning's. "Today" is judged in `timeZone` (the
 * browser's when unset), the zone the time is printed in.
 */
export function messageWhen(
  at: string,
  now: number,
  { locale, timeZone }: { locale?: string; timeZone?: string } = {}
): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  // en-CA writes YYYY-MM-DD: a day key in the printed zone.
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone });
  const [mine, today] = [day(d), day(new Date(now))];
  const time = d.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
  if (mine === today) return time;
  const date = d.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(mine.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
    timeZone,
  });
  return `${date}, ${time}`;
}

// ---------- The Calls screen's tabs ----------

/** /calls?tab=…, Missed calls being the default (no tab). */
export const CALLS_TABS = ['missed', 'log', 'people', 'unrouted'] as const;
export type CallsTab = (typeof CALLS_TABS)[number];

/** `?tab=` as the page reads it: anything else is Missed calls. */
export const callsTab = (tab: string | undefined): CallsTab =>
  (CALLS_TABS as readonly (string | undefined)[]).includes(tab)
    ? (tab as CallsTab)
    : 'missed';

/**
 * The tabs `role` is offered: By person to team leaders and up
 * (pbx_call_report), Unrouted to owners and admins
 * (canViewUnroutedCalls, as the list route refuses the scope below).
 * With no role yet, the tabs everyone has.
 */
export function visibleCallTabs(role: AccountRole | null): CallsTab[] {
  return CALLS_TABS.filter((k) =>
    k === 'people'
      ? role !== null && hasMinRole(role, 'team_leader')
      : k === 'unrouted'
        ? role !== null && canViewUnroutedCalls(role)
        : true
  );
}
