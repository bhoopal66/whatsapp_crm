import type { CallDirection, CallEndEvent } from './yeastar/events';

/**
 * One call, several PBX records. Yeastar sends a 30012 (and keeps a CDR
 * row) per leg of a call: a ring group's unanswered extensions, the
 * voicemail after a NO ANSWER, each hop of a transfer, a FAILED tail
 * after a NO ANSWER. Each used to overwrite the calls row, so whichever
 * arrived last won: a trailing FAILED hid a 55 s no-answer, a voicemail
 * leg started the call 24 s late, a late NO ANSWER leg of a ring group
 * would undo the colleague's ANSWERED. The row now keeps every leg
 * (`calls.meta.cdr_legs`) and is computed from all of them, so arrival
 * order does not matter. Pure: process.ts and
 * scripts/pbx-repair-call-legs.ts share it.
 */

export type EndStatus =
  'answered' | 'no_answer' | 'busy' | 'voicemail' | 'abandoned' | 'failed';

export const ANSWERED_STATUSES = new Set(['ANSWERED', 'ANSWER']);
export const END_STATUS: Record<string, EndStatus> = {
  ANSWERED: 'answered',
  'NO ANSWER': 'no_answer',
  BUSY: 'busy',
  VOICEMAIL: 'voicemail',
  ABANDONED: 'abandoned',
  FAILED: 'failed',
};
/** Unanswered: the leg that names the call. Unknown statuses rank 0. */
const RANK: Record<string, number> = {
  VOICEMAIL: 5,
  BUSY: 4,
  'NO ANSWER': 3,
  ABANDONED: 2,
  FAILED: 1,
};
/** A transfer chain is a handful of legs; more is a loop, not a call. */
export const MAX_CDR_LEGS = 20;

/** One 30012 / CDR record, as kept in `calls.meta.cdr_legs`. */
export interface CallLeg {
  uid: string;
  /** The PBX's upper-cased status. */
  status: string;
  /** UTC ISO, or null when the PBX's time could not be read. */
  started_at: string | null;
  call_seconds: number;
  talk_seconds: number;
  /** Our side of the leg: `to` inbound, else `from` (may be a ring group). */
  extension: string | null;
  /** The other side: `from` inbound, else `to`. Tells transfer legs apart. */
  peer: string | null;
  /** The leg's own type, null when the PBX sent none of the three. */
  direction: CallDirection | null;
  recording?: string;
}

/** A leg with no type of its own reads as `fallback` (the row's direction). */
export function legOf(ev: CallEndEvent, fallback: CallDirection): CallLeg {
  const direction = ev.direction ?? fallback;
  const ours = direction === 'inbound' ? ev.to : ev.from;
  return {
    uid: ev.uid,
    status: ev.status,
    started_at: ev.startedAt,
    call_seconds: ev.callSeconds,
    talk_seconds: ev.talkSeconds,
    extension: ours || null,
    peer: (direction === 'inbound' ? ev.from : ev.to) || null,
    direction: ev.direction,
    ...(ev.recordingFile ? { recording: ev.recordingFile } : {}),
  };
}

const DIRECTIONS: readonly string[] = ['inbound', 'outbound', 'internal'];
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The legs stored on a row's meta; anything malformed is dropped. */
export function legsOf(meta: unknown): CallLeg[] {
  if (typeof meta !== 'object' || meta === null) return [];
  const raw = (meta as Record<string, unknown>).cdr_legs;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l): CallLeg[] => {
    if (typeof l !== 'object' || l === null) return [];
    const r = l as Record<string, unknown>;
    if (typeof r.uid !== 'string' || !r.uid) return [];
    const recording = strOrNull(r.recording);
    return [
      {
        uid: r.uid,
        status: typeof r.status === 'string' ? r.status : '',
        started_at: strOrNull(r.started_at),
        call_seconds: num(r.call_seconds),
        talk_seconds: num(r.talk_seconds),
        extension: strOrNull(r.extension),
        peer: strOrNull(r.peer),
        direction: DIRECTIONS.includes(r.direction as string)
          ? (r.direction as CallDirection)
          : null,
        ...(recording ? { recording } : {}),
      },
    ];
  });
}

