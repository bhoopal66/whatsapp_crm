/**
 * Compass status -> case stage suggestions (migration 151, Settings ->
 * Cases): Jev reads one Compass status name and says which of the
 * account's case stages it means, or that it names none. A suggestion
 * only: an admin accepts it through case_status_map_set (source
 * 'suggestion'), and nothing is mapped without that.
 *
 * Not a safety check — no account switch, policy or ts_decision_log row.
 * Stages are offered under ordinal keys (o1…oN) and mapped back on our
 * side, so a stage name never has to be a valid option key.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new STATUS_MAP_QS_VERSION.
 */
import { choice } from '@typesafe-ai/sdk';

export const STATUS_MAP_QS_VERSION = 'qs-status-map-v1';

/** The option meaning "no stage": the case stays where it is. */
export const NO_STAGE_KEY = 'no_stage';

export const STATUS_MAP_INSTRUCTION =
  'Compass, the submission system, reported the status in `status` for a credit application. Which case stage does that status mean? `known_mappings` shows how other statuses map.';

export const NO_STAGE_DESCRIPTION =
  "The status does not say where the application is in the bank's process; keep the case where it is.";

/** Choice allows 255 options; one is no_stage. */
export const MAX_STAGE_OPTIONS = 254;

export interface StatusMapState {
  status: string;
  known_mappings: { status: string; stage: string }[];
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}

/**
 * One Choice `stage`: o1…oN in the order given (description = the stage
 * name) plus no_stage. `keyMap` turns an ordinal key back into the stage.
 */
export function buildStatusMapQuestions(stages: string[]) {
  const list = stages.slice(0, MAX_STAGE_OPTIONS);
  const keyMap: Record<string, string> = {};
  const criteria: Record<string, string> = {};
  list.forEach((stage, i) => {
    keyMap[`o${i + 1}`] = stage;
    criteria[`o${i + 1}`] = stage;
  });
  criteria[NO_STAGE_KEY] = NO_STAGE_DESCRIPTION;
  return {
    questions: { stage: choice(STATUS_MAP_INSTRUCTION, criteria) },
    keyMap,
  };
}
