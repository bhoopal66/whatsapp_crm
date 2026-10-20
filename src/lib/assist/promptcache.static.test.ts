// Ported from wacrm module 019f (test/019f/static.test.ts). The reference's MANIFEST_019e hash check is not ported:
// the wacrm 019e files are a reformatted port, pinned by middleware.static.test.ts and their own tests instead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'promptcache.ts'),
  'utf8'
);

describe('019f static: promptcache.ts', () => {
  it('imports only allowlisted modules (no router / guard / handler / network)', () => {
    const ALLOWED = new Set([
      'node:async_hooks',
      './canonical',
      './middleware.builtin',
      './middleware',
      '@/lib/memory/redact',
      '@/lib/memory/render',
    ]);
    const imports = [
      ...SRC.matchAll(
        /^\s*import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm
      ),
    ].map((m) => m[2]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(ALLOWED.has(spec), spec).toBe(true);
    const code = SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const bad of [
      /\bimport\s*\(|\brequire\s*\(/,
      /\bfetch\s*\(/,
      /console\./,
      /ToolHandler|createModelToolRouter|ConfirmApi/,
    ])
      expect(code).not.toMatch(bad);
  });
  it('is ASCII only', () => {
    expect(SRC).not.toMatch(/[^\x00-\x7F]/);
  });
});