const timeOf = (l: CallLeg) => (l.started_at ? Date.parse(l.started_at) : NaN);

/**
 * A leg's identity. Not its uid: Yeastar gives every leg of a call the
 * same uid (all 28 multi-leg calls on live, 2026-10-27), so keying on it
 * kept only the first leg. An identical record is a redelivery.
 */
export function legKey(l: CallLeg): string {
  return JSON.stringify([
    l.uid,
    l.status,
    l.started_at,
    l.call_seconds,
    l.talk_seconds,
    l.extension,
    l.peer,
  ]);
}

/** Earliest start first, untimed last, then by key: one order whatever arrived first. */
function byStart(a: CallLeg, b: CallLeg): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  const fa = Number.isFinite(ta);
  const fb = Number.isFinite(tb);
  if (fa !== fb) return fa ? -1 : 1;
  if (fa && ta !== tb) return ta - tb;
  const ka = legKey(a);
  const kb = legKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * `legs` with `leg` added. A leg already there (a redelivery, the same
 * leg from the backfill) changes nothing; past the cap the set keeps the
 * earliest legs, which is the same set in any arrival order.
 */
export function withLeg(
  legs: CallLeg[],
  leg: CallLeg
): { legs: CallLeg[]; added: boolean } {
  const key = legKey(leg);
  if (legs.some((l) => legKey(l) === key)) return { legs, added: false };
  const next = [...legs, leg].sort(byStart).slice(0, MAX_CDR_LEGS);
  return { legs: next, added: next.includes(leg) };
}

export interface MergedCall {
  status: EndStatus;
  /** The PBX's word for the deciding leg (task note, call-back settle). */
  pbxStatus: string;
  answered: boolean;
  /** From the legs only: inbound/outbound over internal; null when none says. */
  direction: CallDirection | null;
  /** The deciding leg's uid (calls.pbx_uid). */
  uid: string;
  talkSeconds: number;
  ringSeconds: number;
  /** Null when no leg has a time: the caller keeps its fallbacks. */
  startedAt: string | null;
  endedAt: string | null;
  /** Answered with a timed answered leg only. */
  answeredAt: string | null;
  extension: string | null;
  /** The extension's person, when mapped. */
  userId: string | null;
}

