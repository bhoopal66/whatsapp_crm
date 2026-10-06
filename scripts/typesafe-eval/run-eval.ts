/**
 * Phase 3 evaluation runner (spec §12).
 *
 * Sends each labelled row through the SAME redaction, state builder and
 * question set as production, and stores TypeSafe's raw answers, so that
 * thresholds can be swept offline by calibrate.ts without re-calling the API.
 *
 *   TYPESAFE_API_KEY=… npx --yes tsx@4.23.15 scripts/typesafe-eval/run-eval.ts triage    scripts/typesafe-eval/labels_triage.synthetic.jsonl
 *   TYPESAFE_API_KEY=… npx --yes tsx@4.23.15 scripts/typesafe-eval/run-eval.ts guardrail scripts/typesafe-eval/labels_guardrail.synthetic.jsonl
 *   add --simulate to exercise the pipeline with a seeded fake model (no key, results marked SIMULATED)
 *
 * Output: <labels>.answers.jsonl (or .answers.SIMULATED.jsonl). Resumable: rows already
 * answered are skipped, so a rate-limited run can simply be restarted.
 */
import { appendFileSync, existsSync } from 'node:fs';
import type { Fetch } from '@typesafe-ai/sdk';
import { TypeSafeGateway } from '../../src/lib/typesafe/client';
import {
  DEFAULT_CONFIG,
  type Ts013Config,
} from '../../src/lib/typesafe/config';
import { buildGuardrailState } from '../../src/lib/typesafe/checks/guardrail';
import {
  buildTriageState,
  triageLanguage,
} from '../../src/lib/typesafe/checks/triage';
import { GUARDRAIL_QUESTIONS } from '../../src/lib/typesafe/questions/guardrail';
import {
  QS_VERSION,
  TRIAGE_QUESTIONS,
} from '../../src/lib/typesafe/questions/triage';
import { detectLanguage } from '../../src/lib/typesafe/redact';

import {
  readJsonl,
  type AnswerRow,
  type GuardrailLabel,
  type TriageLabel,
} from './common';

// ---- seeded fake model for --simulate --------------------------------------------
let seed = 7;
const rnd = () =>
  (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const between = (a: number, b: number) => a + (b - a) * rnd();
const INTENTS = Object.keys(TRIAGE_QUESTIONS.intent.criteria);

function simulateTriage(label: TriageLabel, lang: string) {
  const acc = lang === 'en' ? 0.95 : lang === 'ar' ? 0.9 : 0.82;
  const truth =
    label.expected.intent === 'n/a' ? 'other_banking' : label.expected.intent;
  const correct = rnd() < acc;
  const choice = correct
    ? truth
    : INTENTS.filter((i) => i !== truth)[
        Math.floor(rnd() * (INTENTS.length - 1))
      ]!;
  const conf = correct ? between(0.55, 0.98) : between(0.15, 0.65);
  const hard = /cancel|stop the|stop calling|ألغوا|أوقفوا/i.test(label.message);
  return {
    intent: { choice, confidence: conf },
    wants_human: label.expected.wants_human
      ? between(0.72, 0.99)
      : between(0, 0.25),
    non_partner_bank: between(0, 0.3),
    dissatisfied: truth === 'complaint' ? between(0.6, 0.95) : between(0, 0.3),
    instructs_assistant: between(0, 0.1),
    urgency: { score: between(0, 1.4), confidence: 0.8 },
    lead_temperature: { score: between(0, 2.5), confidence: 0.7 },
    opt_out: label.expected.opt_out
      ? rnd() < 0.96
        ? between(0.82, 0.99)
        : between(0.55, 0.8)
      : hard
        ? between(0.25, 0.6)
        : between(0, 0.15),
  };
}

function simulateGuardrail(label: GuardrailLabel) {
  const r = label.bot_reply;
  const n = () => between(0, 0.2);
  const hit = () => (rnd() < 0.93 ? between(0.75, 0.98) : between(0.4, 0.7));
  const a = {
    promises_approval:
      /definitely|approved|guarantee|مضمون/i.test(r) && label.seeded_dangerous
        ? hit()
        : n(),
    guarantees_timeline:
      /within \d+ (?:working )?days|in \d+ days/i.test(r) &&
      label.seeded_dangerous
        ? hit()
        : n(),
    unsupported_figure:
      /\d+ (?:days|months|years|documents)/i.test(r) && label.seeded_dangerous
        ? hit()
        : n(),
    non_partner_bank:
      /ADCB|HSBC|Emirates NBD|الإمارات دبي/i.test(r) && label.seeded_dangerous
        ? hit()
        : n(),
    unsupported_claim: /All banks|all banks/.test(r) ? hit() : n(),
    asks_secret:
      /OTP|CVV|card number|رمز التحقق/i.test(r) && label.seeded_dangerous
        ? hit()
        : n(),
    reveals_instructions: /system prompt|internal note/i.test(r) ? hit() : n(),
    shares_third_party: /Ahmed's file|his statements/i.test(r) ? hit() : n(),
    severity: {
      score: label.seeded_dangerous ? between(1.6, 2.9) : between(0, 0.7),
      confidence: 0.8,
    },
  };
  return a;
}

function simFetch(
  kind: 'triage' | 'guardrail',
  byState: Map<string, TriageLabel | GuardrailLabel>
): Fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const key = JSON.stringify(body.state);
    const label = byState.get(key)!;
    const raw =
      kind === 'triage'
        ? simulateTriage(
            label as TriageLabel,
            detectLanguage((label as TriageLabel).message)
          )
        : simulateGuardrail(label as GuardrailLabel);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(
      body.questions as Record<string, { type: string; criteria: unknown }>
    )) {
      const v = (raw as Record<string, unknown>)[id];
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: v };
      else if (q.type === 'choice') {
        const { choice, confidence } = v as {
          choice: string;
          confidence: number;
        };
        const labels = Object.keys(q.criteria as object);
        const peak = (confidence * (labels.length - 1) + 1) / labels.length;
        answers[id] = {
          type: 'choice',
          choice,
          confidence,
          probabilities: Object.fromEntries(
            labels.map((l) => [
              l,
              l === choice ? peak : (1 - peak) / (labels.length - 1),
            ])
          ),
        };
      } else {
        const { score, confidence } = v as {
          score: number;
          confidence: number;
        };
        const levels = (q.criteria as unknown[]).length;
        answers[id] = {
          type: 'score',
          score: Math.min(score, levels - 1),
          confidence,
          legend: {},
          probabilities: {},
        };
      }
    }
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers,
        usage: {
          input_tokens: Math.ceil(String(init?.body).length / 4),
          output_tokens: 20,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
}

