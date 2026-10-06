/**
 * Test helpers: a TypeSafe API simulator plugged into the REAL SDK via its
 * `fetch` option (so SDK validation, retries, timeouts and error classes are
 * exercised), plus an in-memory policy/log store. The SQL side (four-eyes,
 * RLS, append-only, retention) is asserted by supabase/ci/verify-typesafe.sql.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, type Ts013Config } from './config';
import { createDecisionLayer, type DecisionLayer } from './index';
import { DEFAULT_THRESHOLDS } from './policy';
import { QS_VERSION } from './questions/triage';
import type { DecisionRow, TsStore } from './store';

export const TEST_ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

// ---------------------------------------------------------------------------
// TypeSafe simulator
// ---------------------------------------------------------------------------

type QSpec =
  | number // noul probability, or score expectation
  | string // choice label (confidence 0.9)
  | { choice: string; confidence: number }
  | { score: number; confidence?: number };

export type SimReply =
  | { answers?: Record<string, QSpec>; model?: string }
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | 'hang';

export interface SimCall {
  body: {
    state: unknown;
    model: string;
    questions: Record<
      string,
      { type: string; criteria?: unknown; instructions?: unknown }
    >;
  };
  headers: Record<string, string>;
  raw: string;
}

export function makeSim(
  handler: (body: SimCall['body'], n: number) => SimReply = () => ({})
) {
  const calls: SimCall[] = [];
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const raw = String(init?.body ?? '');
    const body = JSON.parse(raw) as SimCall['body'];
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
    );
    calls.push({ body, headers, raw });

    if (!headers.Authorization?.startsWith('Bearer '))
      return json(401, { detail: 'missing key' });
    // Same validation the real API applies (spec §3)
    const qs = Object.entries(body.questions ?? {});
    if (!body.model || qs.length === 0)
      return json(422, { detail: 'model and questions required' });
    for (const [id, q] of qs) {
      if (q.type === 'choice') {
        const n = Object.keys(q.criteria as object).length;
        if (n < 1 || n > 255)
          return json(422, { detail: `${id}: 1..255 options` });
      }
      if (q.type === 'score') {
        const n = (q.criteria as unknown[]).length;
        if (n < 2 || n > 10)
          return json(422, { detail: `${id}: 2..10 levels` });
      }
    }

    const reply = handler(body, calls.length);
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    }
    if ('status' in reply)
      return json(
        reply.status,
        reply.body ?? { detail: 'error' },
        reply.headers
      );

    const answers: Record<string, unknown> = {};
    for (const [id, q] of qs) answers[id] = answer(q, reply.answers?.[id]);
    return json(200, {
      model: reply.model ?? 'jev-1.13.0',
      answers,
      usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20 },
    });
  };
  return { fetch, calls };
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function answer(
  q: { type: string; criteria?: unknown },
  spec: QSpec | undefined
): unknown {
  if (q.type === 'noul')
    return { type: 'noul', noul: typeof spec === 'number' ? spec : 0.05 };
  if (q.type === 'choice') {
    const labels = Object.keys(q.criteria as object);
    const want =
      typeof spec === 'string'
        ? { choice: spec, confidence: 0.9 }
        : spec && typeof spec === 'object' && 'choice' in spec
          ? spec
          : {
              choice: labels.includes('not_stated') ? 'not_stated' : labels[0]!,
              confidence: 0.9,
            };
    if (!labels.includes(want.choice))
      throw new Error(`sim: ${want.choice} not in ${labels.join(',')}`);
    const n = labels.length;
    const peak = n === 1 ? 1 : (want.confidence * (n - 1) + 1) / n;
    const rest = n === 1 ? 0 : (1 - peak) / (n - 1);
    const probabilities = Object.fromEntries(
      labels.map((l) => [l, l === want.choice ? peak : rest])
    );
    return {
      type: 'choice',
      choice: want.choice,
      probabilities,
      confidence: want.confidence,
    };
  }
  // score
  const levels = (q.criteria as unknown[]).length;
  const s =
    typeof spec === 'number'
      ? { score: spec }
      : spec && typeof spec === 'object' && 'score' in spec
        ? spec
        : { score: 0 };
  const lo = Math.floor(s.score),
    hi = Math.min(levels - 1, lo + 1),
    frac = s.score - lo;
  const probabilities: Record<string, number> = {};
  const legend: Record<string, unknown> = {};
  (q.criteria as unknown[]).forEach((c, i) => {
    legend[String(i)] = c;
    probabilities[String(i)] = 0;
  });
  probabilities[String(lo)] = 1 - frac;
  if (hi !== lo)
    probabilities[String(hi)] = (probabilities[String(hi)] ?? 0) + frac;
  return {
    type: 'score',
    score: s.score,
    legend,
    probabilities,
    confidence: s.confidence ?? 0.9,
  };
}

// ---------------------------------------------------------------------------
// Config + layer factory
// ---------------------------------------------------------------------------

export function testConfig(over: Partial<Ts013Config> = {}): Ts013Config {
  return {
    ...DEFAULT_CONFIG,
    enabled: {
      triage: true,
      guardrail: true,
      passages: true,
      eligibility: true,
    },
    accounts: '*',
    shadow: false,
    shadowLanguages: [],
    timeoutMs: 80,
    guardrailTimeoutMs: 80,
    maxRetries: 0,
    ...over,
  };
}

/** Every check's input, with `accountId` defaulted to TEST_ACCOUNT. */
type AccountDefaulted<F> = F extends (input: infer I) => infer R
  ? (input: Omit<I, 'accountId'> & { accountId?: string }) => R
  : never;
