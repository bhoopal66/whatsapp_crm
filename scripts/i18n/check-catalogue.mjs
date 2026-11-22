#!/usr/bin/env node
// Compares a translated catalogue (or a fragment of one) with its English
// source: same keys, every string a non-empty string, and every string the
// same ICU shape (scripts/i18n/message-shape.mjs). Exits 1 on any problem.
//
//   node scripts/i18n/check-catalogue.mjs                       # messages/ar.json
// Korean is not checked: it has no plural, so its catalogue rightly drops
// plural arguments.
//   node scripts/i18n/check-catalogue.mjs <source.json> <translated.json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shapeMismatch } from './message-shape.mjs';

/** Locales whose catalogue must keep every ICU shape, plurals included. */
const STRICT_LOCALES = ['ar'];

function leaves(node, path = '', out = new Map()) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node))
      leaves(v, path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, node);
  }
  return out;
}

function compare(sourceFile, translatedFile) {
  const src = leaves(JSON.parse(readFileSync(sourceFile, 'utf8')));
  const tr = leaves(JSON.parse(readFileSync(translatedFile, 'utf8')));
  const problems = [];
  for (const [key, value] of src) {
    if (!tr.has(key)) {
      problems.push(`${key}: missing`);
      continue;
    }
    const t = tr.get(key);
    if (typeof t !== 'string' || (t.trim() === '' && value.trim() !== '')) {
      problems.push(`${key}: not a non-empty string`);
      continue;
    }
    const why = shapeMismatch(value, t);
    if (why) problems.push(`${key}: ${why}`);
  }
  for (const key of tr.keys())
    if (!src.has(key)) problems.push(`${key}: not in the source`);
  return problems;
}

const [a, b] = process.argv.slice(2);
const pairs =
  a && b
    ? [[a, b]]
    : STRICT_LOCALES.map((l) => [
        join('messages', 'en.json'),
        join('messages', `${l}.json`),
      ]);
let bad = 0;
for (const [s, t] of pairs) {
  const problems = compare(s, t);
  bad += problems.length;
  console.log(
    `${t}: ${problems.length ? `${problems.length} problem(s)` : 'ok'}`
  );
  for (const p of problems.slice(0, 200)) console.log(`  ${p}`);
}
process.exit(bad ? 1 : 0);
