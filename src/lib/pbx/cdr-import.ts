import { ANSWERED_STATUSES, legOf } from './call-legs';
import type { CdrRecord } from './yeastar/api';
import { cdrRecordToCallEnd, dedupeRecords } from './yeastar/cdr';
import type { CallEndEvent } from './yeastar/events';

/**
 * The planning half of scripts/pbx-import-cdr.ts, which imports a PBX's
 * past call records (calls made before the live feed was connected).
 * Pure: the script does the reads and the ingest.
 */

/** The longest window one run may import (the CDR backfill's cap too). */
export const IMPORT_MAX_WINDOW_MS = 24 * 60 * 60_000;

/** Null when the window can be imported, else why not. */
export function importWindowError(
  from: Date,
  to: Date,
  now: Date
): string | null {
  if (Number.isNaN(from.getTime())) return '--from is not a valid time';
  if (Number.isNaN(to.getTime())) return '--to is not a valid time';
  if (from >= to) return '--from must be before --to';
  if (to > now) return '--to is in the future';
  if (to.getTime() - from.getTime() > IMPORT_MAX_WINDOW_MS) {
    return 'the window is longer than 24 hours';
  }
  return null;
}

export interface ExtensionTotals {
  /** Calls to import with a leg on this extension. */
  calls: number;
  /** Of those, the calls a leg on this extension answered. */
  answered: number;
  talkSeconds: number;
}

export interface CdrImportPlan {
  /** CDR rows fetched, repeats included. */
  rows: number;
  /** Rows after dropping identical repeats. */
  distinctRows: number;
  /** Rows the call-end mapper rejected: never ingested. */
  unparsed: number;
  /** Distinct call ids among the parsed rows. */
  calls: number;
  /** Call ids that already have a calls row: the live feed owns them. */
  existing: string[];
  /** Call ids to import. */
  importCalls: string[];
  /** The rows to ingest: grouped by call, each call's legs in fetch order. */
  toImport: CdrRecord[];
  /** Per extension (`(none)` for a leg with none), over the calls to import. */
  perExtension: Map<string, ExtensionTotals>;
}

/**
 * Dedupes whole records (same-uid rows that differ are legs of one
 * call), parses each, and leaves out every call id already stored:
 * a CDR leg need not key-match its webhook twin, so merging into a
 * live row could add a leg twice.
 */
export function planCdrImport(
  rows: readonly CdrRecord[],
  existingCallIds: ReadonlySet<string>
): CdrImportPlan {
  const distinct = dedupeRecords(rows);
  const byCall = new Map<string, { record: CdrRecord; ev: CallEndEvent }[]>();
  let unparsed = 0;
  for (const record of distinct) {
    const parsed = cdrRecordToCallEnd(record);
    if (!parsed.ok) {
      unparsed++;
      continue;
    }
    const list = byCall.get(parsed.event.callId) ?? [];
    list.push({ record, ev: parsed.event });
    byCall.set(parsed.event.callId, list);
  }
  const existing: string[] = [];
  const importCalls: string[] = [];
  const toImport: CdrRecord[] = [];
  const perExtension = new Map<string, ExtensionTotals>();
  for (const [callId, legs] of byCall) {
    if (existingCallIds.has(callId)) {
      existing.push(callId);
      continue;
    }
    importCalls.push(callId);
    const touched = new Map<string, { answered: boolean; talk: number }>();
    for (const { record, ev } of legs) {
      toImport.push(record);
      const leg = legOf(ev, ev.direction ?? 'inbound');
      const ext = leg.extension ?? '(none)';
      const t = touched.get(ext) ?? { answered: false, talk: 0 };
      t.answered ||= ANSWERED_STATUSES.has(leg.status);
      t.talk += leg.talk_seconds;
      touched.set(ext, t);
    }
    for (const [ext, t] of touched) {
      const sum = perExtension.get(ext) ?? {
        calls: 0,
        answered: 0,
        talkSeconds: 0,
      };
      sum.calls++;
      if (t.answered) sum.answered++;
      sum.talkSeconds += t.talk;
      perExtension.set(ext, sum);
    }
  }
  return {
    rows: rows.length,
    distinctRows: distinct.length,
    unparsed,
    calls: byCall.size,
    existing,
    importCalls,
    toImport,
    perExtension,
  };
}
