import { phonesMatch } from '@/lib/contacts/phone-match';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

/**
 * Only digits, phone punctuation and invisible direction marks: a
 * gateway's stand-in for a display name.
 */
const PHONE_TEXT = /^[\p{Nd}\p{Cf}\s+()\-./‐-―−]+$/u;

function isPhoneNumberText(text: string): boolean {
  return PHONE_TEXT.test(text) && (text.match(/\p{Nd}/gu)?.length ?? 0) >= 7;
}

/**
 * Whether an inbound message's sender name may replace the stored one.
 * Staff rename contacts ("Ahmed - ABC Trading LLC") and imports and
 * Compass bring names of their own, so only an empty name or the
 * contact's own bare number gives way, and never to a phone number.
 */
export function shouldRenameContact(
  contact: { name?: string | null; phone?: string | null },
  senderPhone: string,
  newName: string
): boolean {
  if (!newName.trim() || isPhoneNumberText(newName)) return false;
  const stored = (contact.name ?? '').trim();
  if (!stored) return true;
  if (!isPhoneNumberText(stored) || !normalizePhone(stored)) return false;
  return (
    phonesMatch(stored, contact.phone ?? '') || phonesMatch(stored, senderPhone)
  );
}
