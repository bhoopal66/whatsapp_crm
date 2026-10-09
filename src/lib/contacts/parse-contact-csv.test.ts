import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseContactTable } from './parse-contact-csv';

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

describe('parseContactTable', () => {
  // The header row of the declined/dropped cases export the broadcast
  // wizard was asked to take as it is.
  const HEADER = [
    'Customer Name',
    'Company Name',
    'Banks Submitted For',
    'Phone Number',
    'Outcome by Bank',
    'Cases',
  ];

  it('reads export headers through their aliases, keeping them as columns', () => {
    const result = parseContactTable([
      HEADER,
      [' Sir/Madam ', 'Acme LLC', 'ADCB', ' 0507481985 ', 'Declined', '2'],
    ]);
    expect(result.phoneColumn).toBe('phone number');
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.columns).toEqual([
      'customer name',
      'company name',
      'banks submitted for',
      'phone number',
      'outcome by bank',
      'cases',
    ]);
    expect(result.rows).toEqual([
      {
        phone: '0507481985',
        name: 'Sir/Madam',
        email: undefined,
        company: 'Acme LLC',
        values: {
          'customer name': 'Sir/Madam',
          'company name': 'Acme LLC',
          'banks submitted for': 'ADCB',
          'phone number': '0507481985',
          'outcome by bank': 'Declined',
          cases: '2',
        },
      },
    ]);
  });

  it('prefers the exact header over an alias', () => {
    const result = parseContactTable([
      ['Mobile', 'Phone', 'Full Name', 'Name', 'Email  Address'],
      ['111', '222', 'Alias', 'Exact', 'a@example.com'],
    ]);
    expect(result.phoneColumn).toBe('phone');
    expect(result.rows[0]).toMatchObject({
      phone: '222',
      name: 'Exact',
      email: 'a@example.com',
    });
  });

  it.each(['mobile', 'Mobile Number', 'WhatsApp', 'whatsapp number'])(
    'takes %s as the phone column',
    (header) => {
      const result = parseContactTable([[header], ['971501234567']]);
      expect(result.phoneColumn).toBe(header.toLowerCase());
      expect(result.rows.map((r) => r.phone)).toEqual(['971501234567']);
    }
  );

  it('reports no phone column when none fits', () => {
    expect(
      parseContactTable([
        ['Customer Name', 'Telephone'],
        ['A', '1'],
      ])
    ).toEqual({
      rows: [],
      hasCompanyColumn: false,
      columns: [],
      phoneColumn: null,
      skippedNoPhone: 0,
    });
  });

  it('counts rows without a phone, but not fully blank ones', () => {
    const result = parseContactTable([
      HEADER,
      ['Sir/Madam', 'A', 'ADCB', '', 'Declined', '1'],
      ['', '', '', '', '', ''],
      [],
      ['B', 'B LLC', 'FAB', '   ', 'Dropped', '1'],
      ['C', 'C LLC', 'FAB', '055 467 3234', 'Dropped', '3'],
    ]);
    expect(result.skippedNoPhone).toBe(2);
    expect(result.rows.map((r) => r.phone)).toEqual(['055 467 3234']);
  });

  it('keeps quotes, which only CSV reading strips', () => {
    const result = parseContactTable([
      ['name', 'phone'],
      ["O'Brien", '+971 50 123 4567'],
      ['"Al Noor" Trading', '971501234568'],
    ]);
    expect(result.rows.map((r) => r.name)).toEqual([
      "O'Brien",
      '"Al Noor" Trading',
    ]);
  });
});

describe('parseContactCsv header aliases', () => {
  it('accepts a Phone Number column in a CSV too', () => {
    const csv = `Customer Name,Phone Number
Alice,+15551234567`;
    expect(parseContactCsv(csv).rows).toEqual([
      {
        phone: '+15551234567',
        name: 'Alice',
        email: undefined,
        company: undefined,
        values: { 'customer name': 'Alice', 'phone number': '+15551234567' },
      },
    ]);
  });
});
