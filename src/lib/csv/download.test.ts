import { describe, expect, it } from 'vitest';

import { fileNameFromDisposition } from './download';

describe('fileNameFromDisposition', () => {
  it('reads the quoted file name', () => {
    expect(
      fileNameFromDisposition('attachment; filename="dashboard-2026-11-22.csv"')
    ).toBe('dashboard-2026-11-22.csv');
  });

  it('falls back on a missing or unsafe name', () => {
    expect(fileNameFromDisposition(null)).toBe('export.csv');
    expect(fileNameFromDisposition('attachment')).toBe('export.csv');
    expect(fileNameFromDisposition('attachment; filename="../x y.csv"')).toBe(
      'export.csv'
    );
  });
});
