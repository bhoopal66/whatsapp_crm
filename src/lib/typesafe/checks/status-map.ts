/**
 * Compass status -> case stage suggestion (lib/cases/status-map.ts): one
 * TypeSafe request that says which case stage a Compass status means.
 *
 * Not a safety check: it ignores the account's switches, reads no policy
 * and writes no decision-log row. It goes through the same gateway — PII
 * guard, size budget, its own `status_map` breaker, never throws — and
 * only runs for accounts the install allows (TS_ACCOUNT_IDS) on an
 * install with an API key. A failure is `{ ok: false }`, and the settings
 * card simply shows no suggestion.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  buildStatusMapQuestions,
  NO_STAGE_KEY,
  type StatusMapState,
} from '../questions/status-map';
import { redactClipped } from './common';

export interface StatusMapInput {
  accountId: string;
  /** The Compass status name (or its sample label). */
  status: string;
  /** The stages a status may map to, in the account's order. */
  stages: string[];
  /** Examples shown to Jev; at most MAX_KNOWN_MAPPINGS are sent. */
  knownMappings?: { status: string; stage: string }[];
  /** Hard deadline for the whole call, retries included. Default 4000 ms. */
  deadlineMs?: number;
}

export type StatusMapJudgment =
  | {
      ok: true;
      /** The suggested stage; null means no_stage. */
      stage: string | null;
      p: number;
      runnerUp: { stage: string | null; p: number } | null;
      latencyMs: number;
    }
  | {
      ok: false;
      errorCode: ErrorCode | 'MODEL_MISMATCH' | 'NO_STAGES';
      latencyMs: number;
    };

export const STATUS_MAP_DEADLINE_MS = 4000;
export const MAX_KNOWN_MAPPINGS = 12;
const MAX_STATUS_CHARS = 200;

/** Redacted TypeSafe state for one status. */
export function buildStatusMapState(
  input: Pick<StatusMapInput, 'status' | 'knownMappings'>
): StatusMapState {
  return {
    status: redactClipped(input.status, MAX_STATUS_CHARS),
    known_mappings: (input.knownMappings ?? [])
      .slice(0, MAX_KNOWN_MAPPINGS)
      .map((m) => ({
        status: redactClipped(m.status, MAX_STATUS_CHARS),
        stage: redactClipped(m.stage, MAX_STATUS_CHARS),
      })),
  };
}

export async function runStatusMapSuggestion(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: StatusMapInput
): Promise<StatusMapJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  if (input.stages.length === 0)
    return { ok: false, errorCode: 'NO_STAGES', latencyMs: 0 };
  const { questions, keyMap } = buildStatusMapQuestions(input.stages);
  const res = await deps.gateway.ask(
    'status_map',
    buildStatusMapState(input),
    questions,
    input.accountId,
    { deadlineMs: input.deadlineMs ?? STATUS_MAP_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const a = res.result.answers.stage;
  const probs = (a as { probabilities?: Record<string, number> }).probabilities;
  const keys = [...Object.keys(keyMap), NO_STAGE_KEY];
  const ranked = keys
    .map((k) => ({
      k,
      p: probs?.[k] ?? (k === a.choice ? a.confidence : 0),
    }))
    .sort((x, y) => y.p - x.p);
  const toStage = (k: string) => (k === NO_STAGE_KEY ? null : keyMap[k]!);
  // The answer's own choice leads, whatever the spread says.
  const top = ranked.find((r) => r.k === a.choice) ?? ranked[0]!;
  const second = ranked.find((r) => r.k !== top.k);
  return {
    ok: true,
    stage: toStage(top.k),
    p: top.p,
    runnerUp: second ? { stage: toStage(second.k), p: second.p } : null,
    latencyMs: res.latencyMs,
  };
}
