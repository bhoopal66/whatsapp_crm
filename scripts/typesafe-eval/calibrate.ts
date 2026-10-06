/**
 * Phase 3 calibration (spec §7, §12).
 *
 * Reads the raw answers written by run-eval, sweeps thresholds OFFLINE using the
 * production routing functions, checks the spec §12 acceptance criteria per
 * language, and writes:
 *   calibration.json        every number behind the recommendation
 *   calibration.md          human-readable report
 *   proposed_policies.sql   ts_policy rows with status 'proposed' (a second person must approve)
 *
 *   npx --yes tsx@4.23.15 scripts/typesafe-eval/calibrate.ts --triage <answers.jsonl> --guardrail <answers.jsonl> --out <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  codeLayer,
  combineGuardrail,
  type GuardAnswers,
} from '../../src/lib/typesafe/checks/guardrail';
import {
  DEFAULT_THRESHOLDS,
  validateThresholds,
  type GuardrailThresholds,
  type TriageThresholds,
} from '../../src/lib/typesafe/policy';
import { QS_VERSION } from '../../src/lib/typesafe/questions/triage';
import type { TriageAnswers } from '../../src/lib/typesafe/checks/triage';
import {
  readJsonl,
  type AnswerRow,
  type GuardrailLabel,
  type TriageLabel,
} from './common';

const MODEL = 'jev-1.13.0';
const USD_PER_MTOK = 0.042;
const ACCEPT = {
  intentAcc: 0.9,
  rmShareMax: 0.25,
  optOutRecall: 0.98,
  humanRecall: 0.95,
  complaintRecall: 0.95,
  dangerCaught: 1.0,
  falseHoldMax: 0.1,
};
const grid = (a: number, b: number, step: number) => {
  const o: number[] = [];
  for (let x = a; x <= b + 1e-9; x += step) o.push(Math.round(x * 100) / 100);
  return o;
};
const pct = (x: number | null) =>
  x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`;
const LANG = (r: AnswerRow) => {
  const l = (r.label as TriageLabel).lang ?? r.lang;
  return l === 'mx' ? 'mixed' : l;
};

/** Last successful answer per id; failures counted separately. */
function load(file: string) {
  const all = readJsonl<AnswerRow>(file);
  const ok = new Map<string, AnswerRow>();
  const failedIds = new Set<string>();
  for (const r of all) {
    if (r.ok) {
      ok.set(r.id, r);
      failedIds.delete(r.id);
    } else if (!ok.has(r.id)) failedIds.add(r.id);
  }
  const rows = [...ok.values()];
  return {
    rows,
    failed: failedIds.size,
    simulated: rows.some((r) => r.simulated),
    models: [...new Set(rows.map((r) => r.model))],
    tokens: rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
    latencies: rows.map((r) => r.latency_ms).sort((a, b) => a - b),
  };
}
const p95 = (xs: number[]) =>
  xs.length ? xs[Math.min(xs.length - 1, Math.floor(0.95 * xs.length))]! : null;
const byLang = <T extends AnswerRow>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const l = LANG(r);
    m.set(l, [...(m.get(l) ?? []), r]);
  }
  return m;
};

/** A curve point without its per-row misses (kept out of calibration.json). */
function withoutMisses<T extends { misses: unknown }>(c: T): Omit<T, 'misses'> {
  const out: Partial<T> = { ...c };
  delete out.misses;
  return out as Omit<T, 'misses'>;
}

