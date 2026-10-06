import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      columns: ['phone', 'name', 'tags'],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
          values: { phone: '+15551234567', name: 'Alice', tags: 'VIP, Lead' },
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
          values: { phone: '+15559876543', name: 'Bob', tags: 'Customer' },
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      columns: ['phone', 'name'],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
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
