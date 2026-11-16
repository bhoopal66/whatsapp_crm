/**
 * HR automated messages: the template catalogue (seed) and the pure
 * template checks. Fixed texts with {name} / {slot} placeholders, en and
 * ar. Every seed is 'draft': nothing is sent from it until an admin
 * records Meta approval for the workspace. `render()` fills placeholders
 * from validated params only.
 *
 * Client components import this file: it must import only `./types`.
 */
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_KINDS,
  type AutoLang,
  type TemplateCategory,
  type TemplateKind,
} from './types';

export const SEED_TEMPLATES: Readonly<
  Record<
    TemplateKind,
    { metaTemplateName: string; text: Record<AutoLang, string> }
  >
> = {
  cv_ack: {
    metaTemplateName: 'hr_cv_ack',
    text: {
      en: 'Hello {name}, thank you for your application. We have received your CV and will update you on the next step.',
      ar: '\u0645\u0631\u062D\u0628\u0627 {name}\u060C \u0634\u0643\u0631\u0627 \u0644\u062A\u0642\u062F\u064A\u0645\u0643. \u0627\u0633\u062A\u0644\u0645\u0646\u0627 \u0633\u064A\u0631\u062A\u0643 \u0627\u0644\u0630\u0627\u062A\u064A\u0629 \u0648\u0633\u0646\u0628\u0644\u063A\u0643 \u0628\u0627\u0644\u062E\u0637\u0648\u0629 \u0627\u0644\u062A\u0627\u0644\u064A\u0629.',
    },
  },
  ai_interview_invite: {
    metaTemplateName: 'hr_ai_interview_invite',
    text: {
      en: 'Hello {name}, you have been shortlisted for an AI interview. Your interview time is {slot}.',
      ar: '\u0645\u0631\u062D\u0628\u0627 {name}\u060C \u062A\u0645 \u0627\u062E\u062A\u064A\u0627\u0631\u0643 \u0644\u0645\u0642\u0627\u0628\u0644\u0629 \u0622\u0644\u064A\u0629. \u0645\u0648\u0639\u062F \u0645\u0642\u0627\u0628\u0644\u062A\u0643: {slot}.',
    },
  },
  hr_interview_invite: {
    metaTemplateName: 'hr_hr_interview_invite',
    text: {
      en: 'Hello {name}, we would like to invite you to an HR interview on {slot}.',
      ar: '\u0645\u0631\u062D\u0628\u0627 {name}\u060C \u064A\u0633\u0639\u062F\u0646\u0627 \u062F\u0639\u0648\u062A\u0643 \u0644\u0645\u0642\u0627\u0628\u0644\u0629 \u0645\u0639 \u0627\u0644\u0645\u0648\u0627\u0631\u062F \u0627\u0644\u0628\u0634\u0631\u064A\u0629 \u0641\u064A {slot}.',
    },
  },
  manager_interview_invite: {
    metaTemplateName: 'hr_manager_interview_invite',
    text: {
      en: 'Hello {name}, we would like to invite you to an interview with the hiring manager on {slot}.',
      ar: '\u0645\u0631\u062D\u0628\u0627 {name}\u060C \u064A\u0633\u0639\u062F\u0646\u0627 \u062F\u0639\u0648\u062A\u0643 \u0644\u0645\u0642\u0627\u0628\u0644\u0629 \u0645\u0639 \u0627\u0644\u0645\u062F\u064A\u0631 \u0627\u0644\u0645\u0633\u0624\u0648\u0644 \u0641\u064A {slot}.',
    },
  },
  interview_reminder: {
    metaTemplateName: 'hr_interview_reminder',
    text: {
      en: 'Hello {name}, this is a reminder of your interview on {slot}.',
      ar: '\u0645\u0631\u062D\u0628\u0627 {name}\u060C \u0646\u0630\u0643\u0631\u0643 \u0628\u0645\u0648\u0639\u062F \u0645\u0642\u0627\u0628\u0644\u062A\u0643 \u0641\u064A {slot}.',
    },
  },
  reply_nudge: {
    metaTemplateName: 'hr_reply_nudge',
    text: {
      en: 'Hello {name}, we are still waiting for your reply. Reply STOP to stop these messages.',
      ar: '\u0645\u0631\u062D\u0628\u0627 {name}\u060C \u0645\u0627 \u0632\u0644\u0646\u0627 \u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u0631\u062F\u0643. \u0623\u0631\u0633\u0644 STOP \u0644\u0625\u064A\u0642\u0627\u0641 \u0647\u0630\u0647 \u0627\u0644\u0631\u0633\u0627\u0626\u0644.',
    },
  },
};

export class TemplateParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateParamError';
  }
}

/** Longest value a placeholder may take. */
export const MAX_PARAM_LENGTH = 80;
/** {name} when there is no usable contact name: the template then reads "Hello there". */
export const NAME_FALLBACK = 'there';
/** {slot} when no interview time is known. */
export const SLOT_FALLBACK = 'a time we will confirm shortly';

export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))];
}

/**
 * Fills every placeholder. Throws TemplateParamError on a missing or
 * unknown param, a value that is empty, longer than MAX_PARAM_LENGTH, or
 * carries a control character or a brace (so a param cannot smuggle text
 * or another placeholder).
 */
export function render(text: string, params: Record<string, string>): string {
  const want = placeholders(text);
  for (const k of Object.keys(params))
    if (!want.includes(k)) throw new TemplateParamError(`unknown param ${k}`);
  for (const k of want) {
    const v = params[k];
    if (typeof v !== 'string' || v.trim() === '')
      throw new TemplateParamError(`missing param ${k}`);
    if (v.length > MAX_PARAM_LENGTH)
      throw new TemplateParamError(`param ${k} is too long`);
    if (/[\u0000-\u001F\u007F{}]/.test(v))
      throw new TemplateParamError(`param ${k} has a forbidden character`);
  }
  return text.replace(/\{([a-z_]+)\}/g, (_m, k: string) => params[k]);
}

