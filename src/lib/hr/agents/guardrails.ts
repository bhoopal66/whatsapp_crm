/**
 * 024a guardrails (pure). Deterministic checks that run before and after any model call:
 * opt-out, upset, sensitive (salary/offer/visa/contract/legal) escalation, the WhatsApp 24h window, caps,
 * the AI disclosure line, and a post-draft check that a draft never states salary, offer, visa or a date
 * unless the date came from the recruiter-supplied scheduling slots.
 */
import type { AgentLang, HandoffReason, Intent } from './types';

export const AI_DISCLOSURE =
  'This is an automated assistant; a recruiter will confirm.';
export const AI_DISCLOSURE_AR =
  '\u0647\u0630\u0627 \u0645\u0633\u0627\u0639\u062F \u0622\u0644\u064A\u061B \u0633\u064A\u0624\u0643\u062F \u0623\u062D\u062F \u0645\u0633\u0624\u0648\u0644\u064A \u0627\u0644\u062A\u0648\u0638\u064A\u0641.';
export const MAX_PENDING_DRAFTS = 3;
export const DEFAULT_REPLY_CAP = 5;
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_HOPS = 4;

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function bare(text: string): string {
  return norm(text)
    .replace(/[.!?,;:\u060C\u061B\u061F]/g, '')
    .trim();
}

function hasAr(text: string, words: readonly string[]): boolean {
  return words.some((w) => text.includes(w));
}

export function detectLang(text: string): AgentLang {
  return /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en';
}

const OPT_OUT_EXACT = [
  'stop',
  'unsubscribe',
  '\u062A\u0648\u0642\u0641',
  '\u0627\u0644\u063A\u0627\u0621',
  '\u0625\u0644\u063A\u0627\u0621',
];
const OPT_OUT_EN =
  /\b(unsubscribe|opt[ -]?out|do not (contact|message) me|stop messaging me)\b/i;
const OPT_OUT_AR = [
  '\u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643',
  '\u0627\u0644\u063A\u0627\u0621 \u0627\u0644\u0627\u0634\u062A\u0631\u0627\u0643',
  '\u0644\u0627 \u062A\u0631\u0627\u0633\u0644\u0646\u064A',
  '\u062A\u0648\u0642\u0641\u0648\u0627 \u0639\u0646 \u0645\u0631\u0627\u0633\u0644\u062A\u064A',
];

export function isOptOut(text: string): boolean {
  const b = bare(text);
  return (
    OPT_OUT_EXACT.includes(b) ||
    OPT_OUT_EN.test(text) ||
    hasAr(text, OPT_OUT_AR)
  );
}

const UPSET_EN =
  /\b(angry|upset|furious|unacceptable|terrible|worst|disappointed|ridiculous|disgusting|fed up)\b/i;
const UPSET_AR = [
  '\u063A\u0627\u0636\u0628',
  '\u0632\u0639\u0644\u0627\u0646',
  '\u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644',
  '\u0633\u064A\u0621 \u062C\u062F\u0627',
  '\u0645\u0633\u062A\u0627\u0621',
];

export function isUpset(text: string): boolean {
  return UPSET_EN.test(text) || hasAr(text, UPSET_AR);
}

/** Sensitive topics: never answered by an agent draft; routed to the escalation agent (handoff 'keyword'). */
const SENSITIVE_EN =
  /\b(salar(y|ies)|pay ?package|offer\w*|visa\w*|contract\w*|lawyer\w*|legal action|complain\w*)\b/i;
const SENSITIVE_AR = [
  '\u0631\u0627\u062A\u0628',
  '\u0627\u0644\u0631\u0627\u062A\u0628',
  '\u0631\u0648\u0627\u062A\u0628',
  '\u0639\u0631\u0636 \u0627\u0644\u0639\u0645\u0644',
  '\u0639\u0631\u0636 \u0648\u0638\u064A\u0641\u064A',
  '\u062A\u0623\u0634\u064A\u0631\u0629',
  '\u0641\u064A\u0632\u0627',
  '\u0625\u0642\u0627\u0645\u0629',
  '\u0639\u0642\u062F',
  '\u0645\u062D\u0627\u0645\u064A',
  '\u0634\u0643\u0648\u0649',
];

