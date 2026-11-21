/**
 * HR automated messages: the number a non-WhatsApp sender (RCS, SMS)
 * sends to. Shared so both refuse the same things before any call:
 *
 * - the conversation must be in the request's account and belong to the
 *   request's contact (else 'conversation_missing');
 * - never a personal chat (migration 191, 'personal_number');
 * - the contact's phone, loaded inside the account and normalised like
 *   the WhatsApp sender's, must be valid E.164 (else 'invalid_number').
 *
 * Each sender passes its own error factory so its failures keep its own
 * class (`RcsSendError`, `DinstarSendError`). Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import type { TemplateSendRequest } from './ports';

export type RecipientRefusal =
  'conversation_missing' | 'personal_number' | 'invalid_number';

/** The contact's E.164 number, without '+'. */
export async function recipientNumber(
  db: SupabaseClient,
  req: TemplateSendRequest,
  refuse: (reason: RecipientRefusal) => Error
): Promise<string> {
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, account_id, contact_id, personal_owner_id')
    .eq('id', req.conversationId)
    .eq('account_id', req.accountId)
    .maybeSingle();
  if (convErr || !conv) throw refuse('conversation_missing');
  if (conv.personal_owner_id) throw refuse('personal_number');
  if (conv.contact_id !== req.contactId) throw refuse('conversation_missing');

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', req.contactId)
    .eq('account_id', req.accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone)
    throw new Error('contact not found for this account');
  const to = sanitizePhoneForMeta(String(contact.phone));
  if (!isValidE164(to)) throw refuse('invalid_number');
  return to;
}
