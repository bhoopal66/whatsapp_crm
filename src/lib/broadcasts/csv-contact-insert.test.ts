import { describe, expect, it } from 'vitest';

import { buildCsvContactInsert } from './csv-contact-insert';

describe('buildCsvContactInsert', () => {
  it('marks a new CSV contact as a broadcast lead', () => {
    expect(
      buildCsvContactInsert('u1', 'a1', {
        phone: '+971501234567',
        name: 'Jane',
        company: undefined,
      })
    ).toEqual({
      user_id: 'u1',
      account_id: 'a1',
      phone: '+971501234567',
      name: 'Jane',
      company: null,
      lead_source: 'broadcast',
    });
  });
});
