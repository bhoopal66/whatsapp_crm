import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { linkTargets, parseCompanyOverview } from './shared-docs';
import { DESK_REFUSALS } from './store';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/231_desk_shared_documents.sql'),
  'utf8'
);

const RAW = {
  cases: [
    {
      case_id: 'kR',
      case_number: 'TC-26-00001-RAK',
      bank_code: 'RAK',
      stage: 'Interested',
      closed: false,
      can_read: true,
      can_write: true,
    },
    {
      case_id: 'kE',
      case_number: 'TC-26-00001-ENB',
      bank_code: 'ENBD',
      stage: 'Review',
      closed: false,
      can_read: false,
      can_write: true,
    },
    {
      case_id: 'kE2',
      case_number: 'TC-26-00001-ENB2',
      bank_code: 'ENBD',
      stage: 'Review',
      closed: true,
      can_read: true,
      can_write: true,
    },
    {
      case_id: 'kF',
      case_number: 'TC-26-00001-FAB',
      bank_code: 'FAB',
      stage: 'Interested',
      closed: false,
      can_read: false,
      can_write: false,
    },
  ],
  files: [
    {
      file_id: 'f1',
      case_id: 'kR',
      customer_document_id: 'd1',
      status: 'passed',
      shared: false,
    },
  ],
  consents: [
    { bank_code: 'ENBD', evidence: 'yes', granted_at: 't', revoked_at: null },
    {
      bank_code: 'FAB',
      evidence: 'yes',
      granted_at: 't',
      revoked_at: 't2',
      revoke_reason: 'no',
    },
  ],
};

describe('shared documents (migration 231)', () => {
  it('knows every hint migration 231 raises', () => {
    const hints = new Set(
      [...SQL.matchAll(/desk_refuse\('[a-z_]+', '([A-Z_]+)'/g)].map((m) => m[1])
    );
    expect(hints.size).toBeGreaterThan(5);
    for (const x of hints)
      expect(DESK_REFUSALS as readonly string[]).toContain(x);
  });

  it('parses the overview defensively, wrapped or not', () => {
    const o = parseCompanyOverview(RAW);
    expect(o.cases).toHaveLength(4);
    expect(o.files[0]).toMatchObject({
      fileId: 'f1',
      caseId: 'kR',
      shared: false,
    });
    expect(
      parseCompanyOverview({ desk_company_overview: RAW }).cases
    ).toHaveLength(4);
    expect(parseCompanyOverview(null)).toEqual({
      cases: [],
      files: [],
      consents: [],
    });
  });

  it('offers only open writable cases without the document, flagging a missing consent', () => {
    const o = parseCompanyOverview(RAW);
    const t = linkTargets(o, o.files[0]!);
    // kE: writable, consented. kE2 closed, kF not writable: left out.
    expect(t.map((x) => [x.target.caseId, x.needsConsent])).toEqual([
      ['kE', false],
    ]);
    const noConsent = { ...o, consents: [] };
    expect(linkTargets(noConsent, o.files[0]!)[0]!.needsConsent).toBe(true);
  });
});
