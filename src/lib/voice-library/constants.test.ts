import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ENTRY_TITLE_MAX,
  SCRIPT_MAX,
  SUBJECT_LABEL_MAX,
  VOICE_BUILTIN_SUBJECTS,
  VOICE_LANGUAGES,
  VOICE_SOURCES,
  isBuiltinSubject,
  isVoiceLanguage,
  voiceLibraryPath,
} from './constants';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/242_voice_note_library.sql'),
  'utf8'
);

/** The quoted values of the IN (...) list inside the named CHECK. */
function checkList(name: string): string[] {
  const at = sql.indexOf(`CONSTRAINT ${name}`);
  expect(at).toBeGreaterThan(-1);
  const list = /IN\s*\(([^)]*)\)/.exec(sql.slice(at))![1];
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('voice library constants pinned to migration 242', () => {
  it('languages equal the language CHECK', () => {
    expect(checkList('voice_note_entries_language_check')).toEqual([
      ...VOICE_LANGUAGES,
    ]);
  });

  it('built-in subjects equal the subject CHECK', () => {
    expect(checkList('voice_note_entries_builtin_subject_check')).toEqual([
      ...VOICE_BUILTIN_SUBJECTS,
    ]);
  });

  it('sources equal the source CHECK', () => {
    expect(checkList('voice_note_entries_source_check')).toEqual([
      ...VOICE_SOURCES,
    ]);
  });

  it('length limits equal the CHECKs', () => {
    expect(sql).toContain(
      `char_length(label) BETWEEN 1 AND ${SUBJECT_LABEL_MAX}`
    );
    expect(sql).toContain(
      `char_length(title) BETWEEN 1 AND ${ENTRY_TITLE_MAX}`
    );
    expect(sql).toContain(`char_length(script) BETWEEN 1 AND ${SCRIPT_MAX}`);
  });

  it('the storage path matches the path CHECK', () => {
    const p = voiceLibraryPath('acc-1', 'e-1');
    expect(p).toBe('account-acc-1/voice-library/e-1.ogg');
    expect(sql).toContain("'/voice-library/%'");
    // Never under staged/: the staged sweep (155) would delete it.
    expect(p).not.toContain('/staged/');
  });

  it('guards accept only listed values', () => {
    expect(isVoiceLanguage('ur')).toBe(true);
    expect(isVoiceLanguage('fr')).toBe(false);
    expect(isBuiltinSubject('welcome')).toBe(true);
    expect(isBuiltinSubject('pricing')).toBe(false);
  });
});
