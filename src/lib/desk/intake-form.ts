/**
 * How an upload's caption meets its form fields (package 035b/035d): a
 * caption fills only the tags the form left empty, never overrides one.
 * A `NEW <BBB> …` caption names the bank by its three-letter desk code;
 * the route maps that to a bank (`desk_bank_by_short`) when the form
 * named no bank, and an unknown code leaves the bank empty (the item then
 * waits in the no-bank queue). Pure.
 */
import { docKeyOf, parseCaptionText } from './caption';
import type { ItemTags } from './store';

export interface MergedTags {
  tags: ItemTags;
  /** A desk code to map to a bank, when the form named none. */
  deskCode: string | null;
}

export function mergeCaption(
  tags: ItemTags,
  caption: string | null
): MergedTags {
  if (caption === null || caption.trim() === '')
    return { tags, deskCode: null };
  const p = parseCaptionText(caption);
  const out: ItemTags = { ...tags };
  let deskCode: string | null = null;
  const fill = <K extends keyof ItemTags>(k: K, v: ItemTags[K] | undefined) => {
    if (out[k] === null && v !== undefined && v !== null && v !== '')
      out[k] = v;
  };
  if (p.kind === null) {
    fill('note', p.note);
    return { tags: out, deskCode };
  }
  fill('kind', p.kind);
  if (p.kind === 'pending_doc') {
    fill('caseRef', p.caseRef);
    fill('docKey', docKeyOf(p.docWord));
  } else if (p.kind === 'info') {
    fill('caseRef', p.caseRef);
    fill('note', p.note);
  } else {
    fill('companyName', p.company);
    fill('tradeLicence', p.licence);
    if (out.bankCode === null) deskCode = p.deskCode;
  }
  return { tags: out, deskCode };
}

/** Plain labels for the reasons an upload waits (queue_reason). */
export const QUEUE_REASON_KEYS = [
  'NO_KIND',
  'NO_CASE',
  'NO_CONTACT',
  'NO_FILE',
  'CASE_NOT_FOUND',
  'BANK_MISMATCH',
  'CASE_EXISTS_NAME_MISMATCH',
  // 289: a company or customer the uploader may not see
  'COMPANY_RESTRICTED',
] as const;
export type KnownQueueReason = (typeof QUEUE_REASON_KEYS)[number];

/** The i18n key of a queue reason; anything else (a refusal hint) is 'OTHER'. */
export function queueReasonKey(
  reason: string | null
): KnownQueueReason | 'OTHER' | null {
  if (reason === null) return null;
  return (QUEUE_REASON_KEYS as readonly string[]).includes(reason)
    ? (reason as KnownQueueReason)
    : 'OTHER';
}

/** Two company names the same, ignoring case and spacing (the SQL's rule). */
export function sameCompany(a: string | null, b: string | null): boolean {
  const n = (s: string | null) =>
    (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) !== '' && n(a) === n(b);
}

/** A fresh idempotency key for one upload attempt (reused on retry). */
export function newIdemKey(
  rand: () => string = () => crypto.randomUUID()
): string {
  return `up-${rand()}`;
}

/** An age such as "3h 2m", in the reader's language ("3 س 2 د" in Arabic). */
export function formatAge(seconds: number | null, locale = 'en'): string {
  if (seconds === null) return '—';
  const unit = (n: number, u: 'second' | 'minute' | 'hour' | 'day') =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: u,
      unitDisplay: 'narrow',
    }).format(n);
  if (seconds < 60) return unit(Math.max(0, Math.floor(seconds)), 'second');
  const m = Math.floor(seconds / 60);
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 48) return `${unit(h, 'hour')} ${unit(m % 60, 'minute')}`;
  return unit(Math.floor(h / 24), 'day');
}