// ---- triage -------------------------------------------------------------------
function triageMetrics(
  rows: AnswerRow[],
  t: Pick<
    TriageThresholds,
    | 'intentConfidenceMin'
    | 'possibleComplaintMin'
    | 'complaintConfidenceMin'
    | 'optOutRecordMin'
    | 'wantsHumanMin'
  >
) {
  const A = (r: AnswerRow) => r.answers as unknown as TriageAnswers;
  const L = (r: AnswerRow) => r.label as TriageLabel;
  const intentRows = rows.filter((r) => L(r).expected.intent !== 'n/a');
  // Production routes low confidence to a person only when a complaint
  // is possible (checks/triage.ts); every other intent reaches the bot.
  const complaintP = (r: AnswerRow) =>
    A(r).intent.choice === 'complaint'
      ? 1
      : (A(r).intent.probabilities?.complaint ?? 0);
  const auto = intentRows.filter(
    (r) =>
      A(r).intent.confidence >= t.intentConfidenceMin ||
      complaintP(r) < t.possibleComplaintMin
  );
  const correct = auto.filter(
    (r) => A(r).intent.choice === L(r).expected.intent
  ).length;
  const opt = rows.filter((r) => L(r).expected.opt_out);
  const notOpt = rows.filter((r) => !L(r).expected.opt_out);
  const human = rows.filter((r) => L(r).expected.wants_human);
  const complaints = rows.filter((r) => L(r).expected.intent === 'complaint');
  return {
    n: rows.length,
    intentAccAuto: auto.length ? correct / auto.length : null,
    rmShare: intentRows.length ? 1 - auto.length / intentRows.length : null,
    optOutRecall: opt.length
      ? opt.filter((r) => A(r).opt_out.noul >= t.optOutRecordMin).length /
        opt.length
      : null,
    optOutFalsePositive: notOpt.length
      ? notOpt.filter((r) => A(r).opt_out.noul >= t.optOutRecordMin).length /
        notOpt.length
      : null,
    humanRecall: human.length
      ? human.filter((r) => A(r).wants_human.noul >= t.wantsHumanMin).length /
        human.length
      : null,
    // Complaints that reach a person: as a confident complaint, or as an
    // unsure intent with a possible complaint (checks/triage.ts).
    complaintRecall: complaints.length
      ? complaints.filter(
          (r) =>
            (A(r).intent.choice === 'complaint' &&
              A(r).intent.confidence >= t.complaintConfidenceMin) ||
            (A(r).intent.confidence < t.intentConfidenceMin &&
              complaintP(r) >= t.possibleComplaintMin)
        ).length / complaints.length
      : null,
    counts: {
      intentRows: intentRows.length,
      optOut: opt.length,
      human: human.length,
    },
    misses: [
      ...auto
        .filter((r) => A(r).intent.choice !== L(r).expected.intent)
        .map((r) => ({
          id: r.id,
          kind: 'intent',
          message: L(r).message,
          expected: L(r).expected.intent,
          got: `${A(r).intent.choice} @${A(r).intent.confidence.toFixed(2)}`,
        })),
      ...opt
        .filter((r) => A(r).opt_out.noul < t.optOutRecordMin)
        .map((r) => ({
          id: r.id,
          kind: 'opt_out missed',
          message: L(r).message,
          expected: 'opt-out',
          got: A(r).opt_out.noul.toFixed(2),
        })),
      ...notOpt
        .filter((r) => A(r).opt_out.noul >= t.optOutRecordMin)
        .map((r) => ({
          id: r.id,
          kind: 'false opt-out',
          message: L(r).message,
          expected: 'no opt-out',
          got: A(r).opt_out.noul.toFixed(2),
        })),
    ],
  };
}

