// "Message from my WhatsApp" on the contact screens (migration 191): the
// viewer's own personal number sends into their personal chat with the
// contact. These are the pure decisions; the component only wires them.

/** The part of GET /api/whatsapp/personal the screen reads. */
export interface PersonalNumberInfo {
  allowed?: boolean;
  number?: { status?: string | null } | null;
}

/** Offer the action only to someone allowed a personal number that is
 *  connected right now. */
export function showPersonalOption(
  info: PersonalNumberInfo | null | undefined
): boolean {
  return !!info?.allowed && info.number?.status === 'connected';
}

/** The message key for a failed personal send: the route's
 *  `no_personal_number` 409 has its own wording; null means show the
 *  route's own error. */
export function personalSendFailureKey(
  status: number,
  payload: unknown
): 'noPersonalNumber' | null {
  const code = (payload as { code?: unknown } | null)?.code;
  return status === 409 && code === 'no_personal_number'
    ? 'noPersonalNumber'
    : null;
}
