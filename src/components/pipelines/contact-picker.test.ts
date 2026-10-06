import { describe, expect, it } from 'vitest';
import { sanitizeContactSearch } from './contact-picker';

describe('sanitizeContactSearch', () => {
  it('strips PostgREST or-filter syntax characters', () => {
    expect(sanitizeContactSearch(' Acme, Inc (UK) ')).toBe('Acme  Inc  UK');
    expect(sanitizeContactSearch('say "hi"\\')).toBe('say  hi');
  });

  it('leaves ordinary names and phones alone', () => {
    expect(sanitizeContactSearch('+971 50 123')).toBe('+971 50 123');
  });
});
