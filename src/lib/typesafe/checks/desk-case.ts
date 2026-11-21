/**
 * Desk case suggestion judgment (lib/desk/suggest.ts, migration 235):
 * one TypeSafe request that picks which candidate case a tray document
 * most likely belongs to, or says it cannot tell.
 *
 * Not a safety check, so it ignores the account's switches, reads no
 * policy and writes no decision-log row. It goes through the gateway (PII
 * guard, size budget, its own `desk_case` breaker, never throws) and runs
 * only for accounts the install allows. Every text is redacted and
 * clipped; candidates are ordinals. A failure is `{ ok: false }`.
 */
import { accountEnabled } from '../config';
import type { ErrorCode, TypeSafeGateway } from '../client';
import type { Ts013Config } from '../config';
import {
  buildDeskCaseQuestions,
  DESK_CASE_MAX_CANDIDATES,
  type DeskCaseState,
} from '../questions/desk-case';
import { redactClipped } from './common';

export interface DeskCaseCandidate {
  bank: string;
  product: string | null;
  stillNeeds: string[];
}

export interface DeskCaseJudgmentInput {
  accountId: string;
  kind: string | null;
  mime: string | null;
  fileName: string | null;
  caption: string | null;
  candidates: DeskCaseCandidate[];
  deadlineMs?: number;
}

export type DeskCaseJudgment =
  | {
      ok: true;
      /** Index into `candidates`, or null when Jev cannot tell. */
      index: number | null;
      /** P(the chosen answer). */
      p: number;
      /** P(the runner-up case), to spot equal matches. */
      pRunnerUp: number;
      latencyMs: number;
    }
  | {
      ok: false;
      errorCode: ErrorCode | 'MODEL_MISMATCH' | 'NO_CANDIDATES';
      latencyMs: number;
    };

export const DESK_CASE_DEADLINE_MS = 4000;

export function buildDeskCaseState(
  input: Pick<
    DeskCaseJudgmentInput,
    'kind' | 'mime' | 'fileName' | 'caption' | 'candidates'
  >
): DeskCaseState {
  const cases: DeskCaseState['cases'] = {};
  input.candidates.slice(0, DESK_CASE_MAX_CANDIDATES).forEach((c, k) => {
    cases[`c${k + 1}`] = {
      bank: redactClipped(c.bank, 40),
      product: redactClipped(c.product ?? '', 80),
      still_needs: c.stillNeeds.slice(0, 12).map((d) => redactClipped(d, 60)),
    };
  });
  return {
    document: {
      kind: redactClipped(input.kind ?? '', 20),
      type: redactClipped(input.mime ?? '', 60),
      file_name: redactClipped(input.fileName ?? '', 120),
      caption: redactClipped(input.caption ?? '', 300),
    },
    cases,
  };
}

export async function runDeskCaseJudgment(
  deps: { config: Ts013Config; gateway: TypeSafeGateway },
  input: DeskCaseJudgmentInput
): Promise<DeskCaseJudgment> {
  if (!accountEnabled(deps.config, input.accountId))
    return { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
  const n = Math.min(input.candidates.length, DESK_CASE_MAX_CANDIDATES);
  if (n === 0) return { ok: false, errorCode: 'NO_CANDIDATES', latencyMs: 0 };
  const res = await deps.gateway.ask(
    'desk_case',
    buildDeskCaseState(input),
    buildDeskCaseQuestions(n),
    input.accountId,
    { deadlineMs: input.deadlineMs ?? DESK_CASE_DEADLINE_MS }
  );
  if (!res.ok)
    return { ok: false, errorCode: res.errorCode, latencyMs: res.latencyMs };
  if (res.modelMismatch)
    return { ok: false, errorCode: 'MODEL_MISMATCH', latencyMs: res.latencyMs };
  const a = (
    res.result.answers as unknown as Record<
      string,
      | {
          choice?: string;
          confidence?: number;
          probabilities?: Record<string, number>;
        }
      | undefined
    >
  ).case;
  const pick = a?.choice ?? 'unsure';
  const probs = a?.probabilities ?? {};
  const p =
    probs[pick] ?? (typeof a?.confidence === 'number' ? a.confidence : 0);
  const caseProbs = Object.entries(probs)
    .filter(([k]) => /^c\d+$/.test(k) && k !== pick)
    .map(([, v]) => v);
  const pRunnerUp = caseProbs.length ? Math.max(...caseProbs) : 0;
  const m = /^c(\d+)$/.exec(pick);
  const index = m ? Number(m[1]) - 1 : null;
  if (index !== null && (index < 0 || index >= n))
    return { ok: false, errorCode: 'BAD_RESPONSE', latencyMs: res.latencyMs };
  const clamp = (x: number) =>
    Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
  return {
    ok: true,
    index,
    p: clamp(p),
    pRunnerUp: clamp(pRunnerUp),
    latencyMs: res.latencyMs,
  };
}
