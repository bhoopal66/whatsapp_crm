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

/** JSON with object keys sorted, so key order never splits a duplicate. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * First occurrence per whole record, order kept. Overlapping backfill
 * windows and pages return the same row twice. Not per `uid`: Yeastar
 * gives every leg of a call the same uid (call-legs.ts `legKey`), so
 * same-uid rows that differ are distinct legs and all of them are kept.
 */
export function dedupeRecords<T>(records: readonly T[]): T[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = stableJson(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
