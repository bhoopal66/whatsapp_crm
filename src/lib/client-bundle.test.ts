import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Client code must never import next/server, directly or through a
 * module it imports: next/server pulls node:async_hooks into the browser
 * bundle and `next build` fails ("the chunking context does not support
 * external modules"). typecheck and the unit tests don't build, so it
 * surfaced only at deploy time — b664600 (the call layer), then again
 * when the phone-presence hook imported src/lib/pbx/calls.ts. This walks
 * the import graph from every 'use client' module. Type-only imports are
 * erased by the compiler, so they don't count.
 */
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
      ? [path]
      : [];
  });
}

const IMPORT =
  /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT = /(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]/g;

/** The value imports of a module: [specifier, ...]. */
function valueImports(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(IMPORT)) {
    const [, typeOnly, clause, spec] = m;
    if (typeOnly) continue;
    // `import { type A, type B } from …` is erased too.
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (
      named &&
      named[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.startsWith('type '))
    )
      continue;
    out.push(spec);
  }
  for (const m of code.matchAll(SIDE_EFFECT)) out.push(m[1]);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? join(SRC, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

describe('valueImports', () => {
  it('skips type-only imports and keeps value ones', () => {
    expect(
      valueImports(
        [
          "import type { NextRequest } from 'next/server';",
          "import { type A, type B } from './a';",
          "import { NextResponse } from 'next/server';",
          "export { x, type Y } from './b';",
          "import './c';",
        ].join('\n')
      )
    ).toEqual(['next/server', './b', './c']);
  });
});

describe('client modules', () => {
  it('never reach next/server', () => {
    const files = sourceFiles(SRC);
    const code = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
    const roots = files.filter((f) =>
      /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(
        code.get(f) ?? ''
      )
    );
    expect(roots.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const root of roots) {
      const seen = new Map<string, string | null>([[root, null]]);
      const queue = [root];
      while (queue.length) {
        const file = queue.shift()!;
        const specs = valueImports(code.get(file) ?? '');
        if (specs.includes('next/server')) {
          const chain: string[] = [];
          for (let f: string | null = file; f; f = seen.get(f) ?? null)
            chain.unshift(relative(SRC, f));
          offenders.push(chain.join(' → '));
          break;
        }
        for (const spec of specs) {
          const next = resolveLocal(file, spec);
          if (next && code.has(next) && !seen.has(next)) {
            seen.set(next, file);
            queue.push(next);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
