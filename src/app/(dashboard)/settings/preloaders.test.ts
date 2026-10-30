import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SETTINGS_SECTIONS } from '@/components/settings/settings-sections';

// page.tsx cannot export the map (a Next page may export only its
// route fields), so read it as text.
const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8');

function block(start: string, end: string): string {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe('settings panel preloaders', () => {
  const map = block('const PRELOADERS', 'function preloadSection');

  it('has an entry for every section but the eager Overview', () => {
    for (const s of SETTINGS_SECTIONS) {
      if (s === 'overview') continue;
      const key = /^[a-z]+$/.test(s) ? s : `'${s}'`;
      expect(map, s).toContain(`  ${key}: [`);
    }
  });

  it('preloads exactly the paths the dynamic panels import', () => {
    const dynamicPaths = new Set(
      [...src.matchAll(/dynamic\(\s*\(\) =>\s*import\('([^']+)'\)/g)].map(
        (m) => m[1]
      )
    );
    const preloadPaths = new Set(
      [...map.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1])
    );
    expect(dynamicPaths.size).toBeGreaterThan(20);
    expect(preloadPaths).toEqual(dynamicPaths);
  });
});
