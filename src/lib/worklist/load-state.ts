/**
 * What My worklist holds across its reads. A part that could not be read
 * keeps its last good rows (`stale`); with none to keep it is `missing`,
 * so the page says so instead of "Nothing needs action". Pure.
 */
import type { WorklistInputs } from './rank';

/** The parts of the list, as a person would name them. */
export const WORKLIST_PARTS = ['hr', 'drafts', 'cases'] as const;
export type WorklistPart = (typeof WORKLIST_PARTS)[number];

/** The most cases the list reads; past it, it says so. */
export const WORKLIST_CASE_MAX = 1000;

export interface WorklistRead {
  /** A failed part's rows are empty here; see `mergeWorklistLoad`. */
  inputs: WorklistInputs;
  failed: readonly WorklistPart[];
  /** More cases exist than were read (`WORKLIST_CASE_MAX`). */
  casesTruncated: boolean;
}

export interface WorklistLoad {
  inputs: WorklistInputs;
  /** Failed and never read. */
  missing: readonly WorklistPart[];
  /** Failed this time; the rows are from an earlier read. */
  stale: readonly WorklistPart[];
  /** As in `WorklistRead`, of the cases held here. */
  casesTruncated: boolean;
}

/** One read landing on what is held (null: nothing yet). */
export function mergeWorklistLoad(
  prev: WorklistLoad | null,
  next: WorklistRead
): WorklistLoad {
  const keeps = (part: WorklistPart) =>
    prev !== null && next.failed.includes(part) && !prev.missing.includes(part);
  const from = (part: WorklistPart) =>
    prev !== null && keeps(part) ? prev.inputs : next.inputs;
  return {
    inputs: {
      // HR chats, their tasks and their rule rank together: one part.
      hrConversations: from('hr').hrConversations,
      hrTasks: from('hr').hrTasks,
      hrRules: from('hr').hrRules,
      drafts: from('drafts').drafts,
      cases: from('cases').cases,
    },
    missing: next.failed.filter((p) => !keeps(p)),
    stale: next.failed.filter(keeps),
    casesTruncated:
      prev !== null && keeps('cases')
        ? prev.casesTruncated
        : next.casesTruncated,
  };
}

/**
 * `failed`: nothing could be read, so there is no list. `partial`: some
 * of it is missing, so an empty list proves nothing. `stale`: all there,
 * some of it old.
 */
export type WorklistLoadStatus = 'ok' | 'stale' | 'partial' | 'failed';

export function worklistLoadStatus(
  load: Pick<WorklistLoad, 'missing' | 'stale'>
): WorklistLoadStatus {
  if (load.missing.length === WORKLIST_PARTS.length) return 'failed';
  if (load.missing.length > 0) return 'partial';
  return load.stale.length > 0 ? 'stale' : 'ok';
}