/**
 * Sanitises a value to the render rules: control characters and braces
 * become spaces, whitespace collapses, trimmed, cut to MAX_PARAM_LENGTH;
 * empty afterwards -> the fallback.
 */
export function sanitizeParam(
  v: string | null | undefined,
  fallback: string
): string {
  const s = (v ?? '')
    .replace(/[\u0000-\u001F\u007F{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PARAM_LENGTH)
    .trim();
  return s === '' ? fallback : s;
}

/** Placeholders an admin template body may use. */
export const ALLOWED_PLACEHOLDERS: readonly string[] = ['name', 'slot'];
export const MAX_TEMPLATE_BODY = 1024;

/** Required placeholders per kind, from the en seed body (the ar seed carries the same set). */
export function requiredPlaceholders(kind: TemplateKind): string[] {
  return placeholders(SEED_TEMPLATES[kind].text.en);
}

/** Kinds sent by the six transactional triggers: every one must be UTILITY. Today that is every kind. */
export const UTILITY_ONLY_KINDS: readonly TemplateKind[] = TEMPLATE_KINDS;

/**
 * Promotional wording markers for UTILITY templates (package SPEC_027
 * section 2). Phrases, not single words, so recruitment text such as "job
 * offer", "your offer letter", "feel free to reply" or "Sales Executive"
 * stays allowed. English: case-insensitive, word-bounded. Arabic:
 * substring (Arabic letters are not word characters to \b).
 */
export const PROMO_PHRASES_EN: readonly { phrase: string; re: RegExp }[] = [
  { phrase: 'discount', re: /\bdiscount(s|ed)?\b/i },
  // offer as a sales term; "job offer" passes
  {
    phrase: 'special offer',
    re: /\b(special|exclusive|limited|best) offers?\b/i,
  },
  // singular "sale"; "Sales Executive" passes
  { phrase: 'sale', re: /\b(on|for|big|flash) sale\b|\bsale\b(?!s)/i },
  // "feel free to reply" passes
  { phrase: 'free', re: /\b(for free|free (gift|trial|offer)|100% free)\b/i },
  // "promotion" (a job move) passes
  { phrase: 'promo', re: /\bpromo(s|tional)?\b|\bpromo code\b/i },
  { phrase: 'limited time', re: /\blimited[- ]time\b/i },
  { phrase: 'apply now', re: /\bapply now\b/i },
  {
    phrase: 'other openings',
    re: /\bother (openings|vacancies|jobs|positions)\b/i,
  },
  { phrase: 'visit our website', re: /\bvisit our (website|site|page)\b/i },
  { phrase: 'url', re: /\bhttps?:\/\/|\bwww\./i },
  { phrase: 'click here', re: /\bclick here\b/i },
];
export const PROMO_PHRASES_AR: readonly { phrase: string; text: string }[] = [
  { phrase: 'discount', text: 'خصم' },
  { phrase: 'reduction', text: 'تخفيض' },
  // "job offer" (ard al-amal) passes
  { phrase: 'special offer', text: 'عرض خاص' },
  { phrase: 'free', text: 'مجان' },
  {
    phrase: 'limited time',
    text: 'لفترة محدودة',
  },
  {
    phrase: 'other jobs',
    text: 'وظائف أخرى',
  },
  {
    phrase: 'other vacancies',
    text: 'شواغر أخرى',
  },
  {
    phrase: 'visit our website',
    text: 'زوروا موقعنا',
  },
  { phrase: 'click here', text: 'اضغط هنا' },
];

/** The first promotional marker in body, or null. Deterministic; no model. */
export function promotionalPhrase(body: string): string | null {
  for (const p of PROMO_PHRASES_EN) if (p.re.test(body)) return p.phrase;
  for (const p of PROMO_PHRASES_AR) if (body.includes(p.text)) return p.phrase;
  return null;
}

export type TemplateBodyCheck =
  'ok' | 'CATEGORY_NOT_UTILITY' | 'INVALID' | 'PROMOTIONAL';

/**
 * Pure check of a template body, in this order: the category (an unknown
 * one is INVALID, a non-utility one for a transactional kind is
 * CATEGORY_NOT_UTILITY), the body rules (length 1..1024, no control
 * character, no unmatched or nested brace, only {name} / {slot}, every
 * placeholder the kind's seed uses), then promotional wording.
 */
export function validateTemplateBody(
  kind: TemplateKind,
  body: string,
  category: TemplateCategory = 'utility'
): TemplateBodyCheck {
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(category))
    return 'INVALID';
  if (UTILITY_ONLY_KINDS.includes(kind) && category !== 'utility')
    return 'CATEGORY_NOT_UTILITY';
  if (body.length < 1 || body.length > MAX_TEMPLATE_BODY) return 'INVALID';
  if (/[\u0000-\u001F\u007F]/.test(body)) return 'INVALID';
  if (/[{}]/.test(body.replace(/\{[a-z_]+\}/g, ''))) return 'INVALID';
  const used = placeholders(body);
  for (const p of used) if (!ALLOWED_PLACEHOLDERS.includes(p)) return 'INVALID';
  for (const p of requiredPlaceholders(kind))
    if (!used.includes(p)) return 'INVALID';
  if (category === 'utility' && promotionalPhrase(body) !== null)
    return 'PROMOTIONAL';
  return 'ok';
}
