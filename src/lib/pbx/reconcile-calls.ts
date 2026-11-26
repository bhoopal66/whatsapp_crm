import type { SupabaseClient } from '@supabase/supabase-js';

import { ANSWERED_STATUSES, legOf, mergeCallLegs } from './call-legs';
import { planCdrImport } from './cdr-import';
import { PbxConnectionError, pbxApiFor, type PbxHandle } from './connection';
import { cdrRecordToEventFrame } from './gateway';
import { ingestPbxEvent } from './process';
import { clearLive } from './stale-calls';
import {
  CDR_MAX_PAGE_SIZE,
  type CdrRecord,
  type YeastarApi,
} from './yeastar/api';
import { dedupeRecords } from './yeastar/cdr';
import { isMissedCall, parseYeastarEvent } from './yeastar/events';

/**
 * Calls the CRM never heard of, because the PBX could not reach it. The
 * PBX cron reads the last hour of the PBX's call records (CDR) and
 * ingests the calls with no `calls` row, or one still live whose end was
 * lost (`lostCalls`), as scripts/pbx-import-cdr.ts does: `historical`, so
 * nothing rings. The one exception is a customer
 * call nobody answered, still young enough to act on: its last leg runs
 * as a live end, which opens the ordinary task and bell once (they dedupe
 * on the call's row id).
 *
 * Calls that started over an hour ago are not recovered here: the
 * gateway's 24 h backfill covers those when the gateway runs.
 */

/** The cron step runs at most this often per process. */
export const RECONCILE_INTERVAL_MS = 15 * 60_000;
/** How far back one CDR read goes. */
export const RECONCILE_WINDOW_MS = 60 * 60_000;
/**
 * Only calls over for this long: a CDR leg need not key-match its webhook
 * twin, so racing a webhook (or a retry of one) could store a leg twice.
 */
export const RECONCILE_GRACE_MS = 10 * 60_000;
/** A missed call that ended longer ago than this is recorded, not rung. */
export const RECONCILE_RING_MAX_MS = 60 * 60_000;
/**
 * A call first seen this close to the window's start may have an earlier
 * leg (the answered one) outside it: recorded, not rung. In the ordinary
 * run of things an earlier pass has had it already.
 */
export const RECONCILE_EDGE_MS = 5 * 60_000;
const PAGE_SIZE = Math.min(1_000, CDR_MAX_PAGE_SIZE);
/** Call ids per calls read: they travel in the URL. */
const CHUNK = 100;

export interface ReconcileSummary {
  /** Connections whose CDR was read. */
  connections: number;
  /** Calls recorded this run. */
  recovered: number;
  /** Of those, missed calls run as live: their task and bell. */
  rung: number;
  /** Legs whose ingest failed. */
  failed: number;
  /** Connections that could not be read, by id. */
  errors: Record<string, string>;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const LIVE = ['ringing', 'in_progress'];

/**
 * The live rows of calls that are over on the PBX, by call id: their end
 * event was lost. The PBX's own list of calls up now decides, as a call
 * can have CDR records of its finished legs (a queue nobody answered, a
 * transferred leg) while the customer is still on the line. Read before
 * the CDR, so a call off this list has its legs in that. Empty when the
 * list cannot be read: those calls stay stale-calls.ts's.
 */
async function lostCalls(
  db: SupabaseClient,
  connectionId: string,
  api: YeastarApi,
  windowStart: number,
  nowMs: number
): Promise<Map<string, string>> {
  const { data, error } = await db
    .from('calls')
    .select('pbx_call_id, status')
    .eq('connection_id', connectionId)
    .in('status', LIVE)
    .gte('started_at', new Date(windowStart).toISOString())
    .lt('started_at', new Date(nowMs - RECONCILE_GRACE_MS).toISOString());
  if (error) throw new Error(`calls read failed: ${error.message}`);
  const lost = new Map(
    ((data ?? []) as { pbx_call_id: string; status: string }[]).map((r) => [
      r.pbx_call_id,
      r.status,
    ])
  );
  if (!lost.size) return lost;
  try {
    for (const type of ['inbound', 'outbound', 'internal'] as const) {
      for (const c of await api.queryCalls({ type })) lost.delete(c.callId);
    }
  } catch (err) {
    console.warn(
      `[pbx-reconcile] ${connectionId}: calls in progress not read (${message(err)}); ${lost.size} live rows left`
    );
    return new Map();
  }
  return lost;
}

/**
 * Which of `callIds` the CRM has: a row that ended, or a live one that is
 * not (or, read again, no longer is as it was) among the lost.
 */
async function knownCalls(
  db: SupabaseClient,
  connectionId: string,
  callIds: string[],
  lost: ReadonlyMap<string, string>
): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < callIds.length; i += CHUNK) {
    const { data, error } = await db
      .from('calls')
      .select('pbx_call_id, status')
      .eq('connection_id', connectionId)
      .in('pbx_call_id', callIds.slice(i, i + CHUNK));
    if (error) throw new Error(`calls read failed: ${error.message}`);
    for (const r of (data ?? []) as { pbx_call_id: string; status: string }[]) {
      if (lost.get(r.pbx_call_id) !== r.status) known.add(r.pbx_call_id);
    }
  }
  return known;
}

