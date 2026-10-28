// ============================================================
// What the pipelines board loads per deal.
//
// The board used to embed `contact:contacts(*)` and
// `assignee:profiles!deals_assigned_to_fkey(*)` for every deal of the
// pipeline, so each card carried a whole contact row and a whole
// profile row it never read. The board, the cards, the card menu and
// the deal form it opens read only the fields below; the column lists
// and the types are built from the same arrays, so a consumer that
// starts reading another field fails the typecheck until it is added
// here (and therefore to the select).
// ============================================================

import type { Contact, Deal, Profile } from '@/types';

/**
 * Contact fields: the card's label and initials (name, phone), the
 * "Open customer" item (id), the form's contact picker (id, name,
 * phone) and the deal-room prefill (name, phone, company).
 */
export const DEAL_CARD_CONTACT_FIELDS = [
  'id',
  'name',
  'phone',
  'company',
] as const satisfies readonly (keyof Contact)[];

/** Assignee fields: the card's owner label falls back to these. */
export const DEAL_CARD_ASSIGNEE_FIELDS = [
  'id',
  'full_name',
  'email',
] as const satisfies readonly (keyof Profile)[];

export type DealCardContact = Pick<
  Contact,
  (typeof DEAL_CARD_CONTACT_FIELDS)[number]
>;
export type DealCardAssignee = Pick<
  Profile,
  (typeof DEAL_CARD_ASSIGNEE_FIELDS)[number]
>;

/** A deal as the board loads it: every deal column, narrowed embeds. */
export type BoardDeal = Omit<Deal, 'contact' | 'assignee'> & {
  contact?: DealCardContact;
  assignee?: DealCardAssignee;
};

/**
 * The `select` for the board's deals query. `deals.*` stays whole.
 * A literal, not built from the arrays above, because supabase-js
 * parses a literal select and gives up on a plain `string`;
 * `board-deal.test.ts` checks it names exactly those fields.
 */
export const BOARD_DEAL_SELECT =
  '*, contact:contacts(id, name, phone, company), assignee:profiles!deals_assigned_to_fkey(id, full_name, email)';
