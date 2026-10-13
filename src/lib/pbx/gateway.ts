import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { pbxApiFor, PbxConnectionError, type PbxHandle } from './connection';
import { ingestPbxEvent } from './process';
import { CDR_MAX_PAGE_SIZE, type CdrRecord } from './yeastar/api';
import { dedupeByUid } from './yeastar/cdr';
import { YEASTAR_EVENT } from './yeastar/events';
import { YeastarError } from './yeastar/errors';
import { DEFAULT_TOPICS, wsUrl } from './yeastar/ws';

/**
 * The server side of the WebSocket gateway (scripts/pbx-gateway.mjs):
 * a plain Node process that holds the Yeastar event socket and posts
 * every frame here. It authenticates with PBX_GATEWAY_SECRET and never
 * sees the PBX credentials: the session route mints (or reuses) the
 * shared API token and hands back only the socket URL that embeds it.
 */

export const GATEWAY_SECRET_HEADER = 'x-gateway-secret';
/** A backfill window longer than this is cut to its last 24 hours. */
export const BACKFILL_MAX_WINDOW_MS = 24 * 60 * 60_000;
const BACKFILL_PAGE_SIZE = 1_000;
/** Yeastar tokens live 30 minutes; the gateway reconnects before that. */
export const GATEWAY_REFRESH_AFTER_MS = 25 * 60_000;

const digest = (s: string) => crypto.createHash('sha256').update(s).digest();

/**
 * Null when the request carries the gateway secret; otherwise the
 * response to send: 503 when PBX_GATEWAY_SECRET is unset (fail closed),
 * 401 on a missing or wrong secret. Compared as SHA-256 digests in
 * constant time, so neither the value nor its length leaks.
 */
