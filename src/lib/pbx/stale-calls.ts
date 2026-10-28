import type { SupabaseClient } from '@supabase/supabase-js';

import { pbxApiFor, type PbxHandle } from './connection';
import { cdrRecordToEventFrame } from './gateway';
import { ingestPbxEvent } from './process';
import { CDR_MAX_PAGE_SIZE, type CdrRecord } from './yeastar/api';
import { dedupeRecords } from './yeastar/cdr';

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
/** Calls per run; a backlog drains over runs, oldest first. */
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
/** A runaway window (a busy PBX) stops paging here; the rest waits. */
const MAX_PAGES = 10;

/**
 * Where `meta` records a call settled without its CDR. migration 089's
 * CHECK has no "unknown" status, so the status chosen (see
 * `unsettledStatus`) is a best guess and this says so.
 */
export const UNSETTLED_META_KEY = 'settled_without_cdr';

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
    .select('id, connection_id, pbx_call_id, status, started_at, meta')
    .in('status', ['ringing', 'in_progress'])
    .lt('started_at', new Date(startedAt - STALE_CALL_AFTER_MS).toISOString())
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
    // Oldest first already; one read covers at most a day, so calls past
    // it wait for a later run.
    const first = Date.parse(all[0].started_at);
    const calls = all.filter(
      (r) =>
        Date.parse(r.started_at) - first <=
        STALE_MAX_WINDOW_MS - 2 * STALE_WINDOW_PAD_MS
    );
    const last = Date.parse(calls[calls.length - 1].started_at);
    const wanted = new Set(calls.map((r) => r.pbx_call_id));
    let records: CdrRecord[];
    try {
      const { api } = await open(db, connectionId);
      const fetched: CdrRecord[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await api.searchCdr({
          startTime: new Date(first - STALE_WINDOW_PAD_MS),
          endTime: new Date(Math.min(last + STALE_WINDOW_PAD_MS, now())),
          page,
          pageSize: PAGE_SIZE,
        });
        fetched.push(...res.records);
        if (res.records.length < PAGE_SIZE || fetched.length >= res.total) {
          break;
        }
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
      continue;
    }

    const failedCalls = new Set<string>();
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
      } else if (!res.duplicate) summary.ingested++;
    }

    // How many the ingest settled, read back: a record may be a duplicate
    // of a frame already processed, which writes nothing.
    if (records.length) {
      const check = await db
        .from('calls')
        .select('pbx_call_id')
        .eq('connection_id', connectionId)
        .in('pbx_call_id', [...wanted])
        .in('status', ['ringing', 'in_progress']);
      if (check.error) {
        summary.errors[connectionId] =
          `calls read failed: ${check.error.message}`;
      } else {
        summary.settled +=
          wanted.size - ((check.data ?? []) as unknown[]).length;
      }
    }

    // A day on, a call still live had no CDR (or one that settles
    // nothing): settle it here so it stops being retried. One whose
    // ingest just failed waits: that failure is transient.
    for (const row of calls) {
      if (out()) break;
      if (failedCalls.has(row.pbx_call_id)) continue;
      if (startedAt - Date.parse(row.started_at) < STALE_GIVE_UP_AFTER_MS) {
        continue;
      }
      // Compare-and-set on the status read: a row the ingest above (or a
      // late live end) settled is left as written. Nothing here rings,
      // opens a task or settles a call-back.
      const upd = await db
        .from('calls')
        .update({
          status: unsettledStatus(row.status),
          meta: {
            ...(row.meta ?? {}),
            [UNSETTLED_META_KEY]: {
              at: new Date(now()).toISOString(),
              was: row.status,
            },
          },
        })
        .eq('id', row.id)
        .eq('status', row.status)
        .select('id');
      if (upd.error) {
        summary.errors[connectionId] =
          `calls update failed: ${upd.error.message}`;
        continue;
      }
      if (((upd.data ?? []) as unknown[]).length) summary.givenUp++;
    }
  }
  return summary;
}
