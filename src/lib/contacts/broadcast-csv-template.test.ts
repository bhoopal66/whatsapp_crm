import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseContactCsv } from './parse-contact-csv';

// The template linked from the broadcast audience step
// (`/templates/broadcast-contacts.csv`) must round-trip through the same
// parser the step uses, or the file we hand people fails on upload.
const TEMPLATE = readFileSync(
  join(process.cwd(), 'public/templates/broadcast-contacts.csv'),
  'utf8'
);

describe('broadcast CSV template', () => {
  it('has the name, company, phone header the step advertises', () => {
    expect(TEMPLATE.split(/\r?\n/)[0]).toBe('name,company,phone');
  });

  it('passes the upload step header check and parses every row', () => {
    const header = TEMPLATE.split(/\r?\n/)[0];
    // Mirrors the guard in step2-select-audience.tsx handleCsvFile.
    expect(/(^|,)\s*["']?phone["']?\s*(,|$)/i.test(header)).toBe(true);

    const { rows, hasCompanyColumn } = parseContactCsv(TEMPLATE);
    expect(hasCompanyColumn).toBe(true);
    expect(rows).toMatchObject([
      {
        phone: '+971501234567',
        name: 'Ahmed Al Mansoori',
        company: 'Al Safa Restaurant',
      },
      {
        phone: '+971559876543',
        name: 'Sara Khan',
        company: 'Spice Route Kitchen, LLC',
      },
    ]);
    // Every column is offered as a variable source in the personalize
    // step, with row 1 as the example.
    expect(rows[0].values).toEqual({
      name: 'Ahmed Al Mansoori',
      company: 'Al Safa Restaurant',
      phone: '+971501234567',
    });
  });

  it('accepts a real export in the template shape (E.164, plain names)', () => {
    const csv = [
      'name,company,phone',
      'Timothy Martin,White Stripe Safco Foods FZC,+971556331019',
      'Damir Kartal,Mövenpick Hotels & Resorts,+971554002797',
      'Fay Economides,M Management,+971502777005',
    ].join('\n');
    const { rows } = parseContactCsv(csv);
    expect(rows.map((r) => [r.name, r.company, r.phone])).toEqual([
      ['Timothy Martin', 'White Stripe Safco Foods FZC', '+971556331019'],
      ['Damir Kartal', 'Mövenpick Hotels & Resorts', '+971554002797'],
      ['Fay Economides', 'M Management', '+971502777005'],
    ]);
  });
});
