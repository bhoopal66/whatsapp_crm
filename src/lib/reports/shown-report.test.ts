import { describe, expect, it } from 'vitest';
import { shownReport } from './shown-report';

describe('shownReport', () => {
  const loaded = { key: 'range=7d&agent=a', report: 1 };

  it('shows figures fetched for the current filter', () => {
    expect(shownReport(loaded, 'range=7d&agent=a')).toBe(loaded);
  });

  it('hides figures fetched for another filter (a failed change)', () => {
    expect(shownReport(loaded, 'range=7d&agent=b')).toBeNull();
  });

  it('shows nothing before the first load', () => {
    expect(shownReport(null, 'x')).toBeNull();
  });
});
