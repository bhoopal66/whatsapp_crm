import type { SupabaseClient } from '@supabase/supabase-js';

import { pbxApiFor, type PbxHandle } from './connection';
import { cdrRecordToEventFrame } from './gateway';
import { ingestPbxEvent } from './process';
import {
  STALE_CHECKED_META_KEY,
  STALE_FAILURES_META_KEY,
  UNSETTLED_META_KEY,
  withoutStaleMarkers,
} from './stale-markers';
import { CDR_MAX_PAGE_SIZE, type CdrRecord } from './yeastar/api';
import { dedupeRecords } from './yeastar/cdr';

export { UNSETTLED_META_KEY } from './stale-markers';

/**
 * Calls left "live" because their call-end event (30012) never arrived
 * (a webhook backlog, 2026-10-27: 22 calls stuck ringing / in progress).
 * Nothing else ever settles them, so they stay on the live views, skew
 * the reports and never get their recording. This step, from the PBX
 * cron, asks the PBX's CDR for them and ingests each matching record in
 * `historical` mode: the ordinary call-end path writes status, talk time
 * and recording file (the recording fetch takes it from there), with no
 * task, bell or call-back settled, as scripts/pbx-import-cdr.ts does.
 */

/** A live call younger than this may simply still be live. */
export const STALE_CALL_AFTER_MS = 2 * 60 * 60_000;
/** With no CDR by now, the PBX never will have one: settle without it. */
export const STALE_GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/**
 * Calls per run. A backlog drains over runs: never-checked calls first,
 * then the least recently checked (`meta.stale_checked_at`), each oldest
 * start first, so calls whose read or ingest keeps failing go to the back.
 */
export const STALE_CALL_BATCH = 50;
/** The cron step runs at most this often per process. */
export const STALE_SWEEP_INTERVAL_MS = 15 * 60_000;
/**
 * The row's started_at is when the CRM saw the first frame; the CDR's is
 * the PBX's own start. They differ by seconds, padded generously.
 */
export const STALE_WINDOW_PAD_MS = 10 * 60_000;
/** One CDR read spans at most this (the backfill's and the import's cap). */
export const STALE_MAX_WINDOW_MS = 24 * 60 * 60_000;
const PAGE_SIZE = Math.min(1_000, CDR_MAX_PAGE_SIZE);
/**
 * A runaway window (a busy PBX) stops paging here; the rest waits, and a
 * read cut short gives nothing up (see settleStaleCalls).
 */
export const STALE_MAX_PAGES = 10;
/**
 * Runs in which a call's CDR was found but its ingest failed before that
 * stops counting as transient: past STALE_GIVE_UP_AFTER_MS the call is
 * then given up as one with no CDR, the count kept in the marker.
 */
export const STALE_MAX_INGEST_FAILURES = 5;

/**
 * No CDR after a day: the most honest terminal status 089 allows.
 * `in_progress` is written only once an extension answered, so the call
 * was answered (talk time unknown, left NULL). A `ringing` call's outcome
 * is unknown: `failed` (lowest rank among Yeastar's ends) rather than
 * `no_answer`, which would count it as a missed call nobody missed.
 */
export function unsettledStatus(status: string): 'answered' | 'failed' {
  return status === 'in_progress' ? 'answered' : 'failed';
}

/** A per-process once-per-interval gate (as the automations cron's). */
export function onceEvery(intervalMs: number): (nowMs: number) => boolean {
  let last = -Infinity;
  return (nowMs) => {
    if (nowMs - last < intervalMs) return false;
    last = nowMs;
    return true;
  };
}

export interface StaleCallsSummary {
  /** Live calls past STALE_CALL_AFTER_MS read this run. */
  found: number;
  /** CDR records ingested (a call may have several legs). */
  ingested: number;
  /** Of the calls found, those the CDR ingest settled. */
  settled: number;
  /** Settled without one after STALE_GIVE_UP_AFTER_MS (meta marks them). */
  givenUp: number;
  /** Records whose ingest failed: retried next run. */
  failed: number;
  /** Connections whose CDR read failed, by id: their calls wait. */
  errors: Record<string, string>;
}

