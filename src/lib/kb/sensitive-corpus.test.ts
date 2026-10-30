import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as sensitive from './sensitive';

// Team chat's sensitive-data guard (migration 158) detects in SQL what
// containsSensitiveData detects here. Both are held to one corpus, kept
// in the verify file between `-- corpus:begin` and `-- corpus:end`, one
// `($c$<text>$c$, '{<kinds>}'),` per entry: a case added there is
// checked on both sides.

const VERIFY = readFileSync(
  join(process.cwd(), 'supabase/ci/verify-chat-sensitive-guard.sql'),
  'utf8'
);

function parseCorpus(sql: string): Array<{ text: string; kinds: string[] }> {
  const begin = sql.indexOf('-- corpus:begin');
  const end = sql.indexOf('-- corpus:end');
  if (begin < 0 || end < begin) {
    throw new Error('verify-chat-sensitive-guard.sql: corpus markers missing');
  }
  const block = sql.slice(begin, end);
  // An entry's text may span lines (whitespace cases), so match the
  // whole block rather than line by line.
  const entries = [
    ...block.matchAll(/\(\$c\$([\s\S]*?)\$c\$, '\{([^}]*)\}'\)/g),
  ].map((m) => ({
    text: m[1],
    kinds: m[2] === '' ? [] : m[2].split(','),
  }));
  const opened = block.split('($c$').length - 1;
  if (entries.length !== opened) {
    throw new Error(
      `corpus: ${opened} entries opened but ${entries.length} parsed`
    );
  }
  if (entries.length < 40) {
    throw new Error(`corpus: only ${entries.length} entries found`);
  }
  return entries;
}

const CORPUS = parseCorpus(VERIFY);

// A parallel change adds sensitiveKinds; until then only the boolean is
// pinned (the skipped case below says which ran).
const sensitiveKinds = (sensitive as Record<string, unknown>).sensitiveKinds as
  ((text: string) => string[]) | undefined;

describe(`sensitive-data corpus shared with migration 158 (${CORPUS.length} entries)`, () => {
  it('parses at least 40 entries', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CORPUS.map((c) => [JSON.stringify(c.text), c] as const))(
    'containsSensitiveData(%s) matches the SQL kinds',
    (_label, { text, kinds }) => {
      expect(sensitive.containsSensitiveData(text)).toBe(kinds.length > 0);
    }
  );

  it.skipIf(typeof sensitiveKinds !== 'function')(
    'sensitiveKinds returns exactly the SQL kinds',
    () => {
      for (const { text, kinds } of CORPUS) {
        expect([text, sensitiveKinds!(text)]).toEqual([text, kinds]);
      }
    }
  );
});