// ---- runner --------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const simulate = args.includes('--simulate');
  const concIdx = args.indexOf('--concurrency');
  const concurrency = concIdx >= 0 ? Number(args[concIdx + 1]) : 4;
  const [check, file] = args.filter(
    (a, i) => !a.startsWith('--') && args[i - 1] !== '--concurrency'
  );
  if ((check !== 'triage' && check !== 'guardrail') || !file) {
    console.error(
      'usage: run-eval <triage|guardrail> <labels.jsonl> [--simulate] [--concurrency N]'
    );
    process.exit(2);
  }
  if (!simulate && !process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY is not set (or use --simulate)');
    process.exit(2);
  }

  const out = `${file}.answers${simulate ? '.SIMULATED' : ''}.jsonl`;
  const done = new Set(
    existsSync(out)
      ? readJsonl<AnswerRow>(out)
          .filter((r) => r.ok)
          .map((r) => r.id)
      : []
  );
  const rows = readJsonl<TriageLabel | GuardrailLabel>(file).filter(
    (r) => !done.has(r.id)
  );

  const states = rows.map((r) =>
    check === 'triage'
      ? buildTriageState({
          message: (r as TriageLabel).message,
          recentTurns: (r as TriageLabel).recent_turns,
          // The same stage values production sends (typesafe-gates.ts).
          journeyStage: (r as TriageLabel).journey_stage ?? 'open_conversation',
        })
      : buildGuardrailState({
          customerMessage: (r as GuardrailLabel).customer_message,
          botReply: (r as GuardrailLabel).bot_reply,
          evidence: (r as GuardrailLabel).evidence,
          context: (r as GuardrailLabel).context,
        })
  );
  const byState = new Map(states.map((s, i) => [JSON.stringify(s), rows[i]!]));

  const config: Ts013Config = {
    ...DEFAULT_CONFIG,
    enabled: {
      triage: true,
      guardrail: true,
      passages: false,
      eligibility: false,
    },
    timeoutMs: 15_000,
    guardrailTimeoutMs: 15_000,
    maxRetries: 3,
    breaker: { failureThreshold: 1_000, windowMs: 60_000, cooldownMs: 1 }, // evaluation: never trip
  };
  const alerts: string[] = [];
  const gw = new TypeSafeGateway({
    config,
    alert: (e) => alerts.push(`${e.code}: ${e.message}`),
    ...(simulate
      ? { apiKey: 'simulated', fetch: simFetch(check, byState) }
      : {}),
  });
  const questions = check === 'triage' ? TRIAGE_QUESTIONS : GUARDRAIL_QUESTIONS;

  console.log(
    `${check}: ${rows.length} to run (${done.size} already done) → ${out}${simulate ? '  [SIMULATED]' : ''}`
  );
  let next = 0,
    ok = 0,
    failed = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (next < rows.length) {
        const i = next++;
        const label = rows[i]!;
        const res = await gw.ask(check, states[i]!, questions);
        // Bucketed by the language production gates on: the triage
        // message (or, for a letterless reply, the assistant turn it
        // answers), and the guardrail's REPLY.
        const lang =
          check === 'triage'
            ? triageLanguage({
                message: (label as TriageLabel).message,
                recentTurns: (label as TriageLabel).recent_turns,
              })
            : detectLanguage((label as GuardrailLabel).bot_reply);
        const row: AnswerRow = {
          id: label.id,
          check,
          lang,
          ok: res.ok,
          errorCode: res.ok ? null : res.errorCode,
          model: res.ok ? res.result.model : null,
          qs: QS_VERSION,
          simulated: simulate,
          answers: res.ok
            ? (res.result.answers as Record<string, unknown>)
            : null,
          input_tokens: res.ok ? res.result.usage.input_tokens : null,
          latency_ms: res.latencyMs,
          label,
        };
        appendFileSync(out, `${JSON.stringify(row)}\n`);
        if (res.ok) ok++;
        else failed++;
        if ((ok + failed) % 50 === 0)
          console.log(`  ${ok + failed}/${rows.length}  (failed ${failed})`);
      }
    })
  );
  console.log(
    `done: ${ok} ok, ${failed} failed${alerts.length ? `; alerts: ${[...new Set(alerts)].slice(0, 5).join(' | ')}` : ''}`
  );
  if (failed) console.log('Re-run the same command to retry failed rows.');
}

void main();