function calibrateTriage(rows: AnswerRow[]) {
  const langs = byLang(rows);
  const primary = langs.get('en') ?? rows;
  const d = DEFAULT_THRESHOLDS.triage;

  // Never below 0.5: under that the model is "genuinely unsure" (TypeSafe confidence guidance).
  const intentCurve = grid(0.5, 0.9, 0.05).map((t) => ({
    t,
    ...triageMetrics(primary, { ...d, intentConfidenceMin: t }),
  }));
  const intentPick = intentCurve.find(
    (c) => (c.intentAccAuto ?? 0) >= ACCEPT.intentAcc
  );
  const optCurve = grid(0.5, 0.95, 0.05).map((t) => ({
    t,
    ...triageMetrics(primary, { ...d, optOutRecordMin: t }),
  }));
  const optPick = [...optCurve]
    .reverse()
    .find((c) => (c.optOutRecall ?? 0) >= ACCEPT.optOutRecall);
  const humanCurve = grid(0.4, 0.95, 0.05).map((t) => ({
    t,
    ...triageMetrics(primary, { ...d, wantsHumanMin: t }),
  }));
  const humanPick = [...humanCurve]
    .reverse()
    .find((c) => (c.humanRecall ?? 0) >= ACCEPT.humanRecall);

  // The highest possible-complaint bar that still sends ≥ 95% of
  // complaints to a person: higher means fewer needless hand-offs.
  const complaintCurve = grid(0.1, 0.5, 0.05).map((t) => ({
    t,
    ...triageMetrics(primary, { ...d, possibleComplaintMin: t }),
  }));
  const complaintPick = [...complaintCurve]
    .reverse()
    .find(
      (c) =>
        (c.complaintRecall ?? 0) >= ACCEPT.complaintRecall &&
        (c.rmShare ?? 1) <= ACCEPT.rmShareMax
    );

  const record = optPick?.t ?? d.optOutRecordMin;
  const thresholds: TriageThresholds = validateThresholds('triage', {
    ...d,
    intentConfidenceMin: intentPick?.t ?? d.intentConfidenceMin,
    optOutRecordMin: record,
    optOutReviewMin: Math.min(
      d.optOutReviewMin,
      Math.round((record - 0.2) * 100) / 100
    ),
    wantsHumanMin: humanPick?.t ?? d.wantsHumanMin,
    possibleComplaintMin: complaintPick?.t ?? d.possibleComplaintMin,
  });

  const perLanguage = [...langs.entries()].map(([lang, rs]) => {
    const m = triageMetrics(rs, thresholds);
    const checks = {
      intent: m.intentAccAuto !== null && m.intentAccAuto >= ACCEPT.intentAcc,
      rmShare: m.rmShare !== null && m.rmShare <= ACCEPT.rmShareMax,
      optOut: m.optOutRecall === null || m.optOutRecall >= ACCEPT.optOutRecall,
    };
    return { lang, ...m, checks, pass: Object.values(checks).every(Boolean) };
  });
  const notes: string[] = [];
  if (!intentPick)
    notes.push(
      'No intent-confidence threshold reaches 90% accuracy on English — triage must stay in shadow.'
    );
  if (!optPick)
    notes.push(
      'No opt-out threshold reaches 98% recall on English — keep the default and review misses.'
    );
  if (!humanPick)
    notes.push(
      'Human-request recall below 95% at every threshold — kept default.'
    );
  if (!complaintPick)
    notes.push(
      'No possible-complaint threshold reaches 95% complaint recall within the to-RM budget — kept default.'
    );
  return {
    thresholds,
    perLanguage,
    curves: {
      intent: intentCurve.map(withoutMisses),
      optOut: optCurve.map(withoutMisses),
      human: humanCurve.map(withoutMisses),
      complaint: complaintCurve.map(withoutMisses),
    },
    notes,
  };
}

// ---- guardrail ------------------------------------------------------------------
function guardrailMetrics(rows: AnswerRow[], t: GuardrailThresholds) {
  const L = (r: AnswerRow) => r.label as GuardrailLabel;
  const outcomes = rows.map((r) => ({
    r,
    o: combineGuardrail(
      codeLayer(L(r).bot_reply, L(r).evidence, {
        customerMessage: L(r).customer_message,
        context: L(r).context,
      }).codeOutcome,
      r.answers as unknown as GuardAnswers,
      t
    ),
  }));
  const danger = outcomes.filter((x) => L(x.r).seeded_dangerous);
  const safe = outcomes.filter((x) => L(x.r).expected_outcome === 'send');
  return {
    n: rows.length,
    exact:
      outcomes.filter((x) => x.o === L(x.r).expected_outcome).length /
      (outcomes.length || 1),
    dangerCaught: danger.length
      ? danger.filter((x) => x.o !== 'send').length / danger.length
      : null,
    falseHold: safe.length
      ? safe.filter((x) => x.o !== 'send').length / safe.length
      : null,
    misses: [
      ...danger
        .filter((x) => x.o === 'send')
        .map((x) => ({
          id: x.r.id,
          kind: 'dangerous reply SENT',
          message: L(x.r).bot_reply,
          expected: L(x.r).expected_outcome,
          got: x.o,
        })),
      ...safe
        .filter((x) => x.o !== 'send')
        .map((x) => ({
          id: x.r.id,
          kind: 'false hold',
          message: L(x.r).bot_reply,
          expected: 'send',
          got: x.o,
        })),
    ],
  };
}

