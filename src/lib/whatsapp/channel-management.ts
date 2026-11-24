// ============================================================
// Settings → Numbers: the pure rules behind naming a WhatsApp number
// and deciding who works it (migration 060).
//
// Kept out of the route so they can be unit-tested without a request,
// and so the route reads as "validate, then write".
// ============================================================

import type { WhatsAppProvider } from '@/lib/whatsapp/channels';

export const MAX_CHANNEL_LABEL_LEN = 60;

/**
 * Browser-safe mirror of `isLinkedDeviceProvider` (channels.ts): Whapi
 * and OpenWA, a number paired to a phone rather than the Cloud API.
 * Client components cannot import channels.ts, which loads encryption.ts
 * (it reads ENCRYPTION_KEY at module load). Takes a plain string because
 * the browser's number rows are typed loosely; channel-management.test.ts
 * keeps the two in step.
 */
export function isLinkedDeviceNumber(provider: string): boolean {
  return provider === 'whapi' || provider === 'openwa';
}

const PROVIDER_LABELS: Record<WhatsAppProvider, string> = {
  whapi: 'Whapi',
  meta: 'Cloud API',
  openwa: 'OpenWA',
};

/**
 * The provider's name as `describeChannel` (channels.ts) prints it,
 * for the browser. An unknown value reads as itself rather than as
 * another provider's name.
 */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as WhatsAppProvider] ?? provider;
}

export type LabelResult =
  { ok: true; label: string } | { ok: false; error: string };

/** A number's operator-facing name: trimmed, non-empty, bounded. */
export function normalizeChannelLabel(raw: unknown): LabelResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'label must be a string' };
  }
  const label = raw.trim().replace(/\s+/g, ' ');
  if (!label) return { ok: false, error: 'A name is required' };
  if (label.length > MAX_CHANNEL_LABEL_LEN) {
    return {
      ok: false,
      error: `Name must be ${MAX_CHANNEL_LABEL_LEN} characters or fewer`,
    };
  }
  return { ok: true, label };
}

export type MemberIdsResult =
  { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * The allocation list for a number, validated against the account's
 * actual members. Replaced wholesale, like team membership — the UI
 * edits it as one checkbox list. An empty list is valid: it makes the
 * number shared again.
 */
export function validateMemberIds(
  raw: unknown,
  accountMemberIds: ReadonlySet<string>
): MemberIdsResult {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'member_ids must be an array of user ids' };
  }
  const ids = [...new Set(raw as string[])];
  const stranger = ids.find((id) => !accountMemberIds.has(id));
  if (stranger) {
    return {
      ok: false,
      error: `User ${stranger} is not a member of this account`,
    };
  }
  return { ok: true, ids };
}

export type IdListResult =
  { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * A replace-wholesale id list from a request body (`team_ids`,
 * `channel_ids`): an array of strings, deduplicated. Whether each id
 * belongs to the account is the database's call (the RPCs raise 22023);
 * this only rejects a body that is not a list at all, before anything
 * is written.
 */
export function validateIdList(raw: unknown, field: string): IdListResult {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    return { ok: false, error: `${field} must be an array of ids` };
  }
  return { ok: true, ids: [...new Set(raw as string[])] };
}

/** Browser-facing name for a number; mirrors `describeChannel` minus the provider suffix. */
export function channelDisplayName(c: {
  label: string | null;
  waba_id: string | null;
  phone_number_id: string;
}): string {
  return c.label || c.waba_id || c.phone_number_id;
}

/**
 * The name plus the phone it sends from — `Support · +971500005678` —
 * so a picker shows which handset a reply really leaves on. Linked
 * devices only (Whapi, OpenWA): their `waba_id` is the paired number
 * (migrations 040 and 144), while a Meta row's is the WABA id, not a
 * phone. A name that
 * already is the number is not repeated.
 */
export function channelNameWithPhone(c: {
  provider: string;
  label: string | null;
  waba_id: string | null;
  phone_number_id: string;
}): string {
  const name = channelDisplayName(c);
  const digits = isLinkedDeviceNumber(c.provider)
    ? (c.waba_id ?? '').replace(/\D/g, '')
    : '';
  if (!digits || name.replace(/\D/g, '') === digits) return name;
  return `${name} · +${digits}`;
}

/**
 * The numbers `userId` may send from — what the thread's number picker
 * offers (migration 061). Mirrors the SQL `can_use_channel`: an admin
 * may use every number; anyone else the numbers they are allocated to,
 * plus shared numbers (nobody allocated and never limited: 314's
 * `access_restricted`). The database enforces it;
 * this only decides what to show.
 *
 * A personal number (190) has no allocation rows but is NOT shared: it
 * is usable by an admin or its owner. A team leader of the owner may
 * use it too, but the client cannot tell who leads whom, so the picker
 * does not offer it to them; the database decides if they try.
 */
export function usableNumbers<
  T extends {
    id: string;
    is_personal?: boolean;
    user_id?: string | null;
    access_restricted?: boolean;
  },
>(
  numbers: readonly T[],
  allocations: ReadonlyArray<{ config_id: string; user_id: string }>,
  userId: string | null,
  isAdmin: boolean
): T[] {
  if (isAdmin) return [...numbers];
  if (!userId) return [];
  return numbers.filter((n) => {
    if (n.is_personal) return n.user_id === userId;
    const onIt = allocations.filter((a) => a.config_id === n.id);
    if (onIt.length === 0) return !n.access_restricted;
    return onIt.some((a) => a.user_id === userId);
  });
}
