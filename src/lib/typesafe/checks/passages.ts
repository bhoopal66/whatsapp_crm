/**
 * Check D — RAG passage filter. Hook 2: call after pgvector/keyword retrieval,
 * before building the prompt for the text-generation model.
 * One TypeSafe request per passage (each question is about one query–passage pair).
 */
import { DEFAULT_THRESHOLDS, type PassageThresholds } from '../policy';
import { detectLanguage } from '../redact';
import { PASSAGE_QUESTIONS, type PassageState } from '../questions/passages';
import { QS_VERSION } from '../questions/triage';
import {
  redactClipped,
  mapLimit,
  type CheckDeps,
  type DecisionMeta,
  type Ref,
  stateFor,
} from './common';
import { refOf } from './triage';

export interface RetrievedPassage {
  id: string;
  title: string;
  text: string;
  sourceType: string;
  similarity: number;
}

export type PassageRoute = 'include' | 'conflicting_evidence' | 'exclude';

export interface PassageDecision extends DecisionMeta {
  /** Use as the "Accepted evidence" block. */
  evidence: RetrievedPassage[];
  /** Use as a separate "Conflicting evidence" block. */
  conflicts: RetrievedPassage[];
  dropped: { passage: RetrievedPassage; reason: string }[];
}

type PassageAnswers = {
  is_relevant: { noul: number };
  contains_answer_evidence: { noul: number };
  contradicts_query_premise: { noul: number };
  contains_prompt_injection: { noul: number };
};

const MAX_QUERY_CHARS = 4000;
const MAX_TITLE_CHARS = 200;
const MAX_PASSAGE_CHARS = 2000;

/** First match wins — order from spec §6.4 / TypeSafe cookbook. */
export function routePassage(
  a: PassageAnswers,
  t: PassageThresholds
): { route: PassageRoute; reason: string } {
  if (a.contains_prompt_injection.noul > t.injectionMax)
    return { route: 'exclude', reason: 'INJECTION' };
  if (a.contradicts_query_premise.noul > t.contradictsMin)
    return { route: 'conflicting_evidence', reason: 'CONTRADICTS_PREMISE' };
  if (a.is_relevant.noul < t.relevantMin)
    return { route: 'exclude', reason: 'NOT_RELEVANT' };
  if (a.contains_answer_evidence.noul > t.evidenceMin)
    return { route: 'include', reason: 'EVIDENCE' };
  return { route: 'exclude', reason: 'NO_EVIDENCE' };
}

export async function runPassageFilter(
  deps: CheckDeps,
  input: Ref & { query: string; passages: RetrievedPassage[] }
): Promise<PassageDecision> {
  // Stable sort: equal scores keep retrieval order (lexical hits carry no
  // similarity, so they all tie at 0 behind the semantic ones).
  const ranked = [...input.passages].sort(
    (a, b) => b.similarity - a.similarity
  );

  // Off for this account (or on this install): no policy read, no
  // request, no log.
  const cs = await stateFor(deps, 'passages', input.accountId);
  if (!cs.on) {
    return {
      policyVersion: null,
      shadowReasons: ['DISABLED'],
      evidence: ranked.slice(0, DEFAULT_THRESHOLDS.passages.fallbackTopK),
      conflicts: [],
      dropped: [],
      act: false,
      shadow: true,
      fallbackUsed: false,
      errorCode: 'DISABLED',
      reasonCodes: [],
      modelId: null,
      decisionId: null,
      latencyMs: 0,
    };
  }

  const policy = await deps.policies.get('passages', input.accountId);
  const t = policy.thresholds;
  const screened = ranked.slice(0, deps.config.maxPassages);
  const fallbackTop = ranked.slice(0, t.fallbackTopK);

  const query = redactClipped(input.query, MAX_QUERY_CHARS);
  const results = await mapLimit(
    screened,
    deps.config.passageConcurrency,
    async (p, i) => {
      // The passage's own id stays here: a database UUID in the state can
      // read as an identifier to the PII guard, and no question uses it.
      const state: PassageState = {
        query,
        passage: {
          id: `p${i + 1}`,
          title: redactClipped(p.title, MAX_TITLE_CHARS),
          text: redactClipped(p.text, MAX_PASSAGE_CHARS),
          source_type: p.sourceType,
        },
      };
      return {
        p,
        res: await deps.gateway.ask(
          'passages',
          state,
          PASSAGE_QUESTIONS,
          input.accountId
        ),
      };
    }
  );

  const evidence: RetrievedPassage[] = [];
  const conflicts: RetrievedPassage[] = [];
  const dropped: PassageDecision['dropped'] = [];
  const answers: Record<string, unknown> = {};
  const reasons: string[] = [];
  let failures = 0;
  let tokens = 0;
  let latency = 0;
  let model: string | null = null;
  let mismatch = false;
  let errorCode: string | null = null;

  for (const { p, res } of results) {
    latency = Math.max(latency, res.latencyMs);
    if (!res.ok) {
      failures++;
      errorCode = res.errorCode;
      continue;
    }
    model = res.result.model;
    mismatch ||= res.modelMismatch;
    tokens += res.result.usage.input_tokens;
    const r = routePassage(res.result.answers, t);
    // Keyed by the real chunk id, with its route, so a person can label
    // each passage (the query-level decision is only a summary).
    answers[p.id] = {
      ...res.result.answers,
      route: r.route,
      reason: r.reason,
      request_id: res.requestId ?? null,
    };
    if (r.route === 'include') evidence.push(p);
    else if (r.route === 'conflicting_evidence') conflicts.push(p);
    else dropped.push({ passage: p, reason: r.reason });
    reasons.push(`${p.id}:${r.reason}`);
  }

  const fallbackUsed = failures > 0;
  // Any failed passage → whole query falls back to top-K by similarity (spec §9.1).
  const out = fallbackUsed
    ? {
        evidence: fallbackTop,
        conflicts: [] as RetrievedPassage[],
        dropped: [] as PassageDecision['dropped'],
      }
    : { evidence, conflicts, dropped };
  const lang = detectLanguage(input.query);
  const langShadow = cs.shadowLanguages.includes(lang);
  const shadow = cs.monitor || policy.shadow || mismatch || langShadow;
  const shadowReasons = [
    ...policy.shadowReasons,
    ...(cs.monitor ? ['MONITOR'] : []),
    ...(mismatch ? ['RESPONSE_MODEL_MISMATCH'] : []),
    ...(langShadow ? [`LANGUAGE_SHADOW:${lang}`] : []),
  ];
  const act = !shadow && !fallbackUsed;
  const decision = fallbackUsed
    ? 'fallback_top_k'
    : `include=${evidence.length};conflict=${conflicts.length};drop=${dropped.length}`;

  const decisionId = await deps.logger.write({
    check: 'passages',
    ...refOf(input),
    policyVersion: policy.version,
    modelId: model,
    questionSetVersion: QS_VERSION,
    language: detectLanguage(input.query),
    redactedState: { query, passages: screened.map((p) => p.id) },
    answers,
    decision,
    reasonCodes: fallbackUsed
      ? [...reasons, `FALLBACK:${failures}_FAILED`]
      : reasons,
    acted: act,
    shadow,
    fallbackUsed,
    latencyMs: latency,
    inputTokens: tokens || null,
    errorCode,
  });

  return {
    ...out,
    act,
    shadow,
    shadowReasons: [...new Set(shadowReasons)],
    fallbackUsed,
    errorCode,
    reasonCodes: reasons,
    policyVersion: policy.version,
    modelId: model,
    decisionId,
    latencyMs: latency,
  };
}
