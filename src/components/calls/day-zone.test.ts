import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// These screens cut calls into days (the reports' periods).
// They need a DOM to mount, so the source is what can be checked: the
// browser's own zone must not decide where a day starts.
describe('the call reports count days in the workspace zone', () => {
  it.each(['call-report', 'call-stats-report'])('%s', (name) => {
    const src = readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8');
    expect(src).not.toContain('resolvedOptions');
    expect(src).toContain('DEFAULT_TIME_ZONE');
  });
});
