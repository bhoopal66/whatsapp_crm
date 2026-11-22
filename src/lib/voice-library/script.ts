/**
 * Scripts for AI-spoken voice notes: validation and the {name} /
 * {company} filling a personalised entry gets at send time. Pure, so the
 * routes and the add dialog share one answer.
 */
import {
  ENTRY_TITLE_MAX,
  SCRIPT_MAX,
  SUBJECT_LABEL_MAX,
  type VoiceLanguage,
} from './constants';

/** The placeholders a personalised script may use. */
export const SCRIPT_PLACEHOLDERS = ['name', 'company'] as const;
export type ScriptPlaceholder = (typeof SCRIPT_PLACEHOLDERS)[number];

const PLACEHOLDER = /\{\s*([a-zA-Z_]+)\s*\}/g;

/** Placeholder names a script uses, lower-cased, in order, deduplicated. */
export function scriptPlaceholders(script: string): string[] {
  const seen: string[] = [];
  for (const m of script.matchAll(PLACEHOLDER)) {
    const key = m[1].toLowerCase();
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

export type ScriptProblem =
  | 'empty'
  | 'too_long'
  | 'unknown_placeholder'
  | 'placeholder_in_fixed'
  | 'no_placeholder';

/**
 * Why a script cannot be saved, or null. A fixed script may not carry
 * a placeholder (it would be spoken as "curly name"); a personalised one
 * must use at least one, and only {name} / {company}.
 */
export function scriptProblem(
  script: string,
  personalised: boolean
): ScriptProblem | null {
  if (!script.trim()) return 'empty';
  if (script.length > SCRIPT_MAX) return 'too_long';
  const used = scriptPlaceholders(script);
  if (!personalised) return used.length > 0 ? 'placeholder_in_fixed' : null;
  if (used.some((p) => !(SCRIPT_PLACEHOLDERS as readonly string[]).includes(p)))
    return 'unknown_placeholder';
  return used.length === 0 ? 'no_placeholder' : null;
}

/** A trimmed one-line label within `max`, or null when blank / too long. */
export function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const label = value.replace(/\s+/g, ' ').trim();
  if (!label || label.length > max) return null;
  return label;
}

export const cleanTitle = (v: unknown) => cleanLabel(v, ENTRY_TITLE_MAX);
export const cleanSubjectLabel = (v: unknown) =>
  cleanLabel(v, SUBJECT_LABEL_MAX);

/**
 * "Your company" in each language, said when a personalised script names
 * {company} and the contact has none. A missing name is simply left out
 * (see `fillScript`), which reads naturally after a greeting.
 */
export const COMPANY_FALLBACK: Record<VoiceLanguage, string> = {
  en: 'your company',
  hi: 'आपकी कंपनी',
  ar: 'شركتكم',
  ur: 'آپ کی کمپنی',
};

const VALUE_MAX = 60;

/**
 * A contact field safe to speak: control characters and markup-ish
 * brackets removed, whitespace collapsed, at most 60 characters, and
 * null when nothing speakable is left (no letter at all, e.g. a phone
 * number saved as the name).
 */
export function speakableValue(
  value: string | null | undefined
): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f<>{}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VALUE_MAX)
    .trim();
  if (!cleaned || !/\p{L}/u.test(cleaned)) return null;
  return cleaned;
}

/**
 * The script with {name} and {company} filled in for one contact. A
 * missing name is removed and the gap tidied ("Hello {name}, welcome" →
 * "Hello, welcome"); a missing company becomes the language's "your
 * company". Unknown placeholders are removed (a saved script cannot hold
 * one, but nothing literal in braces is ever spoken).
 */
export function fillScript(
  script: string,
  values: { name?: string | null; company?: string | null },
  language: VoiceLanguage
): string {
  const name = speakableValue(values.name);
  const company = speakableValue(values.company) ?? COMPANY_FALLBACK[language];
  const filled = script.replace(PLACEHOLDER, (_m, key: string) => {
    const k = key.toLowerCase();
    if (k === 'name') return name ?? '';
    if (k === 'company') return company;
    return '';
  });
  return tidy(filled);
}

/** Collapse the gaps a removed value leaves behind. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, ' ')
        // "Hello , welcome" / "Hello ،" → no space before punctuation.
        .replace(/[ \t]+([,.!?;:،؟])/g, '$1')
        // A comma left doubled or leading a line.
        .replace(/([,،])(\s*[,،])+/g, '$1')
        .replace(/^\s*[,،]\s*/, '')
        .trim()
    )
    .join('\n')
    .trim();
}
