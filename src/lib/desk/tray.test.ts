import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DESK_REFUSALS } from './store';
import { TRAY_REASONS, needsCompanyConfirm, parseCandidates } from './tray';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/230_desk_whatsapp_routing.sql'),
  'utf8'
);

const SQL_303 = readFileSync(
  join(process.cwd(), 'supabase/migrations/303_desk_fixes.sql'),
  'utf8'
);

describe('desk tray (migration 230)', () => {
  it('has the reasons of the SQL CHECK, in order', () => {
    const m = SQL_303.match(
      /desk_tray_reason_check CHECK \(reason IN \(([^)]*)\)\)/
    );
    const reasons = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (x) => x[1]
    );
    expect(reasons).toEqual([...TRAY_REASONS]);
  });

  it('knows every hint migration 230 raises', () => {
    const hints = new Set(
      [...(SQL + SQL_303).matchAll(/desk_refuse\('[a-z_]+', '([A-Z_]+)'/g)].map(
        (m) => m[1]
      )
    );
    expect(hints.size).toBeGreaterThan(5);
    for (const x of hints)
      expect(DESK_REFUSALS as readonly string[]).toContain(x);
  });

  it('asks for the company name only when the sender does not act for it', () => {
    const item = {
      senderCompanies: [{ company: 'Kite  General Trading', role: 'pro' }],
    };
    expect(needsCompanyConfirm(item, { company: 'kite general trading' })).toBe(
      false
    );
    expect(needsCompanyConfirm(item, { company: 'Maro Trading' })).toBe(true);
    expect(
      needsCompanyConfirm({ senderCompanies: [] }, { company: 'Kite' })
    ).toBe(true);
  });

  it('reads candidates defensively and keeps only known reasons', () => {
    expect(
      parseCandidates([
        {
          case_id: 'k1',
          case_number: 'TC-26-00001-RAK',
          bank_code: 'RAK',
          company: 'Kite',
          why: ['code', 'x'],
        },
        { nope: true },
        'junk',
      ])
    ).toEqual([
      {
        caseId: 'k1',
        caseNumber: 'TC-26-00001-RAK',
        bankCode: 'RAK',
        company: 'Kite',
        product: null,
        why: ['code'],
      },
    ]);
    expect(parseCandidates(null)).toEqual([]);
  });
});
