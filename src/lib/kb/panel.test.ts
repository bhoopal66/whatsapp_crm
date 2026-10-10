import { describe, expect, it } from 'vitest';

import {
  isKbStatus,
  kbEntryDraft,
  kbEntryPatch,
  kbStatusTone,
  parseKbImportHistory,
  parseKbImportResult,
} from './panel';
import type { KbEntry } from './types';

const entry: KbEntry = {
  id: 'e1',
  account_id: 'a1',
  ref: 'PC-001',
  audience: 'prospective_client',
  category: 'Fees',
  question: 'What does it cost?',
  answer_en: 'It is free.',
  answer_ar: null,
  status: 'draft',
  handoff_after: false,
  source: null,
  reviewer_notes: null,
  version: 1,
  approved_by: null,
  approved_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

describe('kbStatusTone', () => {
  it('maps each status to its pill tone', () => {
    expect(kbStatusTone('approved')).toBe('success');
    expect(kbStatusTone('draft')).toBe('neutral');
    expect(kbStatusTone('to_confirm')).toBe('warning');
    expect(kbStatusTone('remove')).toBe('muted');
  });
});

describe('kbEntryPatch', () => {
  it('is null for an untouched draft', () => {
    expect(kbEntryPatch(entry, kbEntryDraft(entry))).toBeNull();
  });

  it('ignores whitespace-only edits and blank optional fields', () => {
    const draft = {
      ...kbEntryDraft(entry),
      question: '  What does it cost?  ',
      answer_ar: '   ',
      reviewer_notes: '',
    };
    expect(kbEntryPatch(entry, draft)).toBeNull();
  });

  it('sends only changed fields, trimmed, blanks as null', () => {
    const stored = {
      ...entry,
      answer_ar: 'مجاني',
      reviewer_notes: 'ok',
      version: 3,
    };
    const draft = {
      ...kbEntryDraft(stored),
      answer_en: ' Free for everyone. ',
      answer_ar: ' ',
      status: 'approved' as const,
      handoff_after: true,
    };
    expect(kbEntryPatch(stored, draft)).toEqual({
      answer_en: 'Free for everyone.',
      answer_ar: null,
      status: 'approved',
      handoff_after: true,
      version: 3,
    });
  });

  it('carries the displayed version so a stale save is refused', () => {
    const stored = { ...entry, version: 7 };
    const draft = { ...kbEntryDraft(stored), status: 'approved' as const };
    expect(kbEntryPatch(stored, draft)).toEqual({
      status: 'approved',
      version: 7,
    });
  });
});

describe('parseKbImportResult', () => {
  it('reads the endpoint answer', () => {
    expect(
      parseKbImportResult({
        inserted: 3,
        updated: 2,
        unchanged: 1,
        skipped: 1,
        approved: 4,
        approved_internal: 2,
        import_id: 'i1',
        sheet: 'Knowledge_Base',
        issues: [
          { row: 7, ref: 'PC-009', message: 'No question', skipped: true },
          { row: null, ref: null, message: 'No Arabic column', skipped: false },
        ],
      })
    ).toEqual({
      inserted: 3,
      updated: 2,
      unchanged: 1,
      skipped: 1,
      approved: 4,
      approved_internal: 2,
      sheet: 'Knowledge_Base',
      issues: [
        { row: 7, ref: 'PC-009', message: 'No question', skipped: true },
        { row: null, ref: null, message: 'No Arabic column', skipped: false },
      ],
    });
  });

  it('reads garbage as zeros and drops malformed issues', () => {
    expect(
      parseKbImportResult({
        inserted: '3',
        updated: -1,
        issues: [null, { row: 2 }, 'x'],
      })
    ).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      approved: 0,
      approved_internal: 0,
      sheet: null,
      issues: [],
    });
    expect(parseKbImportResult(null).issues).toEqual([]);
  });
});

describe('parseKbImportHistory', () => {
  it('keeps well-formed rows and drops the rest', () => {
    expect(
      parseKbImportHistory([
        {
          id: 'i1',
          file_name: 'kb.xlsx',
          total: 10,
          inserted: 8,
          updated: 1,
          unchanged: 0,
          skipped: 1,
          approved: 6,
          created_at: '2026-10-09T10:00:00Z',
        },
        { id: 'i2' },
        null,
      ])
    ).toEqual([
      {
        id: 'i1',
        file_name: 'kb.xlsx',
        total: 10,
        inserted: 8,
        updated: 1,
        unchanged: 0,
        skipped: 1,
        approved: 6,
        created_at: '2026-10-09T10:00:00Z',
      },
    ]);
    expect(parseKbImportHistory(undefined)).toEqual([]);
  });
});

describe('isKbStatus', () => {
  it('accepts the four statuses only', () => {
    expect(isKbStatus('to_confirm')).toBe(true);
    expect(isKbStatus('all')).toBe(false);
    expect(isKbStatus(null)).toBe(false);
  });
});
