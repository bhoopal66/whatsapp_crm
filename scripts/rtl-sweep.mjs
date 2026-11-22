#!/usr/bin/env node
// Rewrites physical Tailwind direction classes to logical ones across
// src/, so the layout mirrors from <html dir="rtl"> (Arabic). Re-runnable:
// a second run finds nothing, and running it after a merge converts only
// what the merge brought in. docs/languages.md describes the rules.
//
//   node scripts/rtl-sweep.mjs           rewrite in place
//   node scripts/rtl-sweep.mjs --check   list what would change; exit 1 if any
//
// What it rewrites (any variant chain, `!` and negative values kept):
//   ml-/mr-, pl-/pr-, scroll-ml/mr/pl/pr-  → ms-/me-, ps-/pe-, …
//   left-/right- (positioning)             → start-/end-
//   text-left/right, float-, clear-        → text-start/end, …
//   rounded-l/r, rounded-tl/tr/bl/br       → rounded-s/e, rounded-ss/se/es/ee
//   border-l/r (width or colour)           → border-s/e
//
// What it leaves alone, on purpose:
//   - space-x / divide-x: Tailwind 4 already lays them out with
//     margin-inline / border-inline, so they mirror by themselves, and an
//     `rtl:space-x-reverse` would put the gap on the wrong side.
//   - left-1/2 / right-1/2: the centring idiom with -translate-x-1/2,
//     which a mirror would push off-centre.
//   - tokens under an `rtl:` or `ltr:` variant (already direction-aware),
//     or under `data-[side=left|right]:` (a popup's physical side; the
//     logical `inline-start|end` sides are rewritten).
//   - tests (*.test.*): they assert what the code renders and hold data
//     that only looks like a class; fix one by hand if it fails.
//   - charts: src/components/tremor/ and any file importing recharts
//     (time runs left to right in every language).
//   - a line after a `rtl-sweep-ignore-next-line` comment, and a file
//     containing `rtl-sweep-ignore-file`.
//   - class names built at runtime (`ml-${n}`): not recognisable here.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const CHECK = process.argv.includes('--check');

const IGNORED_DIRS = [join('src', 'components', 'tremor')];

const VALUE = String.raw`(?:\d+(?:\.\d+)?|px|auto|full|\d+\/\d+|\[[^\]\s"'\x60]+\]|\([^)\s"'\x60]+\))`;
const SIZE = String.raw`(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl|full|\[[^\]\s"'\x60]+\]|\([^)\s"'\x60]+\))`;
const BORDER = String.raw`[a-z0-9\-\/\[\]#.%()_]+`;

const SIDE = { l: 's', r: 'e' };
const CORNER = { tl: 'ss', tr: 'se', bl: 'es', br: 'ee' };
const WORD = { left: 'start', right: 'end' };

/** [pattern for the utility (no variants), rewrite] */
const RULES = [
  [new RegExp(String.raw`^(scroll-)?([mp])([lr])-(${VALUE})$`), (m) =>
    `${m[1] ?? ''}${m[2]}${SIDE[m[3]]}-${m[4]}`],
  [new RegExp(String.raw`^(left|right)-(${VALUE})$`), (m) =>
    m[2] === '1/2' ? null : `${WORD[m[1]]}-${m[2]}`],
  [/^(text|float|clear)-(left|right)$/, (m) => `${m[1]}-${WORD[m[2]]}`],
  [new RegExp(String.raw`^rounded-(tl|tr|bl|br)(-${SIZE})?$`), (m) =>
    `rounded-${CORNER[m[1]]}${m[2] ?? ''}`],
  [new RegExp(String.raw`^rounded-([lr])(-${SIZE})?$`), (m) =>
    `rounded-${SIDE[m[1]]}${m[2] ?? ''}`],
  [new RegExp(String.raw`^border-([lr])(-${BORDER})?$`), (m) =>
    `border-${SIDE[m[1]]}${m[2] ?? ''}`],
];

// A class token: anything between whitespace / quotes / backticks.
const TOKEN = /(?<=^|[\s"'`])([^\s"'`]+)(?=$|[\s"'`])/g;

function rewriteToken(token) {
  // Split the variant chain off (`md:hover:` …), respecting brackets so
  // `data-[side=left]:` or `[&>svg]:` stay one variant.
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) cut = i;
  }
  const variants = token.slice(0, cut + 1);
  if (/(^|:)(rtl|ltr):/.test(variants)) return null;
  // A popup's resolved physical side (Base UI's data-side=left|right):
  // an arrow or a sheet edge there is physical by definition.
  if (/\[side=(left|right|top|bottom)\]/.test(variants)) return null;
  let core = token.slice(cut + 1);
  const important = core.startsWith('!') ? '!' : '';
  if (important) core = core.slice(1);
  const trailing = core.endsWith('!') ? '!' : '';
  if (trailing) core = core.slice(0, -1);
  const negative = core.startsWith('-') ? '-' : '';
  if (negative) core = core.slice(1);
  for (const [re, fn] of RULES) {
    const m = core.match(re);
    if (!m) continue;
    const out = fn(m);
    return out ? `${variants}${important}${negative}${out}${trailing}` : null;
  }
  return null;
}

export function sweepText(text) {
  if (text.includes('rtl-sweep-ignore-file')) return { text, changes: [] };
  const lines = text.split('\n');
  const changes = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i - 1].includes('rtl-sweep-ignore-next-line')) continue;
    lines[i] = lines[i].replace(TOKEN, (token) => {
      const out = rewriteToken(token);
      if (out === null || out === token) return token;
      changes.push({ line: i + 1, from: token, to: out });
      return out;
    });
  }
  return { text: lines.join('\n'), changes };
}

function files(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (IGNORED_DIRS.some((d) => rel === d || rel.startsWith(d + sep))) return [];
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx?|jsx?|mjs)$/.test(entry) && !/\.test\.[jt]sx?$/.test(entry)
      ? [full]
      : [];
  });
}

function main() {
  let total = 0;
  let touched = 0;
  for (const file of files(SRC)) {
    const before = readFileSync(file, 'utf8');
    if (/from ['"]recharts['"]/.test(before)) continue;
    const { text, changes } = sweepText(before);
    if (!changes.length) continue;
    total += changes.length;
    touched++;
    const rel = relative(ROOT, file);
    if (CHECK) {
      for (const c of changes) console.log(`${rel}:${c.line}: ${c.from} → ${c.to}`);
    } else {
      writeFileSync(file, text);
    }
  }
  console.log(
    `${CHECK ? 'would rewrite' : 'rewrote'} ${total} class(es) in ${touched} file(s)`
  );
  if (CHECK && total) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
