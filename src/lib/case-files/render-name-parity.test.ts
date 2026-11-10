// The SQL case_file_render_name (migration 181) and the TS renameFor
// share render-name.vectors.json: supabase/ci/verify-case-files.sql must
// assert every vector, input and expected output, as a VALUES row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import vectorFile from './render-name.vectors.json';

const verify = readFileSync(
  join(process.cwd(), 'supabase/ci/verify-case-files.sql'),
  'utf8'
);

// The SQL literal the verify file uses for a value: E'' when it holds a
// backslash, tab or newline, else a plain quoted string.
function sqlLiteral(v: string | null): string {
  if (v === null) return 'NULL';
  if (/[\\\t\n]/.test(v)) {
    return `E'${v
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/\n/g, '\\n')
      .replace(/'/g, "''")}'`;
  }
  return `'${v.replace(/'/g, "''")}'`;
}

describe('render-name vectors in verify-case-files.sql', () => {
  it('has 20 vectors', () => {
    expect(vectorFile.vectors).toHaveLength(20);
  });

  it.each(vectorFile.vectors.map((v) => [v.id, v] as const))(
    '%s appears with its input and expected output',
    (_id, v) => {
      const row = `(${[
        v.id,
        v.pattern,
        v.case,
        v.company,
        v.doc,
        v.date,
        v.mime,
        v.expected,
      ]
        .map(sqlLiteral)
        .join(', ')})`;
      expect(verify).toContain(row);
    }
  );
});