export interface MergeOptions {
  /** pbx_extensions of the connection, by extension number. */
  extensions?: ReadonlyMap<string, { user_id: string | null }>;
  /** The row's extension before this merge (a 30011 answerer, say). */
  existingExtension?: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The calls row from every leg.
 *
 * - Status: any ANSWERED leg answers the call; else the highest of
 *   voicemail > busy > no answer > abandoned > failed > unknown.
 * - Talk: the longest answered leg, never the sum (a transfer's legs
 *   overlap); unanswered, the deciding leg's (a voicemail's message).
 * - Start/end: the earliest start, the latest start + duration.
 * - Ring: answered, from the start to the first answer (a leg's start +
 *   its call − talk); else the whole span less talk.
 * - Extension: answered, an answered leg's known extension, a person's
 *   first, the earliest answer first; else as before the merge: the
 *   deciding leg's when known, else the row's own (unless it is just
 *   another leg's unknown number, written by an earlier merge), else
 *   the deciding leg's raw number.
 */
export function mergeCallLegs(
  legs: CallLeg[],
  opts: MergeOptions = {}
): MergedCall {
  if (legs.length === 0) throw new Error('mergeCallLegs: no legs');
  const sorted = [...legs].sort(byStart);
  const timed = sorted.filter((l) => Number.isFinite(timeOf(l)));
  const answeredLegs = sorted.filter((l) => ANSWERED_STATUSES.has(l.status));
  const answered = answeredLegs.length > 0;
  const answerAt = (l: CallLeg) =>
    timeOf(l) + Math.max(0, l.call_seconds - l.talk_seconds) * 1000;
  // Earliest answer first; untimed answered legs after, in start order.
  const byAnswer = [...answeredLegs].sort((a, b) => {
    const ta = answerAt(a);
    const tb = answerAt(b);
    const fa = Number.isFinite(ta);
    const fb = Number.isFinite(tb);
    if (fa !== fb) return fa ? -1 : 1;
    if (fa && ta !== tb) return ta - tb;
    return byStart(a, b);
  });
  const primary = answered
    ? byAnswer[0]
    : sorted.reduce((best, l) =>
        (RANK[l.status] ?? 0) > (RANK[best.status] ?? 0) ? l : best
      );

  const talk = Math.round(
    answered
      ? Math.max(...answeredLegs.map((l) => l.talk_seconds))
      : primary.talk_seconds
  );
  const startMs = timed.length ? Math.min(...timed.map(timeOf)) : null;
  const endMs = timed.length
    ? Math.max(...timed.map((l) => timeOf(l) + l.call_seconds * 1000))
    : null;

  let answeredAt: string | null = null;
  let ring: number;
  const firstAnswer = answered ? answerAt(byAnswer[0]) : NaN;
  if (answered && startMs !== null && Number.isFinite(firstAnswer)) {
    answeredAt = iso(firstAnswer);
    ring = (firstAnswer - startMs) / 1000;
  } else if (answered) {
    ring = primary.call_seconds - primary.talk_seconds;
  } else {
    const span =
      startMs !== null && endMs !== null
        ? (endMs - startMs) / 1000
        : Math.max(...sorted.map((l) => l.call_seconds));
    ring = span - talk;
  }

  const direction =
    sorted.find((l) => l.direction === 'inbound' || l.direction === 'outbound')
      ?.direction ??
    (sorted.some((l) => l.direction === 'internal') ? 'internal' : null);

  const exts = opts.extensions;
  const known = (e: string | null): e is string => !!e && !!exts?.has(e);
  const person = (e: string | null): e is string =>
    !!e && !!exts?.get(e)?.user_id;
  let extension: string | null = null;
  if (answered) {
    extension =
      byAnswer.find((l) => person(l.extension))?.extension ??
      byAnswer.find((l) => known(l.extension))?.extension ??
      null;
  }
  if (!extension) {
    const raw = primary.extension;
    const before = opts.existingExtension ?? null;
    const legNumbers = new Set(sorted.map((l) => l.extension));
    // A ring group's number is no one's: keep the extension that answered.
    extension = known(raw)
      ? raw
      : before && !legNumbers.has(before)
        ? before
        : (raw ?? before);
  }

  return {
    status: answered ? 'answered' : (END_STATUS[primary.status] ?? 'failed'),
    pbxStatus: primary.status,
    answered,
    direction,
    uid: primary.uid,
    talkSeconds: talk,
    ringSeconds: Math.max(0, Math.round(ring)),
    startedAt: startMs !== null ? iso(startMs) : null,
    endedAt: endMs !== null ? iso(endMs) : null,
    answeredAt,
    extension,
    userId: (extension && exts?.get(extension)?.user_id) || null,
  };
}

/**
 * The other extension of a call between colleagues: the first leg's
 * other side that is not `own`, else a leg's own side that is not.
 * Internal calls store no remote number, so the Calls screen named
 * them "Unknown caller" (2026-10-27). Null when no leg says.
 */
export function internalPeerExtension(
  meta: unknown,
  own: string | null
): string | null {
  const legs = legsOf(meta);
  const other = (v: string | null) => (v && v !== own ? v : null);
  for (const l of legs) {
    const p = other(l.peer);
    if (p) return p;
  }
  for (const l of legs) {
    const e = other(l.extension);
    if (e) return e;
  }
  return null;
}
