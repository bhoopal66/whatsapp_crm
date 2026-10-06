import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  META_FAILURE_NO_REASON,
  META_FAILURE_REASONS,
  describeMetaFailure,
} from './meta-failure';

describe('describeMetaFailure', () => {
  it('names the codes that decide whether a retry is worth it', () => {
    expect(describeMetaFailure(131049, 'ecosystem')).toMatch(
      /limiting marketing messages .* Do not retry soon/
    );
    expect(describeMetaFailure(131026, 'Message undeliverable')).toMatch(
      /^Undeliverable: the number is not on WhatsApp/
    );
    expect(describeMetaFailure(130472, 'experiment')).toMatch(
      /Meta marketing experiment/
    );
    expect(describeMetaFailure(131047)).toMatch(
      /24-hour service window is closed\. Send an approved template/
    );
    expect(describeMetaFailure(131031, 'Business Account locked')).toMatch(
      /Business Account is locked\. Check WhatsApp Manager/
    );
  });

  it('keeps the code in the known wording, so it stays searchable', () => {
    for (const [code, text] of Object.entries(META_FAILURE_REASONS)) {
      expect(text).toContain(`(Meta ${code})`);
    }
  });

  it('accepts the code as a string, as it comes out of the ledger JSON', () => {
    expect(describeMetaFailure('131026')).toBe(META_FAILURE_REASONS['131026']);
  });

  it("falls back to Meta's own words for an unknown code", () => {
    expect(describeMetaFailure(131000, 'Something went wrong')).toBe(
      'Meta 131000: Something went wrong'
    );
    expect(describeMetaFailure(131000, null, 'Media download failed')).toBe(
      'Meta 131000: Media download failed'
    );
    expect(describeMetaFailure(131000)).toBe('Meta 131000');
    expect(describeMetaFailure(null, 'Rate limit hit')).toBe(
      'Meta: Rate limit hit'
    );
    expect(describeMetaFailure()).toBe(META_FAILURE_NO_REASON);
    expect(describeMetaFailure('  ', '  ', '')).toBe(META_FAILURE_NO_REASON);
  });
});

// describe_meta_failure() (migration 066) fills the same reason in from
// the cost ledger when a receipt was lost to the wamid-stamp race. If
// the wordings drift, one campaign shows two phrasings of one failure.
const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/066_broadcast_status_reconcile.sql'),
  'utf8'
);

describe('describeMetaFailure: TypeScript and SQL agree', () => {
  it.each(Object.entries(META_FAILURE_REASONS))('%s', (code, text) => {
    expect(text).not.toContain("'");
    expect(SQL).toContain(`WHEN '${code}' THEN '${text}'`);
  });

  it('has no SQL branch the TypeScript lacks', () => {
    const sqlCodes = [...SQL.matchAll(/WHEN '(\d+)' THEN '/g)].map((m) => m[1]);
    expect(sqlCodes.sort()).toEqual(Object.keys(META_FAILURE_REASONS).sort());
  });

  it('uses the same fallbacks', () => {
    expect(SQL).toContain(`format('Meta %s: %s'`);
    expect(SQL).toContain(`'Meta ' || btrim(p_code)`);
    expect(SQL).toContain(`'Meta: ' || coalesce(`);
    expect(SQL).toContain(`ELSE '${META_FAILURE_NO_REASON}'`);
  });
});
