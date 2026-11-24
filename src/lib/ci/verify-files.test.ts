import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `supabase db query --file` sends a file as one prepared statement and
// refuses several, so a verify file with its own BEGIN / ROLLBACK passes
// locally (psql) and fails on GitHub. Run such a file through psql there.

const workflow = readFileSync('.github/workflows/migrations.yml', 'utf8');
const files = readdirSync('supabase/ci').filter((f) =>
  /^verify-.*\.sql$/.test(f)
);
const body = (f: string) => readFileSync(`supabase/ci/${f}`, 'utf8');

/** Statements outside dollar quotes, strings and comments. */
function statements(sql: string): number {
  return sql
    .replace(/(\$\w*\$)[\s\S]*?\1/g, '')
    .replace(/--.*$/gm, '')
    .replace(/'(?:[^']|'')*'/g, '')
    .split(';')
    .filter((s) => s.trim() !== '').length;
}

describe('the verify files in migrations.yml', () => {
  it('are all run', () => {
    expect(files.filter((f) => !workflow.includes(`supabase/ci/${f}`))).toEqual(
      []
    );
  });

  it('hold one statement when `supabase db query` runs them', () => {
    const several = files
      .filter((f) => workflow.includes(`--file supabase/ci/${f}`))
      .filter((f) => statements(body(f)) > 1);
    expect(several).toEqual([]);
  });
});
