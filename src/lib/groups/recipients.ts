// Who a group action reaches: CRM contacts (read through the caller's
// RLS, so an invisible contact is `notFound`) and raw phones, each
// screened against the consent register (do-not-contact, opted out).
// A phone that belongs to a refusing contact of the account is skipped
// too, whoever can see that contact: opt-out is honoured everywhere.

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  consentRefusal,
  type ConsentRefusal,
} from '@/lib/whatsapp/send-origin';
import { toParticipantWaId } from '@/lib/whatsapp/groups';
import { phoneVariants } from '@/lib/whatsapp/phone-utils';

import type { RecipientInput } from './member-requests';
import { GroupHttpError } from './server';

export interface Recipient {
  waId: string;
  contactId: string | null;
}

export interface ScreenedRecipients {
  recipients: Recipient[];
  skipped: Array<{
    waId: string;
    contactId: string | null;
    reason: ConsentRefusal;
  }>;
  /** Inputs (phones, or contact ids with no usable number) not a WhatsApp number. */
  invalid: string[];
  /** Contact ids the caller cannot see. */
  notFound: string[];
}

type ConsentRow = {
  id: string;
  phone?: string | null;
  phone_normalized?: string | null;
  opted_out_at: string | null;
  do_not_contact_at: string | null;
};

export async function screenRecipients(
  caller: { supabase: SupabaseClient; accountId: string },
  admin: SupabaseClient,
  input: RecipientInput
): Promise<ScreenedRecipients> {
  const out: ScreenedRecipients = {
    recipients: [],
    skipped: [],
    invalid: [],
    notFound: [],
  };
  const seen = new Set<string>();

  if (input.contactIds.length > 0) {
    const { data, error } = await caller.supabase
      .from('contacts')
      .select('id, phone, opted_out_at, do_not_contact_at')
      .eq('account_id', caller.accountId)
      .in('id', input.contactIds);
    if (error) {
      console.error('[groups] contact read failed', error);
      throw new GroupHttpError(503, 'unavailable', 'Could not load contacts');
    }
    const byId = new Map(((data ?? []) as ConsentRow[]).map((c) => [c.id, c]));
    for (const id of input.contactIds) {
      const c = byId.get(id);
      if (!c) {
        out.notFound.push(id);
        continue;
      }
      const waId = toParticipantWaId(c.phone ?? '');
      if (!waId) {
        out.invalid.push(id);
        continue;
      }
      if (seen.has(waId)) continue;
      seen.add(waId);
      const reason = consentRefusal(c);
      if (reason) out.skipped.push({ waId, contactId: id, reason });
      else out.recipients.push({ waId, contactId: id });
    }
  }

  const phones: string[] = [];
  for (const input_ of input.phones) {
    const waId = toParticipantWaId(input_);
    if (!waId) out.invalid.push(input_);
    else if (!seen.has(waId)) {
      seen.add(waId);
      phones.push(waId);
    }
  }
  if (phones.length === 0) return out;

  // The register by number, across the whole account (service role).
  const variants = new Map(phones.map((p) => [p, phoneVariants(p)]));
  const { data, error } = await admin
    .from('contacts')
    .select('id, phone_normalized, opted_out_at, do_not_contact_at')
    .eq('account_id', caller.accountId)
    .in('phone_normalized', [...new Set([...variants.values()].flat())]);
  if (error) {
    // Fail closed: an unchecked number might be someone who opted out.
    console.error('[groups] consent lookup failed', error);
    throw new GroupHttpError(503, 'unavailable', 'Could not check consent');
  }
  const refusalOf = new Map<string, ConsentRefusal>();
  for (const c of (data ?? []) as ConsentRow[]) {
    const reason = consentRefusal(c);
    if (reason && c.phone_normalized) refusalOf.set(c.phone_normalized, reason);
  }
  for (const [waId, vs] of variants) {
    const hit = vs.find((v) => refusalOf.has(v));
    if (hit) {
      out.skipped.push({ waId, contactId: null, reason: refusalOf.get(hit)! });
    } else {
      out.recipients.push({ waId, contactId: null });
    }
  }
  return out;
}