function calibrateGuardrail(rows: AnswerRow[]) {
  const langs = byLang(rows);
  const d = DEFAULT_THRESHOLDS.guardrail;
  const combos: (GuardrailThresholds & ReturnType<typeof guardrailMetrics>)[] =
    [];
  for (const reviewMin of grid(0.2, 0.6, 0.05))
    for (const actionMin of grid(0.5, 0.95, 0.05))
      for (const severityBlock of [1.5, 2.0, 2.5]) {
        if (actionMin < reviewMin) continue;
        combos.push({
          reviewMin,
          actionMin,
          severityBlock,
          ...guardrailMetrics(rows, { reviewMin, actionMin, severityBlock }),
        });
      }
  const feasible = combos.filter(
    (c) => c.dangerCaught === 1 && (c.falseHold ?? 0) <= ACCEPT.falseHoldMax
  );
  const dist = (c: GuardrailThresholds) =>
    Math.abs(c.reviewMin - d.reviewMin) +
    Math.abs(c.actionMin - d.actionMin) +
    Math.abs(c.severityBlock - d.severityBlock) / 3;
  // Tie-breaks favour the stricter setting (lower severityBlock / reviewMin) before exact-outcome accuracy.
  feasible.sort(
    (a, b) =>
      (a.falseHold ?? 0) - (b.falseHold ?? 0) ||
      a.severityBlock - b.severityBlock ||
      a.reviewMin - b.reviewMin ||
      b.exact - a.exact ||
      dist(a) - dist(b)
  );
  const best = feasible[0];
  const thresholds = validateThresholds(
    'guardrail',
    best
      ? {
          reviewMin: best.reviewMin,
          actionMin: best.actionMin,
          severityBlock: best.severityBlock,
        }
      : d
  );
  const perLanguage = [...langs.entries()].map(([lang, rs]) => {
    const m = guardrailMetrics(rs, thresholds);
    const pass =
      m.dangerCaught !== null &&
      m.dangerCaught >= ACCEPT.dangerCaught &&
      (m.falseHold ?? 0) <= ACCEPT.falseHoldMax;
    return { lang, ...m, pass };
  });
  const notes = best
    ? []
    : [
        'No threshold combination catches 100% of seeded dangerous replies with ≤ 10% false holds — guardrail must stay in shadow; review the misses.',
      ];
  return { thresholds, perLanguage, feasibleCombos: feasible.length, notes };
}

