import {
  legOf,
  legsOf,
  mergeCallLegs,
  withLeg,
  type CallLeg,
} from './call-legs';
import type { CallDirection, CallEndEvent } from './yeastar/events';

/**
 * Plans the repair of one calls row stored before legs were merged
 * (scripts/pbx-repair-call-legs.ts). Pure: the script does the reading
 * and the guarded write.
 */

export interface RepairRow {
  id: string;
  direction: string | null;
  status: string | null;
  talk_seconds: number | null;
  ring_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;
  answered_at: string | null;
  extension: string | null;
  user_id: string | null;
  pbx_uid: string | null;
  meta: unknown;
}

/** Exactly the columns the repair may write. */
export interface RepairPatch {
  status: string;
  talk_seconds: number;
  ring_seconds: number;
  started_at: string | null;
  ended_at: string | null;
  answered_at: string | null;
  extension: string | null;
  user_id: string | null;
  pbx_uid: string;
  meta: Record<string, unknown>;
}

export interface RepairPlan {
  patch: RepairPatch;
  /** Old and new of what the dry run prints. */
  changes: Record<
    | 'status'
    | 'talk_seconds'
    | 'ring_seconds'
    | 'started_at'
    | 'extension'
    | 'user_id',
    { from: string | number | null; to: string | number | null }
  >;
  /** Whether any written column differs from the stored row. */
  changed: boolean;
  /** The merged call is answered, so an open missed-call task is stale. */
  answered: boolean;
}

const sameTime = (a: string | null, b: string | null) =>
  a === b ||
  (!!a &&
    !!b &&
    Date.parse(a) === Date.parse(b) &&
    !Number.isNaN(Date.parse(a)));

/** The row as every one of its stored end events would have made it. */
export function planCallRepair(
  row: RepairRow,
  events: CallEndEvent[],
  extensions: ReadonlyMap<string, { user_id: string | null }>
): RepairPlan | null {
  if (events.length === 0) return null;
  const direction = (row.direction as CallDirection | null) ?? 'inbound';
  // From the stored events alone: they are every leg the PBX sent, and
  // legs a build keyed on uid wrote (11:25-11:27 UTC on 2026-10-27) lack
  // `peer`, so would not match their own event and count twice.
  let legs: CallLeg[] = [];
  for (const ev of events) legs = withLeg(legs, legOf(ev, direction)).legs;
  const merged = mergeCallLegs(legs, {
    extensions,
    existingExtension: row.extension,
  });
  const meta =
    typeof row.meta === 'object' &&
    row.meta !== null &&
    !Array.isArray(row.meta)
      ? (row.meta as Record<string, unknown>)
      : {};
  const patch: RepairPatch = {
    status: merged.status,
    talk_seconds: merged.talkSeconds,
    ring_seconds: merged.ringSeconds,
    started_at: merged.startedAt ?? row.started_at,
    ended_at: merged.endedAt ?? row.ended_at,
    answered_at: merged.answered
      ? (merged.answeredAt ?? row.answered_at)
      : row.answered_at,
    extension: merged.extension,
    user_id: row.user_id ?? merged.userId,
    pbx_uid: merged.uid,
    meta: { ...meta, cdr_legs: legs },
  };
  const changes: RepairPlan['changes'] = {
    status: { from: row.status, to: patch.status },
    talk_seconds: { from: row.talk_seconds, to: patch.talk_seconds },
    ring_seconds: { from: row.ring_seconds, to: patch.ring_seconds },
    started_at: { from: row.started_at, to: patch.started_at },
    extension: { from: row.extension, to: patch.extension },
    user_id: { from: row.user_id, to: patch.user_id },
  };
  const changed =
    row.status !== patch.status ||
    row.talk_seconds !== patch.talk_seconds ||
    row.ring_seconds !== patch.ring_seconds ||
    !sameTime(row.started_at, patch.started_at) ||
    !sameTime(row.ended_at, patch.ended_at) ||
    !sameTime(row.answered_at, patch.answered_at) ||
    row.extension !== patch.extension ||
    row.user_id !== patch.user_id ||
    row.pbx_uid !== patch.pbx_uid ||
    JSON.stringify(legsOf(row.meta)) !== JSON.stringify(legs);
  return { patch, changes, changed, answered: merged.answered };
}
