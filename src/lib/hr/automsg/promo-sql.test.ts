import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROMO_PHRASES_AR, PROMO_PHRASES_EN } from './templates';

// 337's hr_automsg_promo_phrase mirrors both lists: the save refuses what
// the editor refuses. A phrase added, dropped or reworded on one side only
// fails here.
const dir = join(process.cwd(), 'supabase', 'migrations');
const file = readdirSync(dir).find((f) => /^337_.*\.sql$/.test(f));
const sql = file ? readFileSync(join(dir, file), 'utf8') : '';

type Row = { n: number; lang: string; phrase: string; pattern: string };
const rows: Row[] = [
  ...sql.matchAll(/^\s*\((\d+), '(en|ar)', '([^']*)', '([^']*)'\),?\s*$/gm),
].map((m) => ({ n: Number(m[1]), lang: m[2], phrase: m[3], pattern: m[4] }));

/** A JS regex source as Postgres ARE: \b is \y there, and / needs no escape. */
const toAre = (source: string) =>
  source.replaceAll('\\b', '\\y').replaceAll('\\/', '/');

describe('337 promotional phrases mirror templates.ts', () => {
  it('the migration exists and the save calls the check', () => {
    expect(file).toBeDefined();
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.hr_automsg_promo_phrase(p_body text)'
    );
    expect(sql).toMatch(
      /v_phrase := hr_automsg_promo_phrase\(p_body\);\s+IF v_phrase IS NOT NULL THEN\s+PERFORM hr_refuse\('TEMPLATE_PROMOTIONAL'/
    );
  });

  it('rows are numbered in order, English first', () => {
    expect(rows.map((r) => r.n)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.map((r) => r.lang)).toEqual([
      ...PROMO_PHRASES_EN.map(() => 'en'),
      ...PROMO_PHRASES_AR.map(() => 'ar'),
    ]);
  });

  it('English: same phrases, same patterns, case-insensitive', () => {
    const en = rows.filter((r) => r.lang === 'en');
    expect(en).toHaveLength(PROMO_PHRASES_EN.length);
    expect(en.map((r) => [r.phrase, r.pattern])).toEqual(
      PROMO_PHRASES_EN.map((p) => [p.phrase, toAre(p.re.source)])
    );
    // The SQL matches with ~*, so the TS side may carry no other flag.
    for (const p of PROMO_PHRASES_EN) expect(p.re.flags).toBe('i');
    expect(sql).toContain("WHEN 'en' THEN p_body ~* x.pattern");
  });

  it('Arabic: same phrases, same substrings', () => {
    const ar = rows.filter((r) => r.lang === 'ar');
    expect(ar).toHaveLength(PROMO_PHRASES_AR.length);
    expect(ar.map((r) => [r.phrase, r.pattern])).toEqual(
      PROMO_PHRASES_AR.map((p) => [p.phrase, p.text])
    );
    expect(sql).toContain('ELSE strpos(p_body, x.pattern) > 0 END');
  });
});
