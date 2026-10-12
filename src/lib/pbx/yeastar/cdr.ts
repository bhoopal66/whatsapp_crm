import type { CdrRecord } from './api';
import {
  buildCallEnd,
  type CallEndEvent,
  type ParseResult,
  type PbxTimeOptions,
} from './events';

const first = (record: CdrRecord, ...keys: string[]): unknown => {
  for (const key of keys) {
    const v = record[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/**
 * A `cdr/search` row as the (30012) Call End event it would have been,
 * so a gap backfilled from CDR stores the same row the live event would
 * have. Field names differ: `duration` / `disposition` / `record_file` /
 * `did` / `call_type` here, `call_duration` / `status` / `recording` /
 * `did_number` / `type` there; both spellings are read.
 *
 * The start time prefers `timestamp` (Unix seconds, in every documented
 * row) over `time`, which is in the PBX's display format and zone.
 * `call_from_number` beats `call_from` ("Phillip Huff<1001>").
 */
export function cdrRecordToCallEnd(
  record: CdrRecord,
  opts: PbxTimeOptions = {}
): ParseResult<CallEndEvent> {
  return buildCallEnd(
    {
      callId: record.call_id,
      uid: record.uid,
      type: first(record, 'call_type', 'type'),
      from: first(record, 'call_from_number', 'call_from'),
      to: first(record, 'call_to_number', 'call_to'),
      time: first(record, 'timestamp', 'time', 'time_start'),
      callSeconds: first(record, 'duration', 'call_duration'),
      talkSeconds: record.talk_duration,
      status: first(record, 'disposition', 'last_status', 'status'),
      recording: first(record, 'record_file', 'recording'),
      didNumber: first(record, 'did_number', 'did'),
      didName: record.did_name,
    },
    record,
    opts
  );
}

/**
 * First occurrence per `uid`, order kept. Overlapping backfill windows
 * and pages return the same row twice; a row without a uid is kept (the
 * mapper rejects it with a reason).
 */
export function dedupeByUid<T extends { uid?: unknown }>(
  records: readonly T[]
): T[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    if (typeof r.uid !== 'string' || r.uid === '') return true;
    if (seen.has(r.uid)) return false;
    seen.add(r.uid);
    return true;
  });
}