export function isSensitive(text: string): boolean {
  return SENSITIVE_EN.test(text) || hasAr(text, SENSITIVE_AR);
}

export interface PreCheck {
  intent: Intent;
  handoff?: HandoffReason;
  flag?: 'urgent';
  optOut?: boolean;
  reason: string;
}

/** Keyword gate on the inbound text; null when the model may classify. Order: opt-out, upset, sensitive. */
export function preCheck(text: string): PreCheck | null {
  if (isOptOut(text))
    return { intent: 'opt_out', optOut: true, reason: 'opt-out keyword' };
  if (isUpset(text))
    return {
      intent: 'upset',
      handoff: 'triage',
      flag: 'urgent',
      reason: 'upset keyword',
    };
  if (isSensitive(text))
    return {
      intent: 'salary_offer_visa',
      handoff: 'keyword',
      reason: 'sensitive keyword',
    };
  return null;
}

/** WhatsApp customer-service window: a free-form reply is allowed only within 24h of the last inbound message. */
export function insideWindow(lastInboundAt: string | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  const t = Date.parse(lastInboundAt);
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age < WINDOW_MS;
}

export function capReached(
  pendingDrafts: number,
  draftsToday: number,
  replyCap: number = DEFAULT_REPLY_CAP
): 'pending' | 'daily' | null {
  if (pendingDrafts >= MAX_PENDING_DRAFTS) return 'pending';
  if (draftsToday >= replyCap) return 'daily';
  return null;
}

const PROMISE_EN =
  /\b(salar(y|ies)|offer\w*|visa\w*|contract\w*|aed|dhs|dirhams?)\b|\d[\d,]*\s?(aed|dhs|usd|\$)/i;
const PROMISE_AR = [
  '\u0631\u0627\u062A\u0628',
  '\u0639\u0631\u0636',
  '\u062A\u0623\u0634\u064A\u0631\u0629',
  '\u0641\u064A\u0632\u0627',
  '\u0639\u0642\u062F',
  '\u062F\u0631\u0647\u0645',
];
const DATE_EN =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?|\d{1,2}(:\d{2})?\s?(am|pm)|\d{1,2}:\d{2}|today|tomorrow|tonight|next (week|month)|(mon|tues|wednes|thurs|fri|satur|sun)day|jan(uary)?|feb(ruary)?|march|april|june|july|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const DATE_AR = [
  '\u063A\u062F\u0627',
  '\u0627\u0644\u064A\u0648\u0645',
  '\u0627\u0644\u0623\u0633\u0628\u0648\u0639 \u0627\u0644\u0642\u0627\u062F\u0645',
  '\u0627\u0644\u0627\u062B\u0646\u064A\u0646',
  '\u0627\u0644\u062B\u0644\u0627\u062B\u0627\u0621',
  '\u0627\u0644\u0623\u0631\u0628\u0639\u0627\u0621',
  '\u0627\u0644\u062E\u0645\u064A\u0633',
  '\u0627\u0644\u062C\u0645\u0639\u0629',
  '\u0627\u0644\u0633\u0628\u062A',
  '\u0627\u0644\u0623\u062D\u062F',
];

/** Post-draft check: returns the violation or null. Slot strings are removed first, so a supplied slot may be quoted. */
export function draftViolation(
  body: string,
  slots: readonly string[] = []
): 'promise' | 'date' | null {
  let rest = body;
  for (const s of slots) if (s) rest = rest.split(s).join(' ');
  if (PROMISE_EN.test(rest) || hasAr(rest, PROMISE_AR)) return 'promise';
  if (DATE_EN.test(rest) || hasAr(rest, DATE_AR)) return 'date';
  return null;
}

export function withDisclosure(body: string, lang: AgentLang): string {
  const b = body.trim();
  return lang === 'ar'
    ? `${b}\n${AI_DISCLOSURE_AR}\n${AI_DISCLOSURE}`
    : `${b}\n${AI_DISCLOSURE}`;
}
