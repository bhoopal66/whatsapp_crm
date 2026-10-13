/**
 * Deal rooms — the create form's rules (module 014c), pure so they are
 * tested without a DOM. They mirror what `deal_room_create` (migration
 * 088) refuses, so the form can say so before the round trip; the
 * function stays the judge.
 */

import { ROOM_MEMBER_MAX } from './view';

/** People who can be invited: the group's 8 less our own number. */
export const INVITEE_MAX = ROOM_MEMBER_MAX - 1;

/** `deal_rooms.subject`: 1 to 128 characters (code points). */
export const GROUP_NAME_MAX = 128;

/** `deal_room_participants.display_name`: 1 to 120 characters. */
export const INVITEE_NAME_MAX = 120;

/** Stored with the consent: which wording the customer agreed to. */
export const CONSENT_TEXT_VERSION = 'deal-room-group-v1';

export const CONSENT_METHODS = [
  'verbal',
  'whatsapp',
  'written',
  'form',
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export type InviteeRole = 'customer' | 'partner' | 'bank_guest';

export interface Invitee {
  displayName: string;
  phone: string;
  role: InviteeRole;
  contactId?: string | null;
  bankCode?: string | null;
}

const length = (s: string) => Array.from(s).length;

/** Digits only; Arabic-Indic and Persian digits read as 0–9. */
export function phoneDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

export type InviteeIssue =
  | { kind: 'none' }
  | { kind: 'too_many'; max: number }
  | { kind: 'no_customer' }
  | { kind: 'name'; name: string }
  | { kind: 'phone'; name: string }
  | { kind: 'duplicate'; name: string }
  | { kind: 'bank'; name: string };

/**
 * What stops this list from being invited, in the function's order:
 * 1 to 7 people, each with a name and a 6–15 digit phone, no phone
 * twice, a bank guest only from a bank whose policy allows guests, and
 * at least one customer. Empty means the list is fine.
 */
export function inviteeIssues(
  invitees: readonly Invitee[],
  allowedBanks: ReadonlySet<string>
): InviteeIssue[] {
  if (invitees.length === 0) return [{ kind: 'none' }];
  const issues: InviteeIssue[] = [];
  if (invitees.length > INVITEE_MAX) {
    issues.push({ kind: 'too_many', max: INVITEE_MAX });
  }
  const seen = new Set<string>();
  for (const p of invitees) {
    const name = p.displayName.trim();
    if (!name || length(name) > INVITEE_NAME_MAX) {
      issues.push({ kind: 'name', name });
    }
    const phone = phoneDigits(p.phone);
    if (!/^[0-9]{6,15}$/.test(phone)) {
      issues.push({ kind: 'phone', name });
    } else if (seen.has(phone)) {
      issues.push({ kind: 'duplicate', name });
    }
    seen.add(phone);
    if (p.role === 'bank_guest') {
      const bank = p.bankCode?.trim().toUpperCase();
      if (!bank || !allowedBanks.has(bank)) issues.push({ kind: 'bank', name });
    }
  }
  if (!invitees.some((p) => p.role === 'customer')) {
    issues.push({ kind: 'no_customer' });
  }
  return issues;
}

/** Room for one more person on the list. */
export const canAddInvitee = (count: number) => count < INVITEE_MAX;

/** The banks whose policy lets their officers be invited as guests. */
export function allowedGuestBanks(
  policies: readonly { bank_code: string; guests_allowed: boolean }[]
): Set<string> {
  return new Set(
    policies.filter((p) => p.guests_allowed).map((p) => p.bank_code)
  );
}

/** Cut to `max` code points, so an emoji is never split. */
export function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/** "<customer> × <workspace> — <deal>", at most 128 characters. */
export function defaultGroupName(parts: {
  customer: string;
  workspace: string;
  deal?: string | null;
}): string {
  const head = [parts.customer.trim(), parts.workspace.trim()]
    .filter(Boolean)
    .join(' × ');
  const deal = parts.deal?.trim();
  return clip(deal ? `${head} — ${deal}` : head, GROUP_NAME_MAX);
}

/** The group name the function will accept: 1 to 128 characters. */
export function groupNameOk(name: string): boolean {
  const n = length(name.trim());
  return n >= 1 && n <= GROUP_NAME_MAX;
}

/** Places taken in the group: the invitees plus our own number. */
export const placesTaken = (inviteeCount: number) => inviteeCount + 1;

/** "<company> · <deal>": how a customer's deal is offered in the picker. */
export function dealOptionLabel(o: {
  contactName: string | null;
  company: string | null;
  dealTitle: string | null;
}): string {
  return [o.company?.trim() || o.contactName?.trim(), o.dealTitle?.trim()]
    .filter(Boolean)
    .join(' · ');
}

interface PickedContact {
  id: string;
  name: string | null;
  phone: string | null;
}

/** A picked contact as the list's customer invitee. */
export function customerInvitee(c: PickedContact): Invitee {
  return {
    displayName: c.name ?? c.phone ?? '',
    phone: c.phone ?? '',
    role: 'customer',
    contactId: c.id,
  };
}

/**
 * Picking a customer puts them first and drops the previously picked
 * one; a customer typed in by hand (no contact) stays.
 */
export function withCustomer(
  list: readonly Invitee[],
  c: PickedContact
): Invitee[] {
  return [
    customerInvitee(c),
    ...list.filter((p) => p.role !== 'customer' || !p.contactId),
  ];
}

/**
 * The deals the picker offers: the contact's open deals, with a
 * prefilled deal that is not among them (a won deal opened from the
 * pipeline) first, so the select shows the deal the room will link.
 */
export function dealChoices<D extends { id: string }>(
  open: readonly D[],
  keep: D | null
): D[] {
  if (!keep || open.some((d) => d.id === keep.id)) return [...open];
  return [keep, ...open];
}

/**
 * The dialog's first state. Opened from a customer or a deal, the
 * contact is picked (and searched for, so the list shows it), the
 * customer is on the list and the deal is chosen; from team chat,
 * nothing is.
 */
export function initialCreateState<C extends PickedContact>(seed: {
  contact?: C | null;
  deal?: { id: string } | null;
}): { query: string; contact: C | null; dealId: string; invitees: Invitee[] } {
  const contact = seed.contact ?? null;
  if (!contact) return { query: '', contact: null, dealId: '', invitees: [] };
  return {
    query: contact.name ?? contact.phone ?? '',
    contact,
    dealId: seed.deal?.id ?? '',
    invitees: [customerInvitee(contact)],
  };
}

/** The `POST /api/deal-rooms` body. */
export function createRoomBody(input: {
  contactId: string;
  dealId: string | null;
  subject: string;
  invitees: readonly Invitee[];
  consentText: string;
  method: ConsentMethod;
}) {
  return {
    contactId: input.contactId,
    dealId: input.dealId,
    subject: input.subject.trim(),
    participants: input.invitees.map((p) => ({
      displayName: p.displayName.trim(),
      phone: phoneDigits(p.phone),
      role: p.role,
      contactId: p.contactId ?? null,
      bankCode:
        p.role === 'bank_guest'
          ? (p.bankCode?.trim().toUpperCase() ?? null)
          : null,
    })),
    consent: {
      textVersion: CONSENT_TEXT_VERSION,
      consentText: input.consentText,
      method: input.method,
    },
  };
}

/** What the form does with the `POST /api/deal-rooms` answer. */
export interface CreateOutcome {
  /** The room to open. Whenever it is set the form closes, which resets it. */
  roomId: string | null;
  /** What went wrong, for the toast; null once the room is created. */
  error: string | null;
}

/**
 * An answer that names a room closes the form, failure included: a room
 * Meta refused (502 with its id, marked failed) still has its row,
 * channel and consent. A form left filled in after that made the next
 * click create a second room for the same customer under the same
 * subject, which the reconcile's subject match cannot tell apart. Only
 * an answer with no room keeps the form for another try.
 */
export function createOutcome(
  res: { ok: boolean; status: number },
  body: unknown
): CreateOutcome {
  const b = (body ?? {}) as { roomId?: unknown; error?: unknown };
  const roomId = typeof b.roomId === 'string' && b.roomId ? b.roomId : null;
  if (res.ok && roomId) return { roomId, error: null };
  const error =
    typeof b.error === 'string' && b.error ? b.error : String(res.status);
  return { roomId, error };
}
