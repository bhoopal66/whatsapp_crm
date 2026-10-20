// Ported from wacrm module 019e (test/019e/static.test.ts). The reference's MANIFEST_019a hash check is not ported:
// the wacrm 019a files are a reformatted port, pinned by their own tests in this directory instead.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const MW_FILES = readdirSync(DIR).filter(
  (f) => /^middleware[^/]*\.ts$/.test(f) && !f.endsWith('.test.ts')
);
const src = (f: string) => readFileSync(join(DIR, f), 'utf8');
const IMPORT = /^\s*import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm;

describe('019e static: middleware cannot reach a tool handler or the human confirmation API', () => {
  it('finds both middleware files', () => {
    expect(MW_FILES.sort()).toEqual(['middleware.builtin.ts', 'middleware.ts']);
  });
  // Value imports allowed; router / guard / registry only as `import type`.
  // './canonical' (pure canonical JSON + sha256): the 019f terminal cache-tier registry hashes what it keeps.
  const ALLOWED = new Set([
    './loop',
    './middleware',
    './canonical',
    '@/lib/memory/redact',
  ]);
  const TYPE_ONLY = new Set([
    './guard',
    './registry',
    './router',
    './middleware',
    '@supabase/supabase-js',
  ]);
  for (const f of ['middleware.ts', 'middleware.builtin.ts']) {
    it(`${f} imports only allowlisted modules`, () => {
      const imports = [...src(f).matchAll(IMPORT)];
      expect(imports.length).toBeGreaterThan(0);
      for (const m of imports) {
        const spec = m[2]!;
        if (m[1])
          expect(
            TYPE_ONLY.has(spec) || ALLOWED.has(spec),
            `${f}: import type ${spec}`
          ).toBe(true);
        else expect(ALLOWED.has(spec), `${f}: import ${spec}`).toBe(true);
      }
      expect(src(f)).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    });
    it(`${f} names no handler, router factory, confirmation API or network API`, () => {
      const code = src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const bad of [
        /ToolHandler/,
        /createModelToolRouter/,
        /\bhandlers?\b/,
        /ConfirmationGate|ConfirmApi|['"]\.\/confirm['"]/,
        /\bconsume\s*\(/,
        /\bfetch\s*\(/,
        /node:(http|https|net|dgram|tls)/,
        /\.rpc\s*\(/,
      ]) {
        expect(code, `${f} ${bad}`).not.toMatch(bad);
      }
    });
    it(`${f} is ASCII only`, () => {
      expect(src(f)).not.toMatch(/[^\x00-\x7F]/);
    });
  }
});

describe('019e/019f: no npm dependency added', () => {
  const FILES = ['middleware.ts', 'middleware.builtin.ts', 'promptcache.ts'];
  it('the new modules import only node: built-ins, wacrm modules and supabase-js (type only)', () => {
    for (const f of FILES) {
      for (const m of src(f).matchAll(IMPORT)) {
        const spec = m[2]!;
        const local =
          spec.startsWith('./') ||
          spec.startsWith('@/') ||
          spec.startsWith('node:');
        const typeOnlySupabase = !!m[1] && spec === '@supabase/supabase-js';
        expect(local || typeOnlySupabase, `${f}: ${spec}`).toBe(true);
      }
    }
  });
  it('package.json names no agent framework', () => {
    const pkg = JSON.parse(
      readFileSync(join(DIR, '../../../package.json'), 'utf8')
    ) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.length).toBeGreaterThan(0);
    for (const n of names)
      expect(n).not.toMatch(/langchain|langgraph|deepagents/i);
  });
});