type TestLayer = Omit<
  DecisionLayer,
  'triage' | 'guardrail' | 'passages' | 'eligibility'
> & {
  [K in 'triage' | 'guardrail' | 'passages' | 'eligibility']: AccountDefaulted<
    DecisionLayer[K]
  >;
};

export function makeLayer(opts: {
  sim: ReturnType<typeof makeSim>;
  config?: Partial<Ts013Config>;
  store?: TsStore;
  now?: () => Date;
}) {
  const alerts: {
    level: string;
    code: string;
    check?: string;
    message: string;
  }[] = [];
  const inner = createDecisionLayer({
    config: testConfig(opts.config),
    apiKey: 'test-key',
    fetch: opts.sim.fetch,
    alert: (e) => alerts.push(e),
    store: opts.store,
    now: opts.now,
  });
  const acct = <I extends { accountId: string }>(
    i: Omit<I, 'accountId'> & { accountId?: string }
  ) => ({ accountId: TEST_ACCOUNT, ...i }) as I;
  const layer: TestLayer = {
    ...inner,
    triage: (i) => inner.triage(acct(i)),
    guardrail: (i) => inner.guardrail(acct(i)),
    passages: (i) => inner.passages(acct(i)),
    eligibility: (i) => inner.eligibility(acct(i)),
  };
  return { layer, alerts };
}

/**
 * In-memory stand-in for the DB: returns an approved active policy (default
 * thresholds, pinned model) for each listed check, records log inserts.
 * `failPolicy` makes policy reads throw (simulated DB outage).
 */
export function approvedDb(
  opts: { checks?: string[]; model?: string; failPolicy?: () => boolean } = {}
) {
  const checks = opts.checks ?? [
    'triage',
    'guardrail',
    'passages',
    'eligibility',
  ];
  const inserts: DecisionRow[] = [];
  const store: TsStore = {
    async activePolicy(_accountId, check) {
      if (opts.failPolicy?.()) throw new Error('db down');
      if (!checks.includes(check)) return null;
      return {
        version: 7,
        model_id: opts.model ?? 'jev-1.13.0',
        question_set_version: QS_VERSION,
        thresholds: DEFAULT_THRESHOLDS[check],
        shadow: false,
      };
    },
    async insertDecision(row) {
      inserts.push(row);
      return randomUUID();
    },
  };
  return { store, inserts };
}
