/**
 * What the voice-library dialog shows: pure, so it is tested without a
 * DOM. The database decides who may delete (242's policy); this only
 * decides whether to offer the button.
 */
import {
  canAddVoiceNotes,
  canDeleteAnyVoiceNote,
  type AccountRole,
} from '@/lib/auth/roles';

import {
  VOICE_BUILTIN_SUBJECTS,
  VOICE_LANGUAGES,
  type VoiceLanguage,
} from './constants';
import {
  entrySubjectKey,
  type SubjectKey,
  type VoiceEntryRow,
  type VoiceSubjectRow,
} from './types';

export function canDeleteEntry(
  entry: Pick<VoiceEntryRow, 'created_by'>,
  userId: string | null,
  role: AccountRole | null
): boolean {
  if (!role || !canAddVoiceNotes(role)) return false;
  if (canDeleteAnyVoiceNote(role)) return true;
  return !!userId && entry.created_by === userId;
}

export interface SubjectOption {
  key: SubjectKey;
  /** A built-in subject's key (translated by the caller), else null. */
  builtin: (typeof VOICE_BUILTIN_SUBJECTS)[number] | null;
  label: string | null;
  count: number;
}

/** Built-in subjects first (fixed order), then staff ones by label. */
export function subjectOptions(
  subjects: VoiceSubjectRow[],
  entries: VoiceEntryRow[]
): SubjectOption[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const k = entrySubjectKey(e);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const builtins: SubjectOption[] = VOICE_BUILTIN_SUBJECTS.map((b) => ({
    key: `builtin:${b}`,
    builtin: b,
    label: null,
    count: counts.get(`builtin:${b}`) ?? 0,
  }));
  const custom: SubjectOption[] = [...subjects]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((s) => ({
      key: s.id,
      builtin: null,
      label: s.label,
      count: counts.get(s.id) ?? 0,
    }));
  return [...builtins, ...custom];
}

/** Entries count per language within one subject. */
export function languageCounts(
  entries: VoiceEntryRow[],
  subject: SubjectKey
): Record<VoiceLanguage, number> {
  const out = Object.fromEntries(VOICE_LANGUAGES.map((l) => [l, 0])) as Record<
    VoiceLanguage,
    number
  >;
  for (const e of entries) {
    if (entrySubjectKey(e) === subject) out[e.language] += 1;
  }
  return out;
}

/** One subject and language, newest first. */
export function entriesFor(
  entries: VoiceEntryRow[],
  subject: SubjectKey,
  language: VoiceLanguage
): VoiceEntryRow[] {
  return entries
    .filter((e) => entrySubjectKey(e) === subject && e.language === language)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The first language with an entry in `subject`, else `fallback`. */
export function firstLanguageWithEntries(
  entries: VoiceEntryRow[],
  subject: SubjectKey,
  fallback: VoiceLanguage
): VoiceLanguage {
  const counts = languageCounts(entries, subject);
  if (counts[fallback] > 0) return fallback;
  return VOICE_LANGUAGES.find((l) => counts[l] > 0) ?? fallback;
}
