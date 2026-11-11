// ============================================================
// Settings → Profile: "My WhatsApp" (migration 190).
//
// Which face the card shows, decided from `GET /api/whatsapp/personal`.
// Pure, so the card only renders it.
// ============================================================

export interface PersonalNumber {
  id: string;
  label: string | null;
  status: string;
  phone: string | null;
  connected_at: string | null;
  created_at: string;
}

export interface PersonalNumberInfo {
  allowed: boolean;
  configured: boolean;
  number: PersonalNumber | null;
}

export type MyWhatsAppView =
  | { kind: 'hidden' }
  | { kind: 'notConfigured' }
  | { kind: 'connect' }
  | { kind: 'connected'; number: PersonalNumber };

/**
 * `info` is null when the read failed or was refused (a bank guest's
 * 403): the card stays hidden rather than offer something that cannot
 * work. A number is always shown, even after the admin withdrew the
 * permission, so its owner can still disconnect it.
 */
export function myWhatsAppView(
  info: PersonalNumberInfo | null
): MyWhatsAppView {
  if (!info) return { kind: 'hidden' };
  if (info.number) return { kind: 'connected', number: info.number };
  if (!info.allowed) return { kind: 'hidden' };
  if (!info.configured) return { kind: 'notConfigured' };
  return { kind: 'connect' };
}

/** Reads the route's body defensively; null on any other shape. */
export function parsePersonalNumberInfo(
  body: unknown
): PersonalNumberInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.allowed !== 'boolean' || typeof b.configured !== 'boolean') {
    return null;
  }
  const n = b.number as Record<string, unknown> | null | undefined;
  const number =
    n && typeof n === 'object' && typeof n.id === 'string'
      ? {
          id: n.id,
          label: typeof n.label === 'string' ? n.label : null,
          status: typeof n.status === 'string' ? n.status : 'disconnected',
          phone: typeof n.phone === 'string' ? n.phone : null,
          connected_at:
            typeof n.connected_at === 'string' ? n.connected_at : null,
          created_at: typeof n.created_at === 'string' ? n.created_at : '',
        }
      : null;
  return { allowed: b.allowed, configured: b.configured, number };
}
