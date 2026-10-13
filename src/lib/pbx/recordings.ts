import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { pbxApiFor, PbxConnectionError, type PbxHandle } from './connection';
import { YeastarError } from './yeastar/errors';

/**
 * Copies each call's recording off the PBX once, into the private
 * `call-recordings` bucket (C-1, C-8). Only `recording_state = 'pending'`
 * is ever read, so a held (bank number), erased or not-stored call is
 * never fetched.
 *
 * Storing paused (`pbx_settings.store_recordings` false, migration 090):
 * a pending call of that workspace is marked `not_stored` before any
 * contact with the PBX (no token minted, nothing downloaded), and is
 * never fetched later, also once storing is switched back on. Nothing
 * on the PBX changes; it keeps recording.
 *
 * Past the retention period (migration 093): a pending call already
 * older than its workspace's period is marked `not_stored` the same
 * way, before any contact with the PBX, because the retention run that
 * follows would delete the copy at once. The age is the SQL rule's
 * ({@link retentionAgeFrom}); the PBX keeps its own copy. A period
 * nobody confirmed (retention_confirmed_at null) is none here, as it
 * is for the run.
 *
 * One download at a time: with the MP3 format the PBX serves one
 * recording download at once and answers 70651 to a second, so a busy
 * answer ends the run and the next run retries. Any other failure
 * counts in `calls.meta.recording_attempts`; the fifth marks the call
 * `failed`. The PBX's download URL lives 30 minutes and embeds a live
 * token: it is fetched here and never stored or logged.
 *
 * Announcement: the bilingual notice is configured on the PBX to play
 * before every recorded call (the design). The workspace's
 * `announcement_required` setting at fetch time is the basis, kept in
 * `calls.meta.announcement_basis`: `pbx_prompt` while required,
 * `not_required` while switched off. Only `pbx_prompt` marks the
 * recording (and the call) `announcement_played`: a recording fetched
 * while the notice was switched off is not known to be announced, so
 * pbx_recording_playable (089) holds it whenever the requirement is on.
 */

export const RECORDING_BUCKET = 'call-recordings';
export const MAX_RECORDING_ATTEMPTS = 5;

const DAY_MS = 86_400_000;

/**
 * Where a call's age starts for the retention period (ms): the later of
 * its start time as the PBX reported it and the CRM's own first record
 * of it (calls.created_at), so a wrong PBX clock cannot age a fresh
 * call. pbx_recording_age_from() (migration 093) is the SQL rule:
 * change both. Null when neither time reads.
 */
