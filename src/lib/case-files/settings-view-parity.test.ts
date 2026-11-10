import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_NAME_PATTERN, NAME_PLACEHOLDERS } from './settings-view';

// settings-view.ts is imported by the browser, so it cannot import
// http.ts (which pulls in next/server). It restates the route's file-name
// rules instead; this keeps the two copies from drifting.
const http = readFileSync(join(__dirname, 'http.ts'), 'utf8');

describe('settings-view mirrors the file-spec route', () => {
  it('uses the same default file name pattern', () => {
    expect(http).toContain(
      `export const DEFAULT_NAME_PATTERN = '${DEFAULT_NAME_PATTERN}';`
    );
  });

  it('allows exactly the placeholders the route allows', () => {
    // The route's rule is the regex alternation in isNamePattern:
    // \{\{(case|company|doc|yyyymmdd)\}\}
    const m = http.match(/\\\{\\\{\(([a-z|]+)\)\\\}\\\}/);
    expect(m).not.toBeNull();
    const inRoute = m![1].split('|').map((n) => `{{${n}}}`);
    expect(inRoute.sort()).toEqual([...NAME_PLACEHOLDERS].sort());
  });
});
