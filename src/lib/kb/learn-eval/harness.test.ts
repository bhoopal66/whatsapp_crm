import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({}) }));

import { KB_LEARN_CORPUS, KB_LEARN_DISTILL_CORPUS } from './corpus';
import {
  casePassed,
  formatReport,
  runCase,
  runDistillCase,
  runEval,
  thresholdBreaches,
  type EvalCase,
} from './harness';

/**
 * The CI gate for "learn from team answers": the whole corpus runs
 * through the real pipeline with scripted models, and the build fails
 * if any secret leaks or any score drops below EVAL_THRESHOLDS.
 * KB_LEARN_EVAL_REPORT=<path> writes the Markdown report there.
 */
describe('learn-from-team-answers evaluation', () => {
  it('holds the bar over the whole corpus', async () => {
    const { summary, results } = await runEval(KB_LEARN_CORPUS);
    const report = process.env.KB_LEARN_EVAL_REPORT;
    if (report) writeFileSync(report, formatReport(summary, results));
    expect(summary.failures).toEqual([]);
    expect(thresholdBreaches(summary)).toEqual([]);
    expect(summary.leaks).toBe(0);
  });

  it('holds the bar over the skill-library cycle', async () => {
    const results = [];
    for (const c of KB_LEARN_DISTILL_CORPUS)
      results.push(await runDistillCase(c));
    expect(
      results
        .filter((r) => !r.ok)
        .map((r) => ({ id: r.id, problems: r.problems }))
    ).toEqual([]);
    expect(results.reduce((n, r) => n + r.leaks.length, 0)).toBe(0);
  });

  it('covers every behaviour it claims to', () => {
    const tags = new Set(KB_LEARN_CORPUS.flatMap((c) => c.tags));
    for (const t of [
      'happy',
      'ar',
      'holding',
      'bubbles',
      'senders',
      'window',
      'eligibility',
      'min-answers',
      'pii',
      'names',
      'echo',
      'leaky',
      'decline',
      'injection',
      'known-gap',
      'skills',
    ])
      expect(tags, t).toContain(t);
    const ids = KB_LEARN_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports the known gap instead of hiding it', async () => {
    const { summary } = await runEval(
      KB_LEARN_CORPUS.filter((c) => c.tags.includes('known-gap'))
    );
    // A stranger's name reaches the model: documented, reviewed by a person.
    expect(summary.knownGapLeaks).toBeGreaterThan(0);
  });

  it('catches a leak: the harness is not blind', async () => {
    // A case whose "secret" is ordinary answer text must be reported.
    const planted: EvalCase = {
      ...KB_LEARN_CORPUS.find((c) => c.id === 'happy-en')!,
      id: 'planted-leak',
      secrets: ['freelance permit'],
    };
    const r = await runCase(planted);
    expect(r.leaks).toEqual(['freelance permit']);
    expect(casePassed(r)).toBe(false);
  });

  it('stays out of the app: only its own files import it', () => {
    const src = join(process.cwd(), 'src');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' });
    const importers = files
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.includes(`${sep}learn-eval${sep}`))
      .filter((f) =>
        /['"`][^'"`\n]*learn-eval/.test(readFileSync(join(src, f), 'utf8'))
      );
    expect(files.length).toBeGreaterThan(500);
    expect(importers).toEqual([]);
  });

  it('catches a wrong outcome and a broken pick', async () => {
    const base = KB_LEARN_CORPUS.find((c) => c.id === 'holding-then-answer')!;
    const r = await runCase({
      ...base,
      id: 'planted-pick',
      expect: { outcome: 'covered', picked: ['not in any reply'] },
    });
    expect(r.outcomeOk).toBe(false);
    expect(r.pickingOk).toBe(false);
  });
});