export function retentionAgeFrom(
  startedAt: unknown,
  createdAt: unknown
): number | null {
  const times = [startedAt, createdAt]
    .map((v) => (typeof v === 'string' ? Date.parse(v) : NaN))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/**
 * The call is already older than a retention period of `days` (null:
 * none): pbx_expire_recordings' test, with days of 24 hours as in the
 * database's UTC. An unreadable age is not past: the fetch goes ahead
 * and the retention run decides.
 */
export function pastRetention(
  call: { started_at?: unknown; created_at?: unknown },
  days: number | null,
  nowMs: number
): boolean {
  if (days === null) return false;
  const from = retentionAgeFrom(call.started_at, call.created_at);
  return from !== null && from < nowMs - days * DAY_MS;
}

type Row = Record<string, unknown>;
type FetchFn = (url: string) => Promise<Response>;

export interface FetchRecordingsInput {
  db: SupabaseClient;
  limit?: number;
  now?: () => number;
  /** Stop starting downloads at this time (ms). */
  deadline?: number;
  fetch?: FetchFn;
  apiFor?: (db: SupabaseClient, connectionId: string) => Promise<PbxHandle>;
}

export interface RecordingsSummary {
  fetched: number;
  /** Failed this run (counted), of which `gaveUp` reached the cap. */
  failed: number;
  gaveUp: number;
  /** Left for later: connection backing off or unusable. */
  skipped: number;
  /** The PBX answered 70651: the run stopped there. */
  busy: boolean;
  /** Marked `not_stored`: the workspace paused storing recordings. */
  notStored: number;
  /** Marked `not_stored` undownloaded: already past the retention period. */
  pastRetention: number;
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  gsm: 'audio/x-gsm',
};

function formatOf(file: string): string {
  const ext = /\.([a-z0-9]{2,4})$/i.exec(file)?.[1]?.toLowerCase();
  return ext && ext in CONTENT_TYPES ? ext : 'wav';
}

const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** A JSON body where audio should be is the PBX's error envelope. */
async function download(fetchFn: FetchFn, url: string): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`recording download answered ${res.status}`);
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    const body = (await res.json().catch(() => null)) as Row | null;
    const errcode = Number(body?.errcode);
    throw new YeastarError({
      endpoint: 'recording file',
      errcode: Number.isInteger(errcode) ? errcode : null,
      errmsg: String(body?.errmsg ?? 'not audio'),
    });
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchPendingRecordings(
  input: FetchRecordingsInput
): Promise<RecordingsSummary> {
  const { db, limit = 20, now = Date.now, deadline } = input;
  const fetchFn = input.fetch ?? ((url: string) => fetch(url));
  const apiFor = input.apiFor ?? ((d, id) => pbxApiFor(d, id, { now }));
  const summary: RecordingsSummary = {
    fetched: 0,
    failed: 0,
    gaveUp: 0,
    skipped: 0,
    busy: false,
    notStored: 0,
    pastRetention: 0,
  };

  const { data, error } = await db
    .from('calls')
    .select(
      'id, account_id, connection_id, recording_file, meta, started_at, created_at'
    )
    .eq('recording_state', 'pending')
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`calls read failed: ${error.message}`);

  const handles = new Map<string, PbxHandle | null>();
  const required = new Map<string, boolean>();
  const storing = new Map<
    string,
    { store: boolean; retentionDays: number | null }
  >();

  async function handleFor(connectionId: string): Promise<PbxHandle | null> {
    if (!handles.has(connectionId)) {
      try {
        handles.set(connectionId, await apiFor(db, connectionId));
      } catch (err) {
        if (!(err instanceof PbxConnectionError)) throw err;
        console.warn(`[pbx] recordings: ${connectionId}: ${err.code}`);
        handles.set(connectionId, null);
      }
    }
    return handles.get(connectionId) ?? null;
  }

  async function announcementRequired(accountId: string): Promise<boolean> {
    if (!required.has(accountId)) {
      const s = await db
        .from('pbx_settings')
        .select('announcement_required')
        .eq('account_id', accountId)
        .maybeSingle();
      if (s.error) throw new Error(`pbx_settings read: ${s.error.message}`);
      const v = (s.data as Row | null)?.announcement_required;
      required.set(accountId, v !== false);
    }
    return required.get(accountId)!;
  }

  /**
   * pbx_settings.store_recordings (090) and retention_days (093), the
   * period only once confirmed; no row stores and keeps.
   */
  async function storage(accountId: string) {
    if (!storing.has(accountId)) {
      const s = await db
        .from('pbx_settings')
        .select('store_recordings, retention_days, retention_confirmed_at')
        .eq('account_id', accountId)
        .maybeSingle();
      if (s.error) throw new Error(`pbx_settings read: ${s.error.message}`);
      const row = s.data as Row | null;
      const days = row?.retention_days;
      storing.set(accountId, {
        store: row?.store_recordings !== false,
        retentionDays:
          typeof days === 'number' && days > 0 && row?.retention_confirmed_at
            ? days
            : null,
      });
    }
    return storing.get(accountId)!;
  }

  for (const call of (data ?? []) as Row[]) {
    if (deadline !== undefined && now() >= deadline) break;
    const callId = String(call.id);
    const accountId = String(call.account_id);
    const meta = (call.meta ?? {}) as Row;
    const file =
      typeof call.recording_file === 'string' ? call.recording_file : '';
    try {
      // Paused, or already past the retention period: settle the call
      // without contacting the PBX.
      const kept = await storage(accountId);
      const tooOld =
        kept.store && pastRetention(call, kept.retentionDays, now());
      if (!kept.store || tooOld) {
        const skip = await db
          .from('calls')
          .update({ recording_state: 'not_stored' })
          .eq('id', callId)
          .eq('recording_state', 'pending');
        if (skip.error) throw new Error(`calls update: ${skip.error.message}`);
        if (tooOld) summary.pastRetention++;
        else summary.notStored++;
        continue;
      }
      if (!call.connection_id) throw new Error('the call has no PBX');
      if (!file) throw new Error('no recording file name');
      const handle = await handleFor(String(call.connection_id));
      if (!handle) {
        summary.skipped++;
        continue;
      }
      const url = await handle.api.recordingDownloadUrl({ file });
      const bytes = await download(fetchFn, url);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const format = formatOf(file);
      const storagePath = `account-${accountId}/calls/${callId}.${format}`;
      const up = await db.storage
        .from(RECORDING_BUCKET)
        .upload(storagePath, bytes, {
          contentType: CONTENT_TYPES[format],
          upsert: true,
        });
      if (up.error) throw new Error(`upload failed: ${up.error.message}`);
      const basis = (await announcementRequired(accountId))
        ? 'pbx_prompt'
        : 'not_required';
      const announced = basis === 'pbx_prompt';
      const rec = await db.from('call_recordings').upsert(
        {
          call_id: callId,
          account_id: accountId,
          storage_path: storagePath,
          sha256,
          bytes: bytes.byteLength,
          format,
          fetched_at: new Date(now()).toISOString(),
          announcement_played: announced,
        },
        { onConflict: 'call_id' }
      );
      if (rec.error) throw new Error(`call_recordings: ${rec.error.message}`);
      const done = await db
        .from('calls')
        .update({
          recording_state: 'fetched',
          announcement_played: announced,
          meta: { ...meta, announcement_basis: basis },
        })
        .eq('id', callId)
        .eq('recording_state', 'pending');
      if (done.error) throw new Error(`calls update: ${done.error.message}`);
      summary.fetched++;
    } catch (err) {
      if (err instanceof YeastarError && err.isRecordingDownloadBusy) {
        summary.busy = true;
        break;
      }
      if (
        err instanceof YeastarError &&
        (err.isAuthFailure || err.isIpBlocked)
      ) {
        // The connection's problem, not this recording's: no attempt spent.
        handles.set(String(call.connection_id), null);
        summary.skipped++;
        continue;
      }
      const attempts = Number(meta.recording_attempts ?? 0) + 1;
      const gaveUp = attempts >= MAX_RECORDING_ATTEMPTS;
      summary.failed++;
      if (gaveUp) summary.gaveUp++;
      console.warn(`[pbx] recording of call ${callId}: ${message(err)}`);
      const mark = await db
        .from('calls')
        .update({
          ...(gaveUp ? { recording_state: 'failed' } : {}),
          meta: {
            ...meta,
            recording_attempts: attempts,
            recording_error: message(err),
          },
        })
        .eq('id', callId)
        .eq('recording_state', 'pending');
      if (mark.error) {
        console.error(`[pbx] call ${callId}: ${mark.error.message}`);
      }
    }
  }
  return summary;
}
