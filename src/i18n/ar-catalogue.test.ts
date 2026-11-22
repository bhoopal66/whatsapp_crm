import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { shapeMismatch } from './message-shape';

// messages/ar.json was machine-translated (docs/languages.md). Every
// string must keep its English source's ICU shape: the same argument
// names and types, select keys, rich-text tags and — for strings read
// with t.raw() — the same literal `{{1}}` tokens and HTML tags. Plurals
// may add Arabic categories but keep `other` and every exact `=N` case.
// A string that loses a placeholder renders without the value, and one
// that stops parsing renders as its own keypath (see icu-safety.test.ts).

type Tree = { [key: string]: Tree | string };

function leaves(
  node: Tree | string,
  path = '',
  out = new Map<string, unknown>()
) {
  if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node))
      leaves(v, path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, node);
  }
  return out;
}

const load = (locale: string) =>
  leaves(
    JSON.parse(
      readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8')
    )
  );

describe("ar.json keeps every string's placeholders, tags and ICU arguments", () => {
  const en = load('en');
  const ar = load('ar');

  it('every Arabic string is a non-empty string', () => {
    const bad = [...ar].filter(
      ([, v]) => typeof v !== 'string' || v.trim() === ''
    );
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("every Arabic string has its English source's shape", () => {
    const mismatches: string[] = [];
    for (const [key, source] of en) {
      const translated = ar.get(key);
      if (typeof source !== 'string' || typeof translated !== 'string')
        continue;
      const why = shapeMismatch(source, translated);
      if (why) mismatches.push(`${key}: ${why}`);
    }
    expect(mismatches).toEqual([]);
  });
});
