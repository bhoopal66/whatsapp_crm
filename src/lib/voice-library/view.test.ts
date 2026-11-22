import { describe, expect, it } from 'vitest';

import type { VoiceEntryRow } from './types';
import {
  canDeleteEntry,
  entriesFor,
  firstLanguageWithEntries,
  languageCounts,
  subjectOptions,
} from './view';

const SUB = '0b9a4a43-3f0d-4a6e-9d2a-2a5e4c1f6b11';

function entry(over: Partial<VoiceEntryRow>): VoiceEntryRow {
  return {
    id: 'e',
    builtin_subject: 'welcome',
    subject_id: null,
    language: 'en',
    title: 'T',
    source: 'recording',
    script: null,
    personalised: false,
    voice: null,
    media_url: 'https://x/a.ogg',
    duration_ms: null,
    created_by: 'u1',
    created_at: '2026-11-01T00:00:00Z',
    ...over,
  };
}

describe('canDeleteEntry', () => {
  it('offers delete to the author and to admins, never to viewers', () => {
    const e = entry({ created_by: 'u1' });
    expect(canDeleteEntry(e, 'u1', 'agent')).toBe(true);
    expect(canDeleteEntry(e, 'u2', 'agent')).toBe(false);
    expect(canDeleteEntry(e, 'u2', 'team_leader')).toBe(false);
    expect(canDeleteEntry(e, 'u2', 'admin')).toBe(true);
    expect(canDeleteEntry(e, 'u1', 'viewer')).toBe(false);
    expect(canDeleteEntry(e, 'u1', 'bank_guest')).toBe(false);
  });
});

describe('subjects and languages', () => {
  const entries = [
    entry({ id: 'a', language: 'ar' }),
    entry({ id: 'b', language: 'ar', created_at: '2026-11-02T00:00:00Z' }),
    entry({ id: 'c', builtin_subject: null, subject_id: SUB, language: 'ur' }),
  ];

  it('lists built-ins first, then staff subjects, with counts', () => {
    const opts = subjectOptions(
      [
        { id: SUB, label: 'Bank visit', created_by: 'u1' },
        { id: 'z', label: 'Appointments', created_by: 'u1' },
      ],
      entries
    );
    expect(opts.map((o) => o.key)).toEqual([
      'builtin:welcome',
      'builtin:documents_required',
      'builtin:missing_documents',
      'builtin:status_update',
      'z',
      SUB,
    ]);
    expect(opts[0].count).toBe(2);
    expect(opts[5].count).toBe(1);
  });

  it('counts per language and picks one that has entries', () => {
    expect(languageCounts(entries, 'builtin:welcome')).toEqual({
      en: 0,
      hi: 0,
      ar: 2,
      ur: 0,
    });
    expect(firstLanguageWithEntries(entries, 'builtin:welcome', 'en')).toBe(
      'ar'
    );
    expect(
      firstLanguageWithEntries(entries, 'builtin:status_update', 'hi')
    ).toBe('hi');
  });

  it('filters one subject and language, newest first', () => {
    expect(
      entriesFor(entries, 'builtin:welcome', 'ar').map((e) => e.id)
    ).toEqual(['b', 'a']);
    expect(entriesFor(entries, SUB, 'ur').map((e) => e.id)).toEqual(['c']);
  });
});