interface StaleRow {
  id: string;
  connection_id: string;
  pbx_call_id: string;
  status: string;
  started_at: string;
  /** For compare-and-set: an event or a fetch may write meta meanwhile. */
  updated_at: string;
  meta: Record<string, unknown> | null;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export async function settleStaleCalls(input: {
  db: SupabaseClient;
  now?: () => number;
  deadline?: number;
  open?: (db: SupabaseClient, id: string) => Promise<PbxHandle>;
}): Promise<StaleCallsSummary> {
  const { db, now = Date.now, deadline, open = pbxApiFor } = input;
  const out = () => deadline !== undefined && now() >= deadline;
  const startedAt = now();
  const summary: StaleCallsSummary = {
    found: 0,
    ingested: 0,
    settled: 0,
    givenUp: 0,
    failed: 0,
    errors: {},
  };
  const { data, error } = await db
    .from('calls')
    .select(
      'id, connection_id, pbx_call_id, status, started_at, updated_at, meta'
    )
    .in('status', ['ringing', 'in_progress'])
    .lt('started_at', new Date(startedAt - STALE_CALL_AFTER_MS).toISOString())
    // Checked and left live: to the back. PostgREST orders by a json
    // path, and an ISO timestamp sorts as text in time order.
    .order(`meta->>${STALE_CHECKED_META_KEY}`, {
      ascending: true,
      nullsFirst: true,
    })
    .order('started_at', { ascending: true })
    .limit(STALE_CALL_BATCH);
  if (error) throw new Error(`calls read failed: ${error.message}`);
  const rows = (data ?? []) as StaleRow[];
  summary.found = rows.length;

  const byConnection = new Map<string, StaleRow[]>();
  for (const row of rows) {
    const list = byConnection.get(row.connection_id) ?? [];
    list.push(row);
    byConnection.set(row.connection_id, list);
  }

  for (const [connectionId, all] of byConnection) {
    if (out()) break;
    // One read covers at most a day from the oldest, so calls past it
    // wait for a later run (unstamped, so still near the front).
    all.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    const first = Date.parse(all[0].started_at);
    const calls = all.filter(
      (r) =>
        Date.parse(r.started_at) - first <=
        STALE_MAX_WINDOW_MS - 2 * STALE_WINDOW_PAD_MS
    );
    const last = Date.parse(calls[calls.length - 1].started_at);
    const wanted = new Set(calls.map((r) => r.pbx_call_id));
    let records: CdrRecord[];
    // Only a read of the whole window proves a call has no CDR. One the
    // budget, the page cap or a short count stopped may have missed the
    // record, so then nothing is given up on (what was read is ingested).
    let complete = false;
    try {
      const { api } = await open(db, connectionId);
      const fetched: CdrRecord[] = [];
      for (let page = 1; page <= STALE_MAX_PAGES; page++) {
        // Each page is a PBX request (up to ~10 s): never past the budget.
        if (out()) break;
        const res = await api.searchCdr({
          startTime: new Date(first - STALE_WINDOW_PAD_MS),
          endTime: new Date(Math.min(last + STALE_WINDOW_PAD_MS, now())),
          page,
          pageSize: PAGE_SIZE,
        });
        fetched.push(...res.records);
        if (res.records.length < PAGE_SIZE || fetched.length >= res.total) {
          complete = !(fetched.length < res.total);
          break;
        }
      }
      if (!complete) {
        console.warn(
          `[pbx-stale] ${connectionId}: CDR read incomplete (${fetched.length} records); nothing given up this run`
        );
      }
      records = dedupeRecords(fetched).filter((r) =>
        wanted.has(String(r.call_id ?? ''))
      );
    } catch (err) {
      // An unreachable PBX proves nothing about the calls: none is given
      // up on until a read succeeds.
      summary.errors[connectionId] = message(err);
      console.error(
        `[pbx-stale] ${connectionId}: CDR read failed:`,
        message(err)
      );
      // Still to the back of the next batch: a connection whose read
      // keeps failing (revoked credentials, a PBX gone offline) must not
      // hold the front of every batch and starve the other connections.
      const at = new Date(now()).toISOString();
      for (const row of calls) {
        if (out()) break;
        const stamp = await db
          .from('calls')
          .update({
            meta: { ...(row.meta ?? {}), [STALE_CHECKED_META_KEY]: at },
          })
          .eq('id', row.id)
          .eq('status', row.status)
          .eq('updated_at', row.updated_at);
        if (stamp.error) {
          console.error(
            `[pbx-stale] ${connectionId}: could not requeue call ${row.pbx_call_id}:`,
            stamp.error.message
          );
        }
      }
      continue;
    }

    const failedCalls = new Set<string>();
    const ingestedCalls = new Set<string>();
    for (const record of records) {
      if (out()) break;
      const res = await ingestPbxEvent({
        db,
        connectionId,
        payload: cdrRecordToEventFrame(record),
        historical: true,
      });
      if (res.error) {
        summary.failed++;
        failedCalls.add(String(record.call_id));
      } else {
        ingestedCalls.add(String(record.call_id));
        if (!res.duplicate) summary.ingested++;
      }
    }

    // How many the ingest settled, read back: a record may be a duplicate
    // of a frame already processed, which writes nothing. null: unknown.
    let stillLive: Set<string> | null = new Set(wanted);
    if (records.length) {
      const check = await db
        .from('calls')
        .select('pbx_call_id')
        .eq('connection_id', connectionId)
        .in('pbx_call_id', [...wanted])
        .in('status', ['ringing', 'in_progress']);
      if (check.error) {
        stillLive = null;
        summary.errors[connectionId] =
          `calls read failed: ${check.error.message}`;
      } else {
        const live = (check.data ?? []) as { pbx_call_id: string }[];
        stillLive = new Set(live.map((r) => r.pbx_call_id));
        summary.settled += wanted.size - stillLive.size;
      }
    }

    for (const row of calls) {
      if (out()) break;
      const id = row.pbx_call_id;
      if (stillLive && !stillLive.has(id)) {
        // Settled by the ingest above, whose historical mode leaves the
        // screen pop (call_live) behind. A live end that settled it
        // meanwhile cleared its own.
        if (ingestedCalls.has(id)) await clearLive(db, connectionId, id);
        continue;
      }
      const meta = row.meta ?? {};
      const before = Number(meta[STALE_FAILURES_META_KEY]);
      const failures =
        (Number.isFinite(before) ? before : 0) + (failedCalls.has(id) ? 1 : 0);
      // A day on, a call still live after a whole read had no CDR (or one
      // that settles nothing): settle it so it stops being retried. One
      // whose ingest just failed waits (transient), until that has
      // happened STALE_MAX_INGEST_FAILURES times.
      const giveUp =
        complete &&
        startedAt - Date.parse(row.started_at) >= STALE_GIVE_UP_AFTER_MS &&
        (!failedCalls.has(id) || failures >= STALE_MAX_INGEST_FAILURES);
      const at = new Date(now()).toISOString();
      // Compare-and-set on the status and updated_at read: a row the
      // ingest above (or a late live end) settled is left as written, and
      // a meta write meanwhile (ring/answer events, the recording fetch)
      // is never overwritten with the copy read for this batch; such a
      // row is simply looked at again next run. Nothing here rings, opens
      // a task or settles a call-back.
      const upd = await db
        .from('calls')
        .update(
          giveUp
            ? {
                status: unsettledStatus(row.status),
                meta: {
                  ...withoutStaleMarkers(meta),
                  [UNSETTLED_META_KEY]: {
                    at,
                    was: row.status,
                    ...(failures ? { ingest_failures: failures } : {}),
                  },
                },
              }
            : {
                // Left live: to the back of the next batch.
                meta: {
                  ...meta,
                  [STALE_CHECKED_META_KEY]: at,
                  ...(failures ? { [STALE_FAILURES_META_KEY]: failures } : {}),
                },
              }
        )
        .eq('id', row.id)
        .eq('status', row.status)
        .eq('updated_at', row.updated_at)
        .select('id');
      if (upd.error) {
        summary.errors[connectionId] =
          `calls update failed: ${upd.error.message}`;
        continue;
      }
      if (giveUp && ((upd.data ?? []) as unknown[]).length) {
        summary.givenUp++;
        if (failures) {
          console.warn(
            `[pbx-stale] ${connectionId}: call ${id} given up after ${failures} failed ingests`
          );
        }
        await clearLive(db, connectionId, id);
      }
    }
  }
  return summary;
}

/**
 * The screen pop of a call this step settled: neither the historical
 * ingest nor the give-up clears it, and pbx_purge would only a day
 * later. Best-effort: a failure is logged and left to that purge.
 */
export async function clearLive(
  db: SupabaseClient,
  connectionId: string,
  pbxCallId: string
): Promise<void> {
  const { error } = await db
    .from('call_live')
    .delete()
    .eq('connection_id', connectionId)
    .eq('pbx_call_id', pbxCallId);
  if (error) {
    console.error(
      `[pbx] ${connectionId}: call_live delete failed for ${pbxCallId}:`,
      error.message
    );
  }
}
