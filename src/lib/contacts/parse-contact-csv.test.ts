import { describe, expect, it } from 'vitest';
import { parseContactCsv } from './parse-contact-csv';

describe('parseContactCsv', () => {
  it('ignores a tags column apart from carrying its cells in values', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasCompanyColumn: false,
      columns: ['phone', 'name', 'tags'],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          values: { phone: '+15551234567', name: 'Alice', tags: 'VIP, Lead' },
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          values: { phone: '+15559876543', name: 'Bob', tags: 'Customer' },
        },
      ],
    });
  });

  it('parses phone and name without optional columns', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasCompanyColumn: false,
      columns: ['phone', 'name'],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          values: { phone: '+15551234567', name: 'Alice' },
        },
      ],
    });
  });

  it('keeps every column so broadcasts can personalize on any of them', () => {
    const csv = `Phone,Name,Order ID,due_date
+15551234567,Alice,A-1001,2026-10-01
+15559876543,Bob,,2026-10-02`;

    const result = parseContactCsv(csv);
    expect(result.columns).toEqual(['phone', 'name', 'order id', 'due_date']);
    expect(result.rows[0].values).toEqual({
      phone: '+15551234567',
      name: 'Alice',
      'order id': 'A-1001',
      due_date: '2026-10-01',
    });
    // A blank cell is an empty string, not a missing key, so a mapped
    // column always resolves to *something* for every recipient.
    expect(result.rows[1].values['order id']).toBe('');
  });
});
