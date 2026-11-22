#!/usr/bin/env node
// Checks that splitting CLAUDE.md into docs/agents/*.md lost nothing:
// every non-blank line of the old CLAUDE.md must appear verbatim in the
// new CLAUDE.md or in some docs/agents/*.md.
//
//   node scripts/check-claude-md-split.mjs [git-ref]
//
// git-ref names the commit holding the pre-split CLAUDE.md (default HEAD).
// Exit code 1 lists the missing lines.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ref = process.argv[2] ?? 'HEAD';
const old = execFileSync('git', ['show', `${ref}:CLAUDE.md`], {
  encoding: 'utf8',
});

const have = new Set();
const add = (text) => {
  for (const line of text.split('\n')) have.add(line);
};
add(fs.readFileSync('CLAUDE.md', 'utf8'));
const dir = path.join('docs', 'agents');
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
  add(fs.readFileSync(path.join(dir, f), 'utf8'));
}

const lines = old.split('\n').filter((l) => l.trim() !== '');
const missing = lines.filter((l) => !have.has(l));
const pct = (((lines.length - missing.length) / lines.length) * 100).toFixed(2);
console.log(
  `${lines.length - missing.length}/${lines.length} non-blank lines kept verbatim (${pct}%)`
);
for (const l of missing) console.log(`MISSING: ${l}`);
process.exit(missing.length ? 1 : 0);
