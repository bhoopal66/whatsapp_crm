/**
 * Lead source (migration 249): where a contact came from.
 *
 * `contacts.lead_source` is one of LEAD_SOURCES or NULL (unknown);
 * `contacts.lead_source_detail` is a small object saying which ad, page
 * or file. People and imports set it at insert; automatic writers (the
 * Meta ad referral here, the public web form in SQL) fill it only while
 * it is empty, through `contact_set_lead_source_if_empty`, so the first
 * known source wins and a person's correction is never overwritten.
 *
 * Dependency-free apart from types: `src/types` and client components
 * import the list.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { InboundReferral } from '@/lib/whatsapp/inbound';

/** Pinned to 249's `contacts_lead_source_check` by lead-source.test.ts. */
export const LEAD_SOURCES = [
  'ad',
  'web_form',
  'broadcast',
  'manual',
  'import',
  'compass',
  'other',
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export function isLeadSource(value: unknown): value is LeadSource {
  return (
    typeof value === 'string' &&
    (LEAD_SOURCES as readonly string[]).includes(value)
  );
}

/** Longest string kept from a referral field; the detail column caps at 4 KB. */
const FIELD_MAX = 300;
const URL_MAX = 500;

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters out, whitespace collapsed: a headline is shown
  // on one line.
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** The neutral shape stored in `lead_source_detail` for an ad click. */
export interface AdReferralDetail {
  via: 'whatsapp_referral';
  source_type: string;
  source_id?: string;
  headline?: string;
  source_url?: string;
  ctwa_clid?: string;
}

export interface LeadSourceCapture {
  source: LeadSource;
  detail: Record<string, unknown>;
}

/**
 * What a Meta `messages[].referral` says about where the contact came
 * from, or null when it says nothing usable. A Click-to-WhatsApp ad is
 * 'ad'; a post or any other referral type is 'other' (still with its
 * detail). Strings are trimmed and capped. Never throws.
 */
export function referralLeadSource(
  referral: InboundReferral | undefined | null
): LeadSourceCapture | null {
  try {
    if (!referral || typeof referral !== 'object') return null;
    const sourceType = clip(referral.sourceType, 40)?.toLowerCase();
    if (!sourceType) return null;
    const detail: AdReferralDetail = {
      via: 'whatsapp_referral',
      source_type: sourceType,
    };
    const sourceId = clip(referral.sourceId, 100);
    const headline = clip(referral.headline, FIELD_MAX);
    const url = clip(referral.sourceUrl, URL_MAX);
    const clid = clip(referral.ctwaClid, FIELD_MAX);
    if (sourceId) detail.source_id = sourceId;
    if (headline) detail.headline = headline;
    if (url && /^https?:\/\//i.test(url)) detail.source_url = url;
    if (clid) detail.ctwa_clid = clid;
    return {
      source: sourceType === 'ad' ? 'ad' : 'other',
      detail: detail as unknown as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/**
 * The capture decision for one inbound message: only the contact's
 * first inbound in its company chat, never a personal number's chat,
 * and only a message that carries a referral. Whether the source is
 * still empty is the database's call (the setter writes only then).
 */
export function adLeadSourceToCapture(input: {
  referral: InboundReferral | undefined | null;
  isFirstInbound: boolean;
  isPersonal: boolean;
}): LeadSourceCapture | null {
  if (!input.isFirstInbound || input.isPersonal) return null;
  return referralLeadSource(input.referral);
}

/**
 * Fill an empty `lead_source` through the 249 setter (service-role
 * client). True when it wrote. Best-effort by contract: logs and
 * answers false on any failure, never throws, because it runs inside
 * the inbound pipeline's after().
 */
export async function setLeadSourceIfEmpty(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    capture: LeadSourceCapture;
  }
): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('contact_set_lead_source_if_empty', {
      p_account: args.accountId,
      p_contact: args.contactId,
      p_source: args.capture.source,
      p_detail: args.capture.detail,
    });
    if (error) {
      console.warn('[lead-source] could not record the source:', error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.warn('[lead-source] could not record the source:', String(err));
    return false;
  }
}