export function gatewayAuthError(request: Request): Response | null {
  const expected = process.env.PBX_GATEWAY_SECRET?.trim();
  if (!expected) {
    return Response.json({ error: 'gateway not configured' }, { status: 503 });
  }
  const supplied = request.headers.get(GATEWAY_SECRET_HEADER) ?? '';
  if (!crypto.timingSafeEqual(digest(supplied), digest(expected))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export class GatewayConfigError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

/** PBX_CONNECTION_ID, else the only configured connection. */
export async function gatewayConnectionId(db: SupabaseClient): Promise<string> {
  const pinned = process.env.PBX_CONNECTION_ID?.trim();
  if (pinned) return pinned;
  const { data, error } = await db
    .from('pbx_connections')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(2);
  if (error) throw new Error(`pbx_connections read failed: ${error.message}`);
  const rows = (data ?? []) as { id: string }[];
  if (rows.length === 0) {
    throw new GatewayConfigError(404, 'no PBX connection is configured');
  }
  if (rows.length > 1) {
    throw new GatewayConfigError(
      409,
      'several PBX connections: set PBX_CONNECTION_ID for this gateway'
    );
  }
  return rows[0].id;
}

export interface GatewaySession {
  connectionId: string;
  /** Embeds a live access token: the gateway must never log it. */
  wsUrl: string;
  topics: number[];
  refreshAfterMs: number;
}

export async function gatewaySession(
  db: SupabaseClient,
  open: (db: SupabaseClient, id: string) => Promise<PbxHandle> = pbxApiFor
): Promise<GatewaySession> {
  const connectionId = await gatewayConnectionId(db);
  const { connection, tokens } = await open(db, connectionId);
  const token = await tokens.getAccessToken();
  return {
    connectionId,
    wsUrl: wsUrl(connection.baseUrl, token),
    topics: [...DEFAULT_TOPICS],
    refreshAfterMs: GATEWAY_REFRESH_AFTER_MS,
  };
}

const firstOf = (r: CdrRecord, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/**
 * A `cdr/search` row as the raw (30012) Call End frame the socket would
 * have carried, in the event's own field names, so the processor treats
 * it exactly like a live event (the same reading as `cdrRecordToCallEnd`).
 */
export function cdrRecordToEventFrame(record: CdrRecord): {
  type: number;
  msg: Record<string, unknown>;
} {
  const msg: Record<string, unknown> = {
    call_id: record.call_id,
    uid: record.uid,
    type: firstOf(record, 'call_type', 'type'),
    call_from: firstOf(record, 'call_from_number', 'call_from'),
    call_to: firstOf(record, 'call_to_number', 'call_to'),
    time_start: firstOf(record, 'timestamp', 'time', 'time_start'),
    call_duration: firstOf(record, 'duration', 'call_duration'),
    talk_duration: record.talk_duration,
    status: firstOf(record, 'disposition', 'last_status', 'status'),
    recording: firstOf(record, 'record_file', 'recording'),
    did_number: firstOf(record, 'did_number', 'did'),
    did_name: record.did_name,
  };
  for (const k of Object.keys(msg)) if (msg[k] === undefined) delete msg[k];
  return { type: YEASTAR_EVENT.CALL_END, msg };
}

export interface BackfillResult {
  connectionId: string;
  from: string;
  to: string;
  records: number;
  ingested: number;
  duplicates: number;
  failed: number;
}

/**
 * Re-reads the call records of a gap (the socket was down) and ingests
 * each as its 30012 frame. The window is capped to its last 24 hours
 * and never reaches past now; the processor's dedupe makes an overlap
 * with events that did arrive harmless.
 */
export async function backfillCdr(input: {
  db: SupabaseClient;
  connectionId: string;
  from: Date;
  to: Date;
  now?: Date;
  open?: (db: SupabaseClient, id: string) => Promise<PbxHandle>;
}): Promise<BackfillResult> {
  const { db, connectionId } = input;
  const now = input.now ?? new Date();
  const to = new Date(Math.min(input.to.getTime(), now.getTime()));
  const from = new Date(
    Math.max(input.from.getTime(), to.getTime() - BACKFILL_MAX_WINDOW_MS)
  );
  const result: BackfillResult = {
    connectionId,
    from: from.toISOString(),
    to: to.toISOString(),
    records: 0,
    ingested: 0,
    duplicates: 0,
    failed: 0,
  };
  if (from >= to) return result;
  const { api } = await (input.open ?? pbxApiFor)(db, connectionId);
  const pageSize = Math.min(BACKFILL_PAGE_SIZE, CDR_MAX_PAGE_SIZE);
  const all: CdrRecord[] = [];
  for (let page = 1; ; page++) {
    const { total, records } = await api.searchCdr({
      startTime: from,
      endTime: to,
      page,
      pageSize,
    });
    all.push(...records);
    if (records.length < pageSize || all.length >= total) break;
  }
  const records = dedupeByUid(all);
  result.records = records.length;
  for (const record of records) {
    const res = await ingestPbxEvent({
      db,
      connectionId,
      payload: cdrRecordToEventFrame(record),
      via: 'gateway',
    });
    if (res.duplicate) result.duplicates++;
    else if (res.error) result.failed++;
    else result.ingested++;
  }
  return result;
}

/**
 * Keeps the latest backfill on its connection (`last_backfill_at`,
 * `last_backfill`, migration 104) for Settings → Phone system. An empty
 * window is recorded too: the gap was checked and nothing was missing.
 * Never throws: a failed write is logged, and the gateway still gets
 * its answer.
 */
export async function recordBackfill(
  db: SupabaseClient,
  result: BackfillResult,
  at: Date = new Date()
): Promise<void> {
  const { connectionId, ...summary } = result;
  try {
    const { error } = await db
      .from('pbx_connections')
      .update({ last_backfill_at: at.toISOString(), last_backfill: summary })
      .eq('id', connectionId);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(
      `[pbx-gateway] ${connectionId}: backfill not recorded:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * A failure as the gateway's answer. Messages name the cause (no token
 * or credential ever appears in them); `retryable` failures are 503 so
 * the gateway backs off and tries again.
 */
export function gatewayErrorResponse(err: unknown): Response {
  if (err instanceof GatewayConfigError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof PbxConnectionError) {
    const status = err.code === 'auth_backoff' ? 503 : 409;
    return Response.json({ error: err.message, code: err.code }, { status });
  }
  if (err instanceof YeastarError) {
    const status = err.isAuthFailure || err.isIpBlocked ? 409 : 502;
    return Response.json({ error: err.message }, { status });
  }
  console.error('[pbx-gateway]', err instanceof Error ? err.message : err);
  return Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
}