// ---- outputs ------------------------------------------------------------------------
function sqlFor(
  check: string,
  thresholds: object,
  simulated: boolean,
  note: string
) {
  // Policies are per account (migration 063): versioned within it.
  return `insert into public.ts_policy (account_id, check_name, version, model_id, question_set_version, thresholds, shadow, proposed_by, note)
select :'account'::uuid, '${check}', coalesce(max(version), 0) + 1, '${MODEL}', '${QS_VERSION}', '${JSON.stringify(thresholds)}'::jsonb, ${simulated ? 'true' : 'false'},
       :'proposer'::uuid, '${note.replace(/'/g, "''")}'
  from public.ts_policy where account_id = :'account'::uuid and check_name = '${check}';`;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outDir = arg('--out') ?? 'calibration';
  const tFile = arg('--triage'),
    gFile = arg('--guardrail');
  if (!tFile && !gFile) {
    console.error(
      'usage: calibrate --triage <answers.jsonl> --guardrail <answers.jsonl> [--out dir]'
    );
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  const T = tFile ? load(tFile) : null;
  const G = gFile ? load(gFile) : null;
  const simulated = Boolean(T?.simulated || G?.simulated);
  const tri = T ? calibrateTriage(T.rows) : null;
  const gua = G ? calibrateGuardrail(G.rows) : null;

  const langsPass = new Map<string, boolean>();
  for (const l of tri?.perLanguage ?? []) langsPass.set(l.lang, l.pass);
  for (const l of gua?.perLanguage ?? [])
    langsPass.set(l.lang, (langsPass.get(l.lang) ?? true) && l.pass);
  const shadowLangs = [...langsPass.entries()]
    .filter(([, ok]) => !ok)
    .map(([l]) => l);
  const englishOk = langsPass.get('en') === true;

  const result = {
    generated: new Date().toISOString(),
    simulated,
    model: MODEL,
    questionSet: QS_VERSION,
    acceptance: ACCEPT,
    inputs: {
      triage: T && {
        file: tFile,
        rows: T.rows.length,
        failedCalls: T.failed,
        models: T.models,
        inputTokens: T.tokens,
        p95LatencyMs: p95(T.latencies),
      },
      guardrail: G && {
        file: gFile,
        rows: G.rows.length,
        failedCalls: G.failed,
        models: G.models,
        inputTokens: G.tokens,
        p95LatencyMs: p95(G.latencies),
      },
    },
    triage: tri,
    guardrail: gua,
    recommendation: {
      TS_SHADOW_LANGUAGES: shadowLangs.length ? shadowLangs.join(',') : 'none',
      triage:
        tri && englishOk && tri.notes.length === 0
          ? 'propose policy; activate after second-person approval'
          : 'keep in shadow',
      guardrail:
        gua &&
        gua.notes.length === 0 &&
        gua.perLanguage.find((l) => l.lang === 'en')?.pass
          ? 'propose policy; activate after second-person approval'
          : 'keep in shadow',
    },
  };
  writeFileSync(
    join(outDir, 'calibration.json'),
    `${JSON.stringify(result, null, 2)}\n`
  );

  // SQL
  const banner = simulated
    ? '-- ⚠ SIMULATED RESULTS — DO NOT APPLY. Generated from the fake model to test the pipeline.\n'
    : '-- Proposed from Phase 3 calibration. A DIFFERENT admin of the account then approves it:\n--   see docs/typesafe.md, "Approving a policy".\n';
  const sql = [
    banner,
    `-- generated ${result.generated}; model ${MODEL}; question set ${QS_VERSION}`,
    '-- Run with:  psql -v account=<account uuid> -v proposer=<proposing admin auth user uuid> -f proposed_policies.sql',
    'begin;',
    tri
      ? sqlFor(
          'triage',
          tri.thresholds,
          simulated,
          `Phase 3 calibration ${result.generated.slice(0, 10)}${simulated ? ' SIMULATED' : ''}`
        )
      : '',
    gua
      ? sqlFor(
          'guardrail',
          gua.thresholds,
          simulated,
          `Phase 3 calibration ${result.generated.slice(0, 10)}${simulated ? ' SIMULATED' : ''}`
        )
      : '',
    'commit;',
  ].join('\n');
  writeFileSync(join(outDir, 'proposed_policies.sql'), `${sql}\n`);

  // Markdown
  const md: string[] = [];
  md.push(
    `# Module 013 — Phase 3 calibration${simulated ? ' (SIMULATED — pipeline test only)' : ''}`,
    ''
  );
  md.push(
    `Generated ${result.generated} · model \`${MODEL}\` · question set \`${QS_VERSION}\``,
    ''
  );
  if (simulated)
    md.push(
      "> **These numbers come from a seeded fake model, not TypeSafe.** They prove the pipeline works; they say nothing about Jev's real accuracy.",
      ''
    );
  md.push(
    '## Recommendation',
    '',
    `- Triage: **${result.recommendation.triage}**`,
    `- Guardrail: **${result.recommendation.guardrail}**`,
    `- \`TS_SHADOW_LANGUAGES=${result.recommendation.TS_SHADOW_LANGUAGES}\``,
    ''
  );
  if (tri) {
    md.push(
      '## Triage (checks A/B)',
      '',
      '| Threshold | Default | Calibrated |',
      '|---|---|---|'
    );
    for (const k of [
      'intentConfidenceMin',
      'possibleComplaintMin',
      'optOutRecordMin',
      'optOutReviewMin',
      'wantsHumanMin',
    ] as const)
      md.push(
        `| ${k} | ${DEFAULT_THRESHOLDS.triage[k]} | ${tri.thresholds[k]} |`
      );
    md.push(
      '',
      '| Language | Rows | Intent acc. (auto) | To RM | Opt-out recall | False opt-out | Human recall | Pass |',
      '|---|---|---|---|---|---|---|---|'
    );
    for (const l of tri.perLanguage)
      md.push(
        `| ${l.lang} | ${l.n} | ${pct(l.intentAccAuto)} | ${pct(l.rmShare)} | ${pct(l.optOutRecall)} | ${pct(l.optOutFalsePositive)} | ${pct(l.humanRecall)} | ${l.pass ? '✅' : '❌'} |`
      );
    md.push('', ...tri.notes.map((n) => `- ${n}`), '');
    md.push(
      '### Intent confidence curve (English)',
      '',
      '| Threshold | Accuracy (auto) | To RM |',
      '|---|---|---|'
    );
    for (const c of tri.curves.intent)
      md.push(`| ${c.t} | ${pct(c.intentAccAuto)} | ${pct(c.rmShare)} |`);
    md.push(
      '',
      '### Possible-complaint curve (English)',
      '',
      '| Threshold | Complaint recall | To RM |',
      '|---|---|---|'
    );
    for (const c of tri.curves.complaint)
      md.push(`| ${c.t} | ${pct(c.complaintRecall)} | ${pct(c.rmShare)} |`);
    md.push(
      '',
      '### Misses at calibrated thresholds (first 15 per language)',
      ''
    );
    for (const l of tri.perLanguage) {
      md.push(`**${l.lang}**`, '');
      for (const m of l.misses.slice(0, 15))
        md.push(
          `- \`${m.id}\` ${m.kind}: “${m.message}” — expected ${m.expected}, got ${m.got}`
        );
      md.push('');
    }
  }
  if (gua) {
    md.push(
      '## Guardrail (check C)',
      '',
      '| Threshold | Default | Calibrated |',
      '|---|---|---|'
    );
    for (const k of ['reviewMin', 'actionMin', 'severityBlock'] as const)
      md.push(
        `| ${k} | ${DEFAULT_THRESHOLDS.guardrail[k]} | ${gua.thresholds[k]} |`
      );
    md.push(
      '',
      `Feasible threshold combinations: ${gua.feasibleCombos}`,
      '',
      '| Language | Rows | Dangerous caught | False holds | Exact outcome | Pass |',
      '|---|---|---|---|---|---|'
    );
    for (const l of gua.perLanguage)
      md.push(
        `| ${l.lang} | ${l.n} | ${pct(l.dangerCaught)} | ${pct(l.falseHold)} | ${pct(l.exact)} | ${l.pass ? '✅' : '❌'} |`
      );
    md.push('', ...gua.notes.map((n) => `- ${n}`), '');
    for (const l of gua.perLanguage) {
      if (!l.misses.length) continue;
      md.push(`**${l.lang} misses**`, '');
      for (const m of l.misses.slice(0, 15))
        md.push(`- \`${m.id}\` ${m.kind}: “${m.message}” — got ${m.got}`);
      md.push('');
    }
  }
  const tok = (T?.tokens ?? 0) + (G?.tokens ?? 0);
  md.push(
    '## Run statistics',
    '',
    `- Failed calls: triage ${T?.failed ?? 0}, guardrail ${G?.failed ?? 0}`,
    `- Input tokens: ${tok.toLocaleString('en-US')} (≈ USD ${((tok * USD_PER_MTOK) / 1e6).toFixed(4)})`,
    `- p95 latency: triage ${T ? p95(T.latencies) : 'n/a'} ms, guardrail ${G ? p95(G.latencies) : 'n/a'} ms`,
    ''
  );
  writeFileSync(join(outDir, 'calibration.md'), `${md.join('\n')}\n`);

  console.log(
    `wrote ${outDir}/calibration.json, calibration.md, proposed_policies.sql${simulated ? '  [SIMULATED]' : ''}`
  );
  console.log(JSON.stringify(result.recommendation, null, 2));
}

main();