/** One call's records, as what to ingest. Null: not now. */
function planCall(
  records: CdrRecord[],
  windowStart: number,
  nowMs: number
): {
  frames: ReturnType<typeof cdrRecordToEventFrame>[];
  ring: boolean;
  answered: boolean;
} | null {
  // Records that differ only outside the frame are one event (same hash),
  // which a live last leg must not lose to its historical twin.
  const legs = dedupeRecords(records.map(cdrRecordToEventFrame)).flatMap(
    (frame) => {
      // Read back as the processor will read it.
      const parsed = parseYeastarEvent(frame);
      if (!parsed.ok || parsed.event.kind !== 'call_end') return [];
      return [
        {
          frame,
          leg: legOf(parsed.event, parsed.event.direction ?? 'inbound'),
        },
      ];
    }
  );
  if (!legs.length) return null;
  // Decided on the whole call: a ring group's unanswered legs are not a
  // missed call when a colleague answered another.
  const merged = mergeCallLegs(legs.map((l) => l.leg));
  // With no readable time, nothing says the call is over.
  if (!merged.startedAt || !merged.endedAt) return null;
  const endedAgo = nowMs - Date.parse(merged.endedAt);
  if (endedAgo < RECONCILE_GRACE_MS) return null;
  // Answered legs first: a run cut off half-way (its retry runs as live)
  // must never leave an answered call looking missed.
  const answered = (l: (typeof legs)[number]) =>
    ANSWERED_STATUSES.has(l.leg.status) ? 0 : 1;
  legs.sort((a, b) => answered(a) - answered(b));
  return {
    answered: merged.answered,
    frames: legs.map((l) => l.frame),
    ring:
      isMissedCall(merged.direction, merged.pbxStatus) &&
      endedAgo < RECONCILE_RING_MAX_MS &&
      Date.parse(merged.startedAt) - windowStart >= RECONCILE_EDGE_MS,
  };
}

export async function reconcileLostCalls(input: {
  db: SupabaseClient;
  now?: () => number;
  deadline?: number;
  open?: (db: SupabaseClient, id: string) => Promise<PbxHandle>;
}): Promise<ReconcileSummary> {
  const { db, now = Date.now, deadline, open = pbxApiFor } = input;
  const out = () => deadline !== undefined && now() >= deadline;
  const summary: ReconcileSummary = {
    connections: 0,
    recovered: 0,
    rung: 0,
    failed: 0,
    errors: {},
  };
  // A connection that never had an event was never set up to send any.
  const { data, error } = await db
    .from('pbx_connections')
    .select('id')
    .not('last_event_at', 'is', null);
  if (error) throw new Error(`pbx_connections read failed: ${error.message}`);

  for (const { id } of (data ?? []) as { id: string }[]) {
    if (out()) break;
    try {
      const { api } = await open(db, id);
      const readAt = now();
      const windowStart = readAt - RECONCILE_WINDOW_MS;
      const lost = await lostCalls(db, id, api, windowStart, readAt);
      const res = await api.searchCdr({
        startTime: new Date(windowStart),
        endTime: new Date(readAt),
        page: 1,
        pageSize: PAGE_SIZE,
      });
      summary.connections++;
      // A page cut short may lack a call's answered leg: nothing rings.
      const complete = res.records.length >= res.total;
      if (!complete) {
        console.warn(
          `[pbx-reconcile] ${id}: CDR read incomplete (${res.records.length} records); nothing rings this run`
        );
      }
      const callIds = [
        ...new Set(
          res.records
            .map((r) => r.call_id)
            .filter((c): c is string => typeof c === 'string' && c !== '')
        ),
      ];
      const plan = planCdrImport(
        res.records,
        await knownCalls(db, id, callIds, lost)
      );
      const byCall = new Map<string, CdrRecord[]>();
      for (const record of plan.toImport) {
        const callId = String(record.call_id);
        byCall.set(callId, [...(byCall.get(callId) ?? []), record]);
      }
      // Answered calls first: a missed call before one owes no call back.
      const calls = [...byCall]
        .flatMap(([callId, records]) => {
          const call = planCall(records, windowStart, now());
          return call ? [{ callId, call }] : [];
        })
        .sort((a, b) => Number(b.call.answered) - Number(a.call.answered));
      for (const { callId, call } of calls) {
        // Between calls only: a call started is recorded whole.
        if (out()) break;
        // An extension answered it and its answered leg is not in the CDR
        // read: not a missed call.
        if (lost.get(callId) === 'in_progress' && !call.answered) continue;
        // Its own event may have arrived since the read above.
        if ((await knownCalls(db, id, [callId], lost)).size) continue;
        const ring = call.ring && complete;
        let written = 0;
        for (const [i, frame] of call.frames.entries()) {
          const live = ring && i === call.frames.length - 1;
          const done = await ingestPbxEvent({
            db,
            connectionId: id,
            payload: frame,
            receivedAt: new Date(now()),
            historical: !live,
            keepClock: true,
          });
          if (done.error) {
            summary.failed++;
            // Nothing of the call is stored yet: the next run takes it
            // whole. A live leg that failed is the retry sweep's.
            if (!written) break;
          } else if (!done.duplicate) {
            written++;
            if (live) summary.rung++;
          }
        }
        if (written) summary.recovered++;
        // Historical leaves the screen pop; a live leg clears its own.
        if (written && !ring && lost.has(callId)) {
          await clearLive(db, id, callId);
        }
      }
    } catch (err) {
      // Not set up, or backing off after a refused login: not news.
      if (err instanceof PbxConnectionError) continue;
      summary.errors[id] = message(err);
      console.error(`[pbx-reconcile] ${id}: failed:`, message(err));
    }
  }
  return summary;
}
