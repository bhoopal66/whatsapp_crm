import { describe, expect, it } from 'vitest';

import { metadata } from './layout';

describe('/f layout', () => {
  it('keeps the token from other sites without nulling its own Origin', () => {
    // no-referrer made Chrome send `Origin: null` with the form's POST,
    // which decideOrigin refuses: every browser submit failed with 403.
    expect(metadata.referrer).toBe('same-origin');
  });
});
