import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// A restricted department (migration 192) is kept out of the group screens
// by the layout and out of the data by these handlers, so each of them has
// to refuse it: RLS does not.

const FOLDER = join(process.cwd(), 'src/app/api/whatsapp/groups');

const routes = (readdirSync(FOLDER, { recursive: true }) as string[]).filter(
  (f) => f.endsWith('route.ts')
);

describe('every group handler refuses a restricted department', () => {
  it('finds the handlers', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(routes)('%s', (file) => {
    const source = readFileSync(join(FOLDER, file), 'utf8');
    const loads = source.match(
      /await (?:getCurrentAccount|requireRole)\(/g
    ) ?? [''];
    const guarded =
      source.match(
        /assertSalesAccess\(\s*await (?:getCurrentAccount|requireRole)\(/g
      ) ?? [];
    expect(guarded.length).toBe(loads.length);
  });
});
